/**
 * AEGIS Live News Feed — 5-minute strict rate limit
 * One event every 5 minutes maximum. No flooding. No duplicates.
 */

import { parseStringPromise } from 'xml2js';
import { eventQueue } from './eventQueue.js';
import { logger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

const POLL_INTERVAL_MS     = 300_000;  // 5 minutes between polls
const MIN_INJECT_GAP_MS    = 300_000;  // 5 minutes minimum between ANY injection
const TYPE_ZONE_COOLDOWN   = 600_000;  // 10 minutes before same type+zone can repeat

const NEWS_URL = 'https://news.google.com/rss/search?q=Delhi+fire+OR+accident+OR+collapse+OR+flood+OR+explosion&hl=en-IN&gl=IN&ceid=IN:en';

const _seenGuids     = new Set();
const _seenTitleKeys = new Set();
const _typeZoneTime  = new Map();

let _lastInjectionAt = 0;  // global last injection time
let _pollCount       = 0;
let _liveCount       = 0;
let _fallbackCount   = 0;
let _nextPollAt      = 0;

const ZONE_KEYWORDS = {
  CP:  ['connaught place', 'central delhi', 'rajiv chowk', 'paharganj'],
  RP:  ['rajpath', 'india gate', 'parliament', 'lutyens'],
  KB:  ['karol bagh', 'west delhi', 'patel nagar'],
  LN:  ['lajpat nagar', 'south delhi', 'south extension', 'andheria', 'nature bazaar', 'malviya', 'saket'],
  DW:  ['dwarka', 'uttam nagar', 'janakpuri'],
  RH:  ['rohini', 'pitampura', 'north delhi', 'model town'],
  SD:  ['shahdara', 'east delhi', 'vivek vihar'],
  NP:  ['nehru place', 'kalkaji', 'jasola'],
  IGI: ['airport', 'igi', 'aerocity', 'mahipalpur'],
  OKH: ['okhla', 'industrial area', 'tughlakabad'],
};

const TYPE_RULES = [
  { kw:['fire','blaze','engulfs','gutted','flames'],      type:'structural_fire',        priority:8 },
  { kw:['collapse','caved','building fell'],              type:'building_collapse',      priority:9 },
  { kw:['flood','waterlog','inundated'],                  type:'infrastructure_failure', priority:7 },
  { kw:['accident','collision','crash','overturned'],     type:'vehicle_accident',       priority:6 },
  { kw:['explosion','blast','explode'],                   type:'structural_fire',        priority:9 },
  { kw:['stampede','crowd crush'],                        type:'mass_casualty',          priority:8 },
  { kw:['power cut','blackout','outage'],                 type:'power_outage',           priority:6 },
  { kw:['gas leak','chemical leak','hazmat'],             type:'hazmat',                 priority:8 },
];

const FALLBACK_EVENTS = [
  { type:'structural_fire',        zone:'KB', priority:8, description:'[SIMULATION] Fire at multi-storey building in Karol Bagh. Ground floor ablaze. Evacuation in progress.' },
  { type:'vehicle_accident',       zone:'CP', priority:6, description:'[SIMULATION] Multi-vehicle crash near Connaught Place underpass. 3 persons trapped.' },
  { type:'mass_casualty',          zone:'RP', priority:7, description:'[SIMULATION] Stampede near India Gate during public event. 20+ injured. Police and EMS needed.' },
  { type:'structural_fire',        zone:'OKH',priority:8, description:'[SIMULATION] Fire at chemical unit in Okhla Industrial Area. Hazmat protocol activated.' },
  { type:'infrastructure_failure', zone:'SD', priority:7, description:'[SIMULATION] Road collapse in Shahdara after heavy rain. Main artery blocked.' },
  { type:'power_outage',           zone:'RH', priority:6, description:'[SIMULATION] Power grid failure in Rohini. 3 hospitals on backup generator.' },
  { type:'structural_fire',        zone:'LN', priority:7, description:'[SIMULATION] Fire in Lajpat Nagar market complex. Multiple shops affected.' },
  { type:'vehicle_accident',       zone:'DW', priority:5, description:'[SIMULATION] Bus overturned on Dwarka Expressway. Multiple passengers injured.' },
];

let _fallbackIdx = 0;

// ─── Public API ───────────────────────────────────────────────────────────────

export async function startLiveNewsFeed() {
  logger.success('📡 Live news feed — 5 min rate limit, 1 event max per poll');
  // First poll after 30 seconds (let system stabilise)
  _nextPollAt = Date.now() + 30_000;
  setTimeout(pollAndInject, 30_000);
  setInterval(pollAndInject, POLL_INTERVAL_MS);
}

export function getNewsFeedStats() {
  return {
    polls: _pollCount,
    liveEvents: _liveCount,
    fallbacks: _fallbackCount,
    seenTitles: _seenTitleKeys.size,
    nextPollIn: `${Math.max(0, Math.ceil((_nextPollAt - Date.now()) / 1000))}s`,
  };
}

// ─── Poll ─────────────────────────────────────────────────────────────────────

async function pollAndInject() {
  _nextPollAt = Date.now() + POLL_INTERVAL_MS;
  _pollCount++;
  logger.info(`📡 Poll #${_pollCount}`);

  // Hard rate limit — never inject more than once per 5 minutes globally
  const timeSinceLast = Date.now() - _lastInjectionAt;
  if (timeSinceLast < MIN_INJECT_GAP_MS) {
    const waitSec = Math.round((MIN_INJECT_GAP_MS - timeSinceLast) / 1000);
    logger.info(`📡 Rate limited — ${waitSec}s until next injection allowed`);
    return;
  }

  // Don't inject if coordinator is still processing something
  if (eventQueue.size > 0) {
    logger.info(`📡 Queue has ${eventQueue.size} pending items — skipping injection`);
    return;
  }

  try {
    const articles = await fetchDelhiNews();
    const fresh    = articles.filter(a => isNew(a));

    if (fresh.length === 0) {
      logger.info('📡 No new articles — trying fallback');
      injectFallback();
      return;
    }

    // Try articles until one is classifiable
    for (const article of fresh) {
      markSeen(article);
      const event = classify(article);
      if (!event) continue;

      if (isTypeZoneCooldown(event)) {
        logger.info(`📡 Suppressed ${event.type}/${event.zone} (cooldown active)`);
        continue;
      }

      inject(event);
      logger.success(`📡 LIVE: [${event.type}] ${event.zone} P${event.priority}`);
      logger.info(`📡 Headline: "${article.title.slice(0, 70)}"`);
      return;
    }

    // All articles suppressed by cooldown
    logger.info('📡 All articles filtered by cooldown — trying fallback');
    injectFallback();

  } catch (err) {
    logger.warn(`📡 Fetch failed (${err.message}) — fallback`);
    injectFallback();
  }
}

// ─── RSS ──────────────────────────────────────────────────────────────────────

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
      guid:  i.guid?._ || i.guid || i.link || String(Math.random()),
      title: (i.title || '').replace(/<[^>]+>/g, '').trim(),
      link:  i.link || '',
    })).filter(a => a.title.length > 10);
  } finally { clearTimeout(timeout); }
}

// ─── Dedup ────────────────────────────────────────────────────────────────────

function titleKey(title) {
  return title.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 6)
    .join(' ');
}

function isNew(article) {
  if (_seenGuids.has(article.guid)) return false;
  const key = titleKey(article.title);
  if (_seenTitleKeys.has(key)) return false;
  return true;
}

function markSeen(article) {
  _seenGuids.add(article.guid);
  _seenTitleKeys.add(titleKey(article.title));
  if (_seenGuids.size > 200) {
    const arr = Array.from(_seenGuids); arr.slice(0, 50).forEach(x => _seenGuids.delete(x));
  }
}

function isTypeZoneCooldown(event) {
  const key  = `${event.type}:${event.zone}`;
  const last = _typeZoneTime.get(key);
  return last && (Date.now() - last) < TYPE_ZONE_COOLDOWN;
}

// ─── Classify ─────────────────────────────────────────────────────────────────

function classify(article) {
  const lower = article.title.toLowerCase();

  const hasDelhi     = lower.includes('delhi') || lower.includes('दिल्ली');
  const hasEmergency = TYPE_RULES.some(r => r.kw.some(w => lower.includes(w)));
  if (!hasDelhi || !hasEmergency) return null;

  let type = 'general_incident', priority = 5;
  for (const rule of TYPE_RULES) {
    if (rule.kw.some(w => lower.includes(w))) { type = rule.type; priority = rule.priority; break; }
  }

  let zone = 'CP';
  for (const [z, kws] of Object.entries(ZONE_KEYWORDS)) {
    if (kws.some(kw => lower.includes(kw))) { zone = z; break; }
  }

  return {
    id:          `live-${uuidv4().slice(0, 8)}`,
    type, zone, priority,
    description: `[LIVE NEWS] ${article.title}`,
    _source:     'live_news',
    _headline:   article.title.slice(0, 100),
    _link:       article.link,
  };
}

// ─── Inject ───────────────────────────────────────────────────────────────────

function inject(event) {
  _lastInjectionAt = Date.now();
  _typeZoneTime.set(`${event.type}:${event.zone}`, Date.now());
  eventQueue.enqueue(event);
  if (event._source === 'live_news') _liveCount++;
  else _fallbackCount++;
}

function injectFallback() {
  const tmpl = FALLBACK_EVENTS[_fallbackIdx % FALLBACK_EVENTS.length];
  _fallbackIdx++;

  if (isTypeZoneCooldown(tmpl)) {
    logger.info('📡 Fallback also on cooldown — skipping entirely');
    return;
  }

  inject({ ...tmpl, id: `sim-${uuidv4().slice(0, 8)}`, _source: 'simulation_fallback' });
  logger.info(`📡 Simulation: [${tmpl.type}] ${tmpl.zone}`);
}
