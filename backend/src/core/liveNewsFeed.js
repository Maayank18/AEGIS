/**
 * AEGIS Live News Feed — Optimised
 * ─────────────────────────────────────────────────────────────────────────────
 * Polls Delhi emergency news every 3 minutes.
 * Deduplicates by: GUID + normalised title hash (catches same story from 5 sources).
 * Injects MAX 1 event per poll — prevents coordinator flood.
 * Skips Groq classification when keyword match is unambiguous (saves tokens).
 * Falls back to simulation pool when no real news is relevant.
 */

import { parseStringPromise } from 'xml2js';
import { eventQueue } from './eventQueue.js';
import { logger } from '../utils/logger.js';
import { groq, MODEL } from '../config.js';
import { v4 as uuidv4 } from 'uuid';

// ─── Configuration ────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS  = 180_000;   // 3 minutes — gives coordinator time to process
const FALLBACK_INTERVAL = 2;         // inject fallback every 2 polls with no real news
const MAX_EVENTS_PER_POLL = 1;       // HARD CAP: only 1 event per poll cycle
const TITLE_SIMILARITY_WORDS = 6;    // first N significant words for dedup hash

const NEWS_URL = 'https://news.google.com/rss/search?q=Delhi+fire+OR+accident+OR+collapse+OR+flood+OR+explosion&hl=en-IN&gl=IN&ceid=IN:en';

// Dedup stores
const _seenGuids     = new Set(); // by article GUID
const _seenTitleKeys = new Set(); // by normalised title hash — catches same story from multiple sources
const _recentTypeZone = new Map(); // type+zone → last injection time — prevents same-type repeat within 10min

let _pollCount           = 0;
let _liveEventsInjected  = 0;
let _fallbacksInjected   = 0;
let _groqCallsSaved      = 0;

// ─── Zone keyword map ─────────────────────────────────────────────────────────

const ZONE_KEYWORDS = {
  CP:  ['connaught place', 'central delhi', 'rajiv chowk', 'paharganj', 'new delhi station'],
  RP:  ['rajpath', 'india gate', 'vijay chowk', 'parliament', 'lutyens'],
  KB:  ['karol bagh', 'patel nagar', 'rajendra place', 'west delhi', 'naraina'],
  LN:  ['lajpat nagar', 'south delhi', 'south extension', 'greater kailash', 'malviya nagar', 'saket', 'andheria', 'nature bazaar'],
  DW:  ['dwarka', 'uttam nagar', 'janakpuri', 'vikaspuri', 'southwest delhi'],
  RH:  ['rohini', 'pitampura', 'shalimar bagh', 'ashok vihar', 'north delhi', 'model town'],
  SD:  ['shahdara', 'east delhi', 'vivek vihar', 'preet vihar', 'gandhi nagar', 'yamuna'],
  NP:  ['nehru place', 'kalkaji', 'southeast delhi', 'jasola'],
  IGI: ['airport', 'igi', 'indira gandhi', 'terminal', 'aerocity', 'mahipalpur'],
  OKH: ['okhla', 'industrial area', 'tughlakabad', 'badarpur'],
};

// Clear keyword → type mapping (no Groq needed for these)
const CLEAR_TYPE_KEYWORDS = [
  { kw: ['fire','blaze','engulfs','gutted'],          type:'structural_fire',        priority:8 },
  { kw: ['collapse','building collapsed','caved in'],  type:'building_collapse',      priority:9 },
  { kw: ['flood','waterlog','inundated'],              type:'infrastructure_failure', priority:7 },
  { kw: ['accident','collision','crash','overturned'], type:'vehicle_accident',       priority:6 },
  { kw: ['explosion','blast','explode'],               type:'structural_fire',        priority:9 },
  { kw: ['stampede','panic','crowd'],                  type:'mass_casualty',          priority:8 },
  { kw: ['power cut','blackout','outage'],             type:'power_outage',           priority:6 },
  { kw: ['gas leak','chemical','hazmat'],              type:'hazmat',                 priority:8 },
];

// ─── Fallback pool ────────────────────────────────────────────────────────────

const FALLBACK_EVENTS = [
  { type:'structural_fire',        zone:'KB', priority:8, description:'[SIMULATION] Fire at multi-storey commercial building in Karol Bagh. Ground floor ablaze. Evacuation underway.' },
  { type:'vehicle_accident',       zone:'CP', priority:6, description:'[SIMULATION] Multi-vehicle collision near Connaught Place underpass. 3 persons trapped. Traffic blocked.' },
  { type:'structural_fire',        zone:'LN', priority:7, description:'[SIMULATION] Fire in Lajpat Nagar market complex. Thick smoke reported. Fire brigade notified.' },
  { type:'medical_emergency',      zone:'RH', priority:6, description:'[SIMULATION] Mass food poisoning at community event in Rohini Sector 9. 15+ persons ill. Ambulances requested.' },
  { type:'infrastructure_failure', zone:'SD', priority:7, description:'[SIMULATION] Road collapse in Shahdara after heavy rain. Main artery blocked. Alternate routes needed.' },
  { type:'structural_fire',        zone:'OKH',priority:8, description:'[SIMULATION] Fire at chemical storage unit in Okhla Industrial Area. Hazmat protocol activated.' },
  { type:'vehicle_accident',       zone:'DW', priority:5, description:'[SIMULATION] Bus overturned on Dwarka Expressway. Multiple passengers injured. EMS en route.' },
  { type:'power_outage',           zone:'NP', priority:6, description:'[SIMULATION] Power transformer explosion in Nehru Place. 3 buildings dark. Fire risk contained.' },
  { type:'structural_fire',        zone:'RH', priority:9, description:'[SIMULATION] Large fire at garment factory in Rohini. Workers trapped. Wind spreading flames northwest.' },
  { type:'mass_casualty',          zone:'RP', priority:7, description:'[SIMULATION] Stampede near India Gate during public gathering. 20+ injured. Police and EMS requested.' },
];

let _fallbackIndex = 0;

// ─── Public API ───────────────────────────────────────────────────────────────

export async function startLiveNewsFeed() {
  logger.success('📡 Live news feed started — 3 min poll interval, max 1 event/poll');
  await pollAndInject();
  setInterval(pollAndInject, POLL_INTERVAL_MS);
}

export function getNewsFeedStats() {
  return {
    polls: _pollCount,
    liveEvents: _liveEventsInjected,
    fallbacks: _fallbacksInjected,
    groqCallsSaved: _groqCallsSaved,
    seenTitles: _seenTitleKeys.size,
  };
}

// ─── Poll cycle ───────────────────────────────────────────────────────────────

async function pollAndInject() {
  _pollCount++;
  logger.info(`📡 News poll #${_pollCount}...`);

  try {
    const articles = await fetchDelhiNews();
    const fresh    = articles.filter(a => isNewArticle(a));

    if (fresh.length === 0) {
      logger.info('📡 No new articles');
      maybeInjectFallback();
      return;
    }

    // Try each article until we successfully inject 1
    let injected = 0;
    for (const article of fresh) {
      if (injected >= MAX_EVENTS_PER_POLL) break;

      markSeen(article);
      const event = classifyArticle(article);

      if (!event) continue;
      if (isRecentDuplicate(event)) {
        logger.info(`📡 Suppressed duplicate type+zone: ${event.type} in ${event.zone}`);
        continue;
      }

      eventQueue.enqueue(event);
      markRecentTypeZone(event);
      _liveEventsInjected++;
      injected++;
      logger.success(`📡 LIVE event: [${event.type}] ${event.zone} P${event.priority} — "${article.title.slice(0, 60)}"`);
    }

    if (injected === 0) maybeInjectFallback();

  } catch (err) {
    logger.warn(`📡 Poll failed (${err.message}) — fallback`);
    maybeInjectFallback();
  }
}

// ─── RSS fetch ────────────────────────────────────────────────────────────────

async function fetchDelhiNews() {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(NEWS_URL, {
      signal:  controller.signal,
      headers: { 'User-Agent': 'AEGIS-EmergencySystem/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml    = await res.text();
    const parsed = await parseStringPromise(xml, { explicitArray: false });
    const items  = parsed?.rss?.channel?.item;
    if (!items) return [];
    return (Array.isArray(items) ? items : [items]).map(i => ({
      guid:    i.guid?._ || i.guid || i.link || String(Math.random()),
      title:   (i.title || '').replace(/<[^>]+>/g, '').trim(),
      link:    i.link || '',
    })).filter(a => a.title.length > 10);
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Deduplication ────────────────────────────────────────────────────────────

function normalisedKey(title) {
  // Take first 6 significant words — ignores source suffix differences
  return title.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !['from','with','that','this','have','been','were','will'].includes(w))
    .slice(0, TITLE_SIMILARITY_WORDS)
    .join(' ');
}

function isNewArticle(article) {
  if (_seenGuids.has(article.guid)) return false;
  const key = normalisedKey(article.title);
  if (_seenTitleKeys.has(key)) return false;
  return true;
}

function markSeen(article) {
  _seenGuids.add(article.guid);
  _seenTitleKeys.add(normalisedKey(article.title));
  // Bound memory
  if (_seenGuids.size > 300)     { const a = Array.from(_seenGuids);     a.slice(0,50).forEach(x=>_seenGuids.delete(x)); }
  if (_seenTitleKeys.size > 300) { const a = Array.from(_seenTitleKeys); a.slice(0,50).forEach(x=>_seenTitleKeys.delete(x)); }
}

// Prevent injecting same type+zone within 10 minutes
const TYPE_ZONE_COOLDOWN_MS = 10 * 60 * 1000;

function isRecentDuplicate(event) {
  const key  = `${event.type}:${event.zone}`;
  const last = _recentTypeZone.get(key);
  return last && (Date.now() - last) < TYPE_ZONE_COOLDOWN_MS;
}

function markRecentTypeZone(event) {
  _recentTypeZone.set(`${event.type}:${event.zone}`, Date.now());
}

// ─── Classification — keyword-first, Groq only for ambiguous ─────────────────

function classifyArticle(article) {
  const lower = article.title.toLowerCase();

  // Pre-filter: must mention Delhi and an emergency keyword
  const hasEmergency = CLEAR_TYPE_KEYWORDS.some(({ kw }) => kw.some(w => lower.includes(w)));
  const hasDelhi     = lower.includes('delhi') || lower.includes('दिल्ली');
  if (!hasDelhi || !hasEmergency) return null;

  // Keyword classification — no Groq call needed
  let type     = null;
  let priority = 5;
  for (const { kw, type: t, priority: p } of CLEAR_TYPE_KEYWORDS) {
    if (kw.some(w => lower.includes(w))) { type = t; priority = p; break; }
  }

  const zone = guessZone(lower);

  _groqCallsSaved++;
  logger.info(`📡 Classified without Groq (saved a call): ${type} in ${zone}`);

  return {
    id:          `live-${uuidv4().slice(0, 8)}`,
    type:        type || 'general_incident',
    zone,
    priority,
    description: `[LIVE NEWS] ${article.title}`,
    _source:     'live_news',
    _headline:   article.title.slice(0, 100),
    _link:       article.link,
  };
}

function guessZone(lower) {
  for (const [zone, kws] of Object.entries(ZONE_KEYWORDS)) {
    if (kws.some(kw => lower.includes(kw))) return zone;
  }
  return 'CP';
}

// ─── Fallback ─────────────────────────────────────────────────────────────────

function maybeInjectFallback() {
  if (_pollCount % FALLBACK_INTERVAL !== 0) return;

  const tmpl = FALLBACK_EVENTS[_fallbackIndex % FALLBACK_EVENTS.length];
  _fallbackIndex++;

  // Check cooldown for simulations too
  if (isRecentDuplicate(tmpl)) {
    logger.info('📡 Fallback suppressed by cooldown');
    return;
  }

  const event = { ...tmpl, id: `sim-${uuidv4().slice(0, 8)}`, _source: 'simulation_fallback' };
  markRecentTypeZone(event);
  eventQueue.enqueue(event);
  _fallbacksInjected++;
  logger.info(`📡 Simulation injected: [${event.type}] in ${event.zone}`);
}