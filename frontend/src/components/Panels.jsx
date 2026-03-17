/*
 * Why changed: keep map route rendering aligned with normalized backend route payloads and expose structured decision details in the audit panel.
 * Security rationale: operators now see public-safe rationale, persistence state, and route geometry without relying on fragile implicit data shapes.
 */
import { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline } from 'react-leaflet';
import L from 'leaflet';
import { useWorldStore, ZONE_META } from '../store/useWorldStore.js';

const COLORS = { cyan: '#00d4ff', green: '#00ff88', orange: '#ff6b35', red: '#ff3b5c', yellow: '#ffd700', purple: '#a855f7' };
const ZONE_NAMES = { CP: 'Connaught Place', RP: 'Rajpath', KB: 'Karol Bagh', LN: 'Lajpat Nagar', DW: 'Dwarka', RH: 'Rohini', SD: 'Shahdara', NP: 'Nehru Place', IGI: 'IGI Airport', OKH: 'Okhla' };

function Dot({ color = 'cyan', pulse }) {
  const resolved = COLORS[color] || color;
  return <div style={{ width: 7, height: 7, borderRadius: '50%', background: resolved, boxShadow: `0 0 6px ${resolved}`, flexShrink: 0, ...(pulse ? { animation: 'pulse 1.5s ease-in-out infinite' } : {}) }} />;
}

function PanelShell({ header, children, style }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--c-surface)', border: '1px solid var(--c-border)', borderRadius: '10px', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0 }}>
        {header}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {children}
      </div>
    </div>
  );
}

export function StatsBar() {
  const stats = useWorldStore(state => state.stats);
  const connected = useWorldStore(state => state.connected);
  const blockedEdges = useWorldStore(state => state.blockedEdges);
  const [time, setTime] = useState('');

  useEffect(() => {
    const update = () => setTime(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);

  const available = stats.availableUnits ?? 0;
  const total = stats.totalUnits ?? 16;
  const active = stats.activeIncidents ?? 0;
  const threats = stats.totalInjectionsCaught ?? 0;

  return (
    <div style={{ display: 'flex', alignItems: 'stretch', background: 'rgba(8,13,24,0.9)', borderBottom: '1px solid rgba(0,212,255,0.08)', flexShrink: 0, height: '42px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', padding: '0 16px', borderRight: '1px solid rgba(255,255,255,0.04)' }}>
        <Dot color={connected ? 'green' : 'red'} pulse />
        <span style={{ fontSize: '11px', fontWeight: '600', color: connected ? '#00ff88' : '#ff3b5c', letterSpacing: '0.06em' }}>
          {connected ? 'ONLINE' : 'RECONNECTING'}
        </span>
      </div>

      <Stat
        icon="🚔"
        main={`${available}/${total}`}
        sub={available === total ? 'all available' : `${total - available} deployed`}
        color={available < 4 ? 'red' : available < 8 ? 'orange' : 'green'}
      />

      <Stat
        icon="⚠️"
        main={active}
        sub={active === 0 ? 'no incidents' : 'active right now'}
        color={active > 0 ? 'orange' : 'green'}
        highlight={active > 0}
      />

      {blockedEdges.length > 0 && (
        <Stat
          icon="🚧"
          main={blockedEdges.length}
          sub="road(s) closed"
          color="orange"
          highlight
        />
      )}

      {threats > 0 && <Stat icon="🛡️" main={threats} sub="attack(s) blocked" color="purple" />}

      <div style={{ marginLeft: 'auto', padding: '0 14px', display: 'flex', alignItems: 'center' }}>
        <span style={{ fontSize: '11px', color: '#334155', fontVariantNumeric: 'tabular-nums' }}>{time} IST</span>
      </div>
    </div>
  );
}

function Stat({ icon, main, sub, color, highlight }) {
  const resolved = COLORS[color] || color;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '0 14px', borderRight: '1px solid rgba(255,255,255,0.04)', background: highlight ? `${resolved}08` : 'transparent' }}>
      <span style={{ fontSize: '14px', lineHeight: 1 }}>{icon}</span>
      <div>
        <div style={{ fontSize: '14px', fontWeight: '700', color: resolved, lineHeight: 1 }}>{main}</div>
        <div style={{ fontSize: '9px', color: '#475569', marginTop: '1px', letterSpacing: '0.03em' }}>{sub}</div>
      </div>
    </div>
  );
}

const EVENT_ICONS = {
  structural_fire: '🔥',
  vehicle_accident: '🚗',
  infrastructure_failure: '🌉',
  mass_casualty: '🏥',
  building_collapse: '🏗️',
  power_outage: '⚡',
  medical_emergency: '🚑',
  hazmat: '☣️',
  flooding: '🌊',
  crime: '🚨',
  system_check: '✅',
};

function pBadge(priority) {
  if (priority >= 9) return { label: 'CRITICAL', color: '#ff3b5c', bg: 'rgba(255,59,92,0.15)' };
  if (priority >= 7) return { label: 'HIGH', color: '#ff6b35', bg: 'rgba(255,107,53,0.12)' };
  if (priority >= 5) return { label: 'MEDIUM', color: '#ffd700', bg: 'rgba(255,215,0,0.1)' };
  return { label: 'LOW', color: '#00d4ff', bg: 'rgba(0,212,255,0.08)' };
}

export function EventFeed() {
  const events = useWorldStore(state => state.eventFeed);
  const visible = events.filter(event => event.type !== 'system_check');

  return (
    <PanelShell header={<>
      <Dot color="cyan" />
      <span style={{ fontSize: '12px', fontWeight: '600', color: 'var(--c-cyan)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Incoming Emergencies</span>
      <span style={{ marginLeft: 'auto', fontSize: '11px', color: '#475569' }}>{visible.length}</span>
    </>}>
      <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {visible.length === 0 && (
          <div style={{ padding: '32px 16px', textAlign: 'center', color: '#334155' }}>
            <div style={{ fontSize: '24px', marginBottom: '8px' }}>📡</div>
            <div style={{ fontSize: '12px', color: '#475569' }}>Monitoring for emergencies</div>
          </div>
        )}
        {visible.map((event, index) => {
          const badge = pBadge(event.priority);
          const icon = EVENT_ICONS[event.type] || '🚨';
          const isLive = event.source === 'live_news' || event.source === 'live_news_keyword';
          return (
            <div key={event.id || index} style={{ borderRadius: '8px', border: `1px solid ${badge.color}30`, background: badge.bg, padding: '10px 12px', animation: 'slideIn 0.2s ease-out' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                <span style={{ fontSize: '16px' }}>{icon}</span>
                <span style={{ fontSize: '11px', fontWeight: '700', color: badge.color, padding: '2px 7px', borderRadius: '4px', background: `${badge.color}18`, border: `1px solid ${badge.color}40` }}>{badge.label}</span>
                <span style={{ fontSize: '11px', fontWeight: '600', color: '#e2e8f0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {(event.type || '').replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase())}
                </span>
                {isLive && <span style={{ fontSize: '9px', color: '#00ff88', background: 'rgba(0,255,136,0.1)', padding: '1px 5px', borderRadius: '3px', flexShrink: 0 }}>LIVE</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                <span style={{ fontSize: '10px', color: '#64748b' }}>📍 {ZONE_NAMES[event.zone] || event.zone}</span>
                <span style={{ fontSize: '10px', color: '#334155' }}>· Priority {event.priority}/10</span>
                <span style={{ fontSize: '10px', color: '#334155', marginLeft: 'auto' }}>{new Date(event.timestamp).toLocaleTimeString()}</span>
              </div>
              {event.description && <div style={{ fontSize: '11px', color: '#64748b', lineHeight: 1.55 }}>{event.description}</div>}
            </div>
          );
        })}
      </div>
    </PanelShell>
  );
}

const TOOL_LABELS = {
  getRoute: '📍 Route calculated',
  blockRoad: '🚧 Road closed',
  getAvailableUnits: '🔍 Units checked',
  dispatchUnit: '🚀 Unit dispatched',
  returnUnit: '↩️ Unit recalled',
  notifyCitizens: '📢 Alert sent',
  getHospitalCapacity: '🏥 Hospital checked',
  updateHospitalCapacity: '🏥 Hospital updated',
  getWeather: '🌬️ Weather checked',
};

export function AuditTimeline() {
  const audit = useWorldStore(state => state.auditTimeline);
  const [open, setOpen] = useState(null);

  return (
    <PanelShell header={<>
      <Dot color="cyan" />
      <span style={{ fontSize: '12px', fontWeight: '600', color: 'var(--c-cyan)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Decision Log</span>
      <span style={{ marginLeft: 'auto', fontSize: '11px', color: '#475569' }}>{audit.length} decision{audit.length !== 1 ? 's' : ''}</span>
    </>}>
      <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '5px' }}>
        {audit.length === 0 && (
          <div style={{ padding: '32px 16px', textAlign: 'center' }}>
            <div style={{ fontSize: '24px', marginBottom: '8px' }}>📋</div>
            <div style={{ fontSize: '12px', color: '#475569' }}>Every AI decision will appear here</div>
          </div>
        )}
        {audit.map((entry, index) => {
          const isOpen = open === index;
          const tools = entry.toolCalls || [];
          const dispatched = tools.filter(tool => (tool.tool || tool.name) === 'dispatchUnit' && tool.result?.success);
          const zone = entry.zone;
          const rawType = entry.eventType || entry.type || '';
          const type = rawType.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase()) || null;
          const planSummary = entry.planSummary || entry.decision || '';
          const stepwiseRationale = entry.stepwiseRationale || entry?.metadata?.decisionData?.stepwise_rationale || [];
          const finalAction = entry.finalAction || entry?.metadata?.decisionData?.final_action || null;
          const persisted = entry.persisted ?? entry?.metadata?.persisted;

          return (
            <div key={index} onClick={() => setOpen(isOpen ? null : index)} style={{ borderRadius: '8px', border: `1px solid ${isOpen ? 'rgba(0,212,255,0.3)' : 'rgba(255,255,255,0.06)'}`, background: isOpen ? 'rgba(0,212,255,0.04)' : 'rgba(255,255,255,0.02)', cursor: 'pointer', overflow: 'hidden', transition: 'all 0.15s' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 12px' }}>
                <span style={{ fontSize: '16px' }}>🧠</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '12px', fontWeight: '600', color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {type || `Incident ${String(entry.incidentId || '').slice(-8)}`}
                    {zone && <span style={{ fontSize: '11px', color: '#64748b', fontWeight: '400' }}> - {ZONE_NAMES[zone] || zone}</span>}
                  </div>
                  <div style={{ fontSize: '10px', color: '#475569', marginTop: '1px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ color: tools.length > 0 ? '#64748b' : '#334155' }}>
                      {tools.length > 0 ? `${tools.length} action${tools.length !== 1 ? 's' : ''}` : 'assessed - no dispatch needed'}
                    </span>
                    {dispatched.length > 0 && <span style={{ color: '#00ff88' }}>· {dispatched.length} unit{dispatched.length > 1 ? 's' : ''} dispatched</span>}
                    {persisted === false && <span style={{ color: '#fbbf24' }}>· memory only</span>}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: '10px', color: '#334155' }}>{new Date(entry.timestamp).toLocaleTimeString()}</div>
                  <div style={{ fontSize: '9px', color: '#475569', marginTop: '1px' }}>{isOpen ? '▲ hide' : '▼ details'}</div>
                </div>
              </div>

              {isOpen && (
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', background: 'rgba(0,0,0,0.25)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {tools.length > 0 && (
                    <div>
                      <div style={{ fontSize: '9px', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '5px' }}>What the AI did</div>
                      {tools.map((toolCall, toolIndex) => {
                        const name = toolCall.tool || toolCall.name || 'unknown';
                        const ok = toolCall.result?.success !== false;
                        const argHint = name === 'dispatchUnit' && toolCall.result?.unit?.name
                          ? ` - ${toolCall.result.unit.name}`
                          : name === 'getRoute' && toolCall.result?.totalTimeMinutes
                            ? ` - ETA ${toolCall.result.totalTimeMinutes}min`
                            : name === 'blockRoad' && toolCall.result?.edgeName
                              ? ` - ${toolCall.result.edgeName}`
                              : '';
                        return (
                          <div key={toolIndex} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                            <span style={{ fontSize: '12px', flex: 1, color: ok ? '#94a3b8' : '#f87171' }}>{TOOL_LABELS[name] || `-> ${name}`}{argHint}</span>
                            <span style={{ fontSize: '10px', color: ok ? '#22c55e' : '#ef4444' }}>{ok ? '✓' : '✕'}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {planSummary && (
                    <div>
                      <div style={{ fontSize: '9px', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '4px' }}>AI Summary</div>
                      <div style={{ fontSize: '11px', color: '#94a3b8', lineHeight: 1.6, maxHeight: '80px', overflowY: 'auto' }}>
                        {planSummary.slice(0, 300)}{planSummary.length > 300 ? '...' : ''}
                      </div>
                    </div>
                  )}

                  {(finalAction || stepwiseRationale.length > 0 || persisted === false) && (
                    <div>
                      <div style={{ fontSize: '9px', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '4px' }}>Decision Details</div>
                      {finalAction && <div style={{ fontSize: '10px', color: '#e2e8f0', marginBottom: '4px' }}>Final action: {finalAction}</div>}
                      {persisted === false && <div style={{ fontSize: '10px', color: '#fbbf24', marginBottom: '4px' }}>Persistence pending - shown from live memory</div>}
                      {stepwiseRationale.map((step, stepIndex) => (
                        <div key={stepIndex} style={{ fontSize: '10px', color: '#94a3b8', lineHeight: 1.5 }}>
                          {stepIndex + 1}. {step}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </PanelShell>
  );
}

function makeUnitIcon(type, status) {
  const map = {
    police: { color: '#60a5fa', symbol: '🚔' },
    fire: { color: '#f87171', symbol: '🚒' },
    ems: { color: '#4ade80', symbol: '🚑' },
    traffic: { color: '#facc15', symbol: '🚦' },
  };
  const { color, symbol } = map[type] || { color: '#94a3b8', symbol: '●' };
  const deployed = status === 'dispatched';
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;font-size:${deployed ? 24 : 18}px;filter:drop-shadow(0 0 ${deployed ? 10 : 4}px ${color});opacity:${deployed ? 1 : 0.65};transition:all 0.3s">${symbol}${deployed ? '<div style="position:absolute;top:-4px;right:-4px;width:9px;height:9px;background:#ff6b35;border-radius:50%;border:2px solid #080d18;animation:pulse 0.8s ease-in-out infinite;box-shadow:0 0 6px #ff6b35"></div>' : ''}</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

function makeIncidentIcon(priority) {
  const color = priority >= 9 ? '#ff3b5c' : priority >= 7 ? '#ff6b35' : '#ffd700';
  return L.divIcon({
    className: '',
    html: `<div style="font-size:22px;filter:drop-shadow(0 0 8px ${color});animation:pulse 1.2s ease-in-out infinite">⚠️</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

const ROUTE_COLORS = {
  police: '#60a5fa',
  fire: '#f87171',
  ems: '#4ade80',
  traffic: '#facc15',
};

export function CityMap() {
  const units = useWorldStore(state => state.units);
  const incidents = useWorldStore(state => state.incidents);
  const replan = useWorldStore(state => state.replanBanner);
  const unitRoutes = useWorldStore(state => state.unitRoutes);
  const activeIncidents = incidents.filter(incident => incident.status === 'active');
  const available = units.filter(unit => unit.status === 'available').length;
  const deployed = units.filter(unit => unit.status === 'dispatched').length;

  return (
    <div style={{ position: 'relative', height: '100%', borderRadius: '10px', overflow: 'hidden', border: '1px solid rgba(0,212,255,0.2)' }}>
      {replan && (
        <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 1000, background: 'rgba(10,5,0,0.96)', border: '1px solid #ff6b35', borderRadius: '8px', padding: '7px 18px', display: 'flex', alignItems: 'center', gap: '8px', boxShadow: '0 0 20px rgba(255,107,53,0.4)', whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: '14px' }}>🔄</span>
          <div>
            <div style={{ fontSize: '11px', fontWeight: '700', color: '#ff6b35', letterSpacing: '0.06em' }}>AUTO-REPLAN TRIGGERED</div>
            <div style={{ fontSize: '10px', color: '#94a3b8' }}>{replan.reason?.slice(0, 55)}</div>
          </div>
        </div>
      )}

      <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 1000, background: 'rgba(13,18,36,0.92)', border: '1px solid rgba(0,212,255,0.2)', borderRadius: '7px', padding: '7px 12px' }}>
        <div style={{ fontSize: '9px', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '3px' }}>Units</div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <span style={{ fontSize: '12px', color: '#00ff88', fontWeight: '600' }}>✓ {available} free</span>
          {deployed > 0 && <span style={{ fontSize: '12px', color: '#ff6b35', fontWeight: '600' }}>● {deployed} active</span>}
        </div>
      </div>

      <MapContainer center={[28.6139, 77.2090]} zoom={11} style={{ height: '100%', width: '100%' }} zoomControl={false}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="" />

        {Object.values(unitRoutes).map(route => {
          const positions = (route.path || [])
            .map(point => {
              if (Array.isArray(point)) return [point[0], point[1]];
              if (typeof point?.lat === 'number' && typeof point?.lng === 'number') return [point.lat, point.lng];
              if (typeof point === 'string' && ZONE_META[point]) {
                const zone = ZONE_META[point];
                return [zone.lat, zone.lng];
              }
              return null;
            })
            .filter(Boolean);

          if (positions.length < 2) return null;
          const color = ROUTE_COLORS[route.unitType] || '#94a3b8';

          return (
            <Polyline
              key={`route-${route.unitId}`}
              positions={positions}
              pathOptions={{
                color,
                weight: 4,
                opacity: 0.9,
                dashArray: '12 6',
                lineCap: 'round',
                lineJoin: 'round',
              }}
            >
              <Popup>
                <div style={{ fontFamily: 'monospace', fontSize: '12px', minWidth: '180px' }}>
                  <div style={{ fontWeight: 'bold', color, marginBottom: '4px' }}>
                    {route.unitType === 'police' ? '🚔' : route.unitType === 'fire' ? '🚒' : route.unitType === 'ems' ? '🚑' : '🚦'} {route.unitName}
                  </div>
                  <div>📍 Route: {(route.zonePath || []).join(' -> ') || `${positions.length} map points`}</div>
                  <div>⏱ ETA: {route.etaMinutes ?? Math.round((route.etaSeconds || 0) / 60)} min</div>
                  {route.distanceMeters ? <div>Distance: {route.distanceMeters} m</div> : null}
                  <div style={{ marginTop: '4px', color: '#64748b' }}>Incident: {route.incidentId?.slice(-8)}</div>
                </div>
              </Popup>
            </Polyline>
          );
        })}

        {activeIncidents.map(incident => {
          const zone = ZONE_META[incident.zone];
          if (!zone) return null;
          return (
            <Marker key={`inc-${incident.id}`} position={[zone.lat, zone.lng]} icon={makeIncidentIcon(incident.priority)}>
              <Popup>
                <div style={{ fontFamily: 'monospace', fontSize: '12px', minWidth: '160px' }}>
                  <div style={{ fontWeight: 'bold', color: '#ff3b5c', marginBottom: '4px' }}>⚠️ {(incident.type || '').replace(/_/g, ' ').toUpperCase()}</div>
                  <div>📍 {zone.name}</div>
                  <div>Priority: {incident.priority}/10</div>
                  {incident.description && <div style={{ marginTop: '4px', fontSize: '11px', color: '#64748b' }}>{incident.description.slice(0, 80)}</div>}
                </div>
              </Popup>
            </Marker>
          );
        })}

        {units.map(unit => {
          const zone = ZONE_META[unit.currentZone];
          if (!zone) return null;
          const num = parseFloat(unit.id.replace(/\D/g, '')) || 0;
          return (
            <Marker key={unit.id} position={[zone.lat + (num % 5 - 2) * 0.003, zone.lng + (num % 3 - 1) * 0.004]} icon={makeUnitIcon(unit.type, unit.status)}>
              <Popup>
                <div style={{ fontFamily: 'monospace', fontSize: '12px', minWidth: '170px' }}>
                  <div style={{ fontWeight: 'bold', marginBottom: '5px' }}>{unit.name}</div>
                  <div>Status: <span style={{ color: unit.status === 'available' ? '#22c55e' : '#f97316' }}>{unit.status === 'available' ? '✓ Available' : '● On Scene'}</span></div>
                  <div>Zone: {zone.name}</div>
                  {unit.destination && <div style={{ marginTop: '4px', color: '#f97316' }}>→ Heading to: {ZONE_NAMES[unit.destination] || unit.destination}</div>}
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>

      <div style={{ position: 'absolute', bottom: 10, left: 10, zIndex: 1000, background: 'rgba(13,18,36,0.92)', border: '1px solid rgba(0,212,255,0.15)', borderRadius: '7px', padding: '8px 10px' }}>
        <div style={{ fontSize: '9px', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '5px' }}>Legend</div>
        {[
          ['🚔', 'Police', '#60a5fa'],
          ['🚒', 'Fire', '#f87171'],
          ['🚑', 'Medical', '#4ade80'],
          ['🚦', 'Traffic', '#facc15'],
        ].map(([symbol, label, color]) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '2px' }}>
            <span style={{ fontSize: '12px' }}>{symbol}</span>
            <span style={{ fontSize: '10px', color }}>{label}</span>
          </div>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', borderTop: '1px solid rgba(255,255,255,0.05)', marginTop: '4px', paddingTop: '4px' }}>
          <span style={{ fontSize: '12px' }}>⚠️</span>
          <span style={{ fontSize: '10px', color: '#ff3b5c' }}>Active incident</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '2px' }}>
          <svg width="18" height="8"><line x1="0" y1="4" x2="18" y2="4" stroke="#94a3b8" strokeWidth="2" strokeDasharray="4 3" /></svg>
          <span style={{ fontSize: '10px', color: '#64748b' }}>Dispatch route</span>
        </div>
      </div>
    </div>
  );
}
