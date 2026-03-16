import { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import { useWorldStore, ZONE_META } from '../store/useWorldStore.js';

const COLORS = { cyan:'#00d4ff', green:'#00ff88', orange:'#ff6b35', red:'#ff3b5c', yellow:'#ffd700', purple:'#a855f7' };

const ZONE_NAMES = {CP:'Connaught Place',RP:'Rajpath',KB:'Karol Bagh',LN:'Lajpat Nagar',DW:'Dwarka',RH:'Rohini',SD:'Shahdara',NP:'Nehru Place',IGI:'IGI Airport',OKH:'Okhla'};

// ─── Tiny shared primitives ───────────────────────────────────────────────────
function Dot({ color = 'cyan', pulse }) {
  const c = COLORS[color] || color;
  return <div style={{ width:7, height:7, borderRadius:'50%', background:c, boxShadow:`0 0 6px ${c}`, flexShrink:0, ...(pulse?{animation:'pulse 1.5s ease-in-out infinite'}:{}) }} />;
}

function PanelShell({ header, children, style }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden', background:'var(--c-surface)', border:'1px solid var(--c-border)', borderRadius:'10px', ...style }}>
      <div style={{ display:'flex', alignItems:'center', gap:'8px', padding:'10px 14px', borderBottom:'1px solid rgba(255,255,255,0.05)', flexShrink:0 }}>
        {header}
      </div>
      <div style={{ flex:1, overflowY:'auto', minHeight:0 }}>
        {children}
      </div>
    </div>
  );
}

// ─── StatsBar — 4 stats max, clear meaning ───────────────────────────────────
export function StatsBar() {
  const stats        = useWorldStore(s => s.stats);
  const connected    = useWorldStore(s => s.connected);
  const blockedEdges = useWorldStore(s => s.blockedEdges);
  const [time, setTime] = useState('');
  useEffect(() => {
    const fn = () => setTime(new Date().toLocaleTimeString('en-IN', {hour:'2-digit',minute:'2-digit',second:'2-digit'}));
    fn();
    const t = setInterval(fn, 1000);
    return () => clearInterval(t);
  }, []);

  const avail     = stats.availableUnits ?? 0;
  const total     = stats.totalUnits ?? 16;
  const active    = stats.activeIncidents ?? 0;
  const threats   = stats.totalInjectionsCaught ?? 0;

  return (
    <div style={{ display:'flex', alignItems:'stretch', background:'rgba(8,13,24,0.9)', borderBottom:'1px solid rgba(0,212,255,0.08)', flexShrink:0, height:'42px' }}>

      {/* System status */}
      <div style={{ display:'flex', alignItems:'center', gap:'7px', padding:'0 16px', borderRight:'1px solid rgba(255,255,255,0.04)' }}>
        <Dot color={connected?'green':'red'} pulse />
        <span style={{ fontSize:'11px', fontWeight:'600', color: connected?'#00ff88':'#ff3b5c', letterSpacing:'0.06em' }}>
          {connected ? 'ONLINE' : 'RECONNECTING'}
        </span>
      </div>

      {/* Units */}
      <Stat
        icon="🚔"
        main={`${avail}/${total}`}
        sub={avail === total ? 'all available' : `${total-avail} deployed`}
        color={avail < 4 ? 'red' : avail < 8 ? 'orange' : 'green'}
      />

      {/* Active incidents */}
      <Stat
        icon="⚠️"
        main={active}
        sub={active === 0 ? 'no incidents' : `active right now`}
        color={active > 0 ? 'orange' : 'green'}
        highlight={active > 0}
      />

      {/* Blocked roads */}
      {blockedEdges.length > 0 && (
        <Stat
          icon="🚧"
          main={blockedEdges.length}
          sub="road(s) closed"
          color="orange"
          highlight
        />
      )}

      {/* Threats */}
      {threats > 0 && (
        <Stat icon="🛡️" main={threats} sub="attack(s) blocked" color="purple" />
      )}

      {/* Clock */}
      <div style={{ marginLeft:'auto', padding:'0 14px', display:'flex', alignItems:'center' }}>
        <span style={{ fontSize:'11px', color:'#334155', fontVariantNumeric:'tabular-nums' }}>{time} IST</span>
      </div>
    </div>
  );
}

function Stat({ icon, main, sub, color, highlight }) {
  const c = COLORS[color] || color;
  return (
    <div style={{ display:'flex', alignItems:'center', gap:'8px', padding:'0 14px', borderRight:'1px solid rgba(255,255,255,0.04)', background: highlight ? `${c}08` : 'transparent' }}>
      <span style={{ fontSize:'14px', lineHeight:1 }}>{icon}</span>
      <div>
        <div style={{ fontSize:'14px', fontWeight:'700', color:c, lineHeight:1 }}>{main}</div>
        <div style={{ fontSize:'9px', color:'#475569', marginTop:'1px', letterSpacing:'0.03em' }}>{sub}</div>
      </div>
    </div>
  );
}

// ─── EventFeed ────────────────────────────────────────────────────────────────

const EVENT_ICONS = {
  structural_fire:'🔥', vehicle_accident:'🚗', infrastructure_failure:'🌉',
  mass_casualty:'🏥', building_collapse:'🏗️', power_outage:'⚡',
  medical_emergency:'🚑', hazmat:'☣️', flooding:'🌊', crime:'🚨', system_check:'✅',
};

function pBadge(p) {
  if (p >= 9) return { label:'CRITICAL', color:'#ff3b5c', bg:'rgba(255,59,92,0.15)' };
  if (p >= 7) return { label:'HIGH',     color:'#ff6b35', bg:'rgba(255,107,53,0.12)' };
  if (p >= 5) return { label:'MEDIUM',   color:'#ffd700', bg:'rgba(255,215,0,0.1)' };
  return             { label:'LOW',      color:'#00d4ff', bg:'rgba(0,212,255,0.08)' };
}


export function EventFeed() {
  const events = useWorldStore(s => s.eventFeed);
  // filter out system_check from display
  const visible = events.filter(e => e.type !== 'system_check');

  return (
    <PanelShell header={<>
      <Dot color="cyan" />
      <span style={{fontSize:'12px',fontWeight:'600',color:'var(--c-cyan)',letterSpacing:'0.08em',textTransform:'uppercase'}}>Incoming Emergencies</span>
      <span style={{marginLeft:'auto',fontSize:'11px',color:'#475569'}}>{visible.length}</span>
    </>}>
      <div style={{ padding:'8px', display:'flex', flexDirection:'column', gap:'6px' }}>
        {visible.length === 0 && (
          <div style={{ padding:'32px 16px', textAlign:'center', color:'#334155' }}>
            <div style={{fontSize:'24px',marginBottom:'8px'}}>📡</div>
            <div style={{fontSize:'12px',color:'#475569'}}>Monitoring for emergencies</div>
          </div>
        )}
        {visible.map((ev, i) => {
          const p    = pBadge(ev.priority);
          const icon = EVENT_ICONS[ev.type] || '🚨';
          const isLive = ev.source === 'live_news' || ev.source === 'live_news_keyword';
          return (
            <div key={ev.id || i} style={{ borderRadius:'8px', border:`1px solid ${p.color}30`, background:p.bg, padding:'10px 12px', animation:'slideIn 0.2s ease-out' }}>
              <div style={{ display:'flex', alignItems:'center', gap:'8px', marginBottom:'6px' }}>
                <span style={{fontSize:'16px'}}>{icon}</span>
                <span style={{fontSize:'11px',fontWeight:'700',color:p.color,padding:'2px 7px',borderRadius:'4px',background:`${p.color}18`,border:`1px solid ${p.color}40`}}>{p.label}</span>
                <span style={{fontSize:'11px',fontWeight:'600',color:'#e2e8f0',flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                  {(ev.type||'').replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}
                </span>
                {isLive && <span style={{fontSize:'9px',color:'#00ff88',background:'rgba(0,255,136,0.1)',padding:'1px 5px',borderRadius:'3px',flexShrink:0}}>LIVE</span>}
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:'6px', marginBottom:'6px' }}>
                <span style={{fontSize:'10px',color:'#64748b'}}>📍 {ZONE_NAMES[ev.zone]||ev.zone}</span>
                <span style={{fontSize:'10px',color:'#334155'}}>· Priority {ev.priority}/10</span>
                <span style={{fontSize:'10px',color:'#334155',marginLeft:'auto'}}>{new Date(ev.timestamp).toLocaleTimeString()}</span>
              </div>
              {ev.description && (
                <div style={{ fontSize:'11px', color:'#64748b', lineHeight:1.55 }}>
                  {ev.description}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </PanelShell>
  );
}

// ─── AuditTimeline ────────────────────────────────────────────────────────────

const TOOL_LABELS = {
  getRoute:'📍 Route calculated',blockRoad:'🚧 Road closed',
  getAvailableUnits:'🔍 Units checked',dispatchUnit:'🚀 Unit dispatched',
  returnUnit:'↩️ Unit recalled',notifyCitizens:'📢 Alert sent',
  getHospitalCapacity:'🏥 Hospital checked',updateHospitalCapacity:'🏥 Hospital updated',
  getWeather:'🌬️ Weather checked',
};

export function AuditTimeline() {
  const audit    = useWorldStore(s => s.auditTimeline);
  const [open, setOpen] = useState(null);

  return (
    <PanelShell header={<>
      <Dot color="cyan" />
      <span style={{fontSize:'12px',fontWeight:'600',color:'var(--c-cyan)',letterSpacing:'0.08em',textTransform:'uppercase'}}>Decision Log</span>
      <span style={{marginLeft:'auto',fontSize:'11px',color:'#475569'}}>{audit.length} decision{audit.length!==1?'s':''}</span>
    </>}>
      <div style={{ padding:'8px', display:'flex', flexDirection:'column', gap:'5px' }}>
        {audit.length === 0 && (
          <div style={{ padding:'32px 16px', textAlign:'center' }}>
            <div style={{fontSize:'24px',marginBottom:'8px'}}>📋</div>
            <div style={{fontSize:'12px',color:'#475569'}}>Every AI decision will appear here</div>
          </div>
        )}
        {audit.map((entry, i) => {
          const isOpen = open === i;
          const tools  = entry.toolCalls || [];
          const dispatched = tools.filter(t=>(t.tool||t.name)==='dispatchUnit'&&t.result?.success);
          const zone   = entry.zone;
          // eventType comes from AGENT_DECISION broadcast (added in latest coordinator fix)
          const rawType = entry.eventType || entry.type || '';
          const type   = rawType.replace(/_/g,' ').replace(/\w/g,c=>c.toUpperCase()) || null;

          return (
            <div key={i} onClick={() => setOpen(isOpen?null:i)} style={{ borderRadius:'8px', border:`1px solid ${isOpen?'rgba(0,212,255,0.3)':'rgba(255,255,255,0.06)'}`, background: isOpen?'rgba(0,212,255,0.04)':'rgba(255,255,255,0.02)', cursor:'pointer', overflow:'hidden', transition:'all 0.15s' }}>
              <div style={{ display:'flex', alignItems:'center', gap:'8px', padding:'9px 12px' }}>
                <span style={{fontSize:'16px'}}>🧠</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:'12px',fontWeight:'600',color:'#e2e8f0',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                    {type || `Incident ${String(entry.incidentId||'').slice(-8)}`}
                    {zone && <span style={{fontSize:'11px',color:'#64748b',fontWeight:'400'}}> — {ZONE_NAMES[zone]||zone}</span>}
                  </div>
                  <div style={{fontSize:'10px',color:'#475569',marginTop:'1px',display:'flex',gap:'8px'}}>
                    <span>{tools.length > 0 ? `${tools.length} action${tools.length!==1?'s':''}` : 'processing...'}</span>
                    {dispatched.length > 0 && <span style={{color:'#00ff88'}}>· {dispatched.length} unit{dispatched.length>1?'s':''} dispatched</span>}
                  </div>
                </div>
                <div style={{textAlign:'right',flexShrink:0}}>
                  <div style={{fontSize:'10px',color:'#334155'}}>{new Date(entry.timestamp).toLocaleTimeString()}</div>
                  <div style={{fontSize:'9px',color:'#475569',marginTop:'1px'}}>{isOpen?'▲ hide':'▼ details'}</div>
                </div>
              </div>

              {isOpen && (
                <div style={{ borderTop:'1px solid rgba(255,255,255,0.05)', background:'rgba(0,0,0,0.25)', padding:'10px 12px', display:'flex', flexDirection:'column', gap:'8px' }}>
                  {tools.length > 0 && (
                    <div>
                      <div style={{fontSize:'9px',color:'#475569',textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:'5px'}}>What the AI did</div>
                      {tools.map((tc,j) => {
                        const name = tc.tool||tc.name;
                        const ok   = tc.result?.success!==false;
                        return (
                          <div key={j} style={{display:'flex',alignItems:'center',gap:'8px',padding:'4px 0',borderBottom:'1px solid rgba(255,255,255,0.03)'}}>
                            <span style={{fontSize:'12px',flex:1,color:ok?'#94a3b8':'#f87171'}}>{TOOL_LABELS[name]||`→ ${name}`}</span>
                            <span style={{fontSize:'10px',color:ok?'#22c55e':'#ef4444'}}>{ok?'✓':'✗'}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {entry.decision && (
                    <div>
                      <div style={{fontSize:'9px',color:'#475569',textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:'4px'}}>AI Summary</div>
                      <div style={{fontSize:'11px',color:'#94a3b8',lineHeight:1.6,maxHeight:'80px',overflowY:'auto'}}>
                        {entry.decision.slice(0,300)}{entry.decision.length>300?'…':''}
                      </div>
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

// ─── CityMap ──────────────────────────────────────────────────────────────────

function makeUnitIcon(type, status) {
  const map = { police:{color:'#3b82f6',s:'🚔'}, fire:{color:'#ff3b5c',s:'🚒'}, ems:{color:'#00ff88',s:'🚑'}, traffic:{color:'#ffd700',s:'🚦'} };
  const {color,s} = map[type] || {color:'#94a3b8',s:'●'};
  const deployed = status === 'dispatched';
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;font-size:${deployed?22:18}px;filter:drop-shadow(0 0 ${deployed?8:3}px ${color});opacity:${deployed?1:0.7}">${s}${deployed?`<div style="position:absolute;top:-3px;right:-3px;width:7px;height:7px;background:#ff6b35;border-radius:50%;border:1px solid #080d18;animation:pulse 0.8s ease-in-out infinite"></div>`:''}</div>`,
    iconSize:[28,28], iconAnchor:[14,14],
  });
}

function makeIncidentIcon(priority) {
  const c = priority>=9?'#ff3b5c':priority>=7?'#ff6b35':'#ffd700';
  return L.divIcon({
    className:'',
    html:`<div style="font-size:22px;filter:drop-shadow(0 0 8px ${c});animation:pulse 1.2s ease-in-out infinite">⚠️</div>`,
    iconSize:[26,26], iconAnchor:[13,13],
  });
}

export function CityMap() {
  const units     = useWorldStore(s => s.units);
  const incidents = useWorldStore(s => s.incidents);
  const replan    = useWorldStore(s => s.replanBanner);
  const available = units.filter(u=>u.status==='available').length;
  const deployed  = units.filter(u=>u.status==='dispatched').length;
  const activeIncidents = incidents.filter(i => i.status === 'active');

  return (
    <div style={{ position:'relative', height:'100%', borderRadius:'10px', overflow:'hidden', border:'1px solid rgba(0,212,255,0.2)' }}>

      {replan && (
        <div style={{ position:'absolute', top:10, left:'50%', transform:'translateX(-50%)', zIndex:1000, background:'rgba(10,5,0,0.96)', border:'1px solid #ff6b35', borderRadius:'8px', padding:'7px 18px', display:'flex', alignItems:'center', gap:'8px', boxShadow:'0 0 20px rgba(255,107,53,0.4)', whiteSpace:'nowrap' }}>
          <span style={{fontSize:'14px'}}>🔄</span>
          <div>
            <div style={{fontSize:'11px',fontWeight:'700',color:'#ff6b35',letterSpacing:'0.06em'}}>AUTO-REPLAN TRIGGERED</div>
            <div style={{fontSize:'10px',color:'#94a3b8'}}>{replan.reason?.slice(0,55)}</div>
          </div>
        </div>
      )}

      {/* Unit counter */}
      <div style={{ position:'absolute', top:10, right:10, zIndex:1000, background:'rgba(13,18,36,0.92)', border:'1px solid rgba(0,212,255,0.2)', borderRadius:'7px', padding:'7px 12px' }}>
        <div style={{fontSize:'9px',color:'#475569',textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:'3px'}}>Units</div>
        <div style={{display:'flex',gap:'10px'}}>
          <span style={{fontSize:'12px',color:'#00ff88',fontWeight:'600'}}>✓ {available} free</span>
          {deployed>0&&<span style={{fontSize:'12px',color:'#ff6b35',fontWeight:'600'}}>● {deployed} active</span>}
        </div>
      </div>

      <MapContainer center={[28.6139,77.2090]} zoom={11} style={{height:'100%',width:'100%'}} zoomControl={false}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="" />

        {activeIncidents.map(inc => {
          const z = ZONE_META[inc.zone];
          if (!z) return null;
          return (
            <Marker key={`inc-${inc.id}`} position={[z.lat, z.lng]} icon={makeIncidentIcon(inc.priority)}>
              <Popup>
                <div style={{fontFamily:'monospace',fontSize:'12px',minWidth:'160px'}}>
                  <div style={{fontWeight:'bold',color:'#ff3b5c',marginBottom:'4px'}}>⚠️ {(inc.type||'').replace(/_/g,' ').toUpperCase()}</div>
                  <div>📍 {z.name}</div>
                  <div>Priority: {inc.priority}/10</div>
                  {inc.description&&<div style={{marginTop:'4px',fontSize:'11px',color:'#64748b'}}>{inc.description.slice(0,80)}</div>}
                </div>
              </Popup>
            </Marker>
          );
        })}

        {units.map(unit => {
          const z = ZONE_META[unit.currentZone];
          if (!z) return null;
          const num = parseFloat(unit.id.replace(/\D/g,''))||0;
          return (
            <Marker key={unit.id} position={[z.lat+(num%5-2)*0.003, z.lng+(num%3-1)*0.004]} icon={makeUnitIcon(unit.type,unit.status)}>
              <Popup>
                <div style={{fontFamily:'monospace',fontSize:'12px',minWidth:'170px'}}>
                  <div style={{fontWeight:'bold',marginBottom:'5px'}}>{unit.name}</div>
                  <div>Status: <span style={{color:unit.status==='available'?'#22c55e':'#f97316'}}>{unit.status==='available'?'✓ Available':'● On Scene'}</span></div>
                  <div>Zone: {z.name}</div>
                  {unit.destination&&<div style={{marginTop:'4px',color:'#f97316'}}>→ Heading to: {ZONE_NAMES[unit.destination]||unit.destination}</div>}
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>

      {/* Legend */}
      <div style={{ position:'absolute', bottom:10, left:10, zIndex:1000, background:'rgba(13,18,36,0.92)', border:'1px solid rgba(0,212,255,0.15)', borderRadius:'7px', padding:'8px 10px' }}>
        <div style={{fontSize:'9px',color:'#475569',textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:'5px'}}>Legend</div>
        {[['🚔','Police','#3b82f6'],['🚒','Fire','#ff3b5c'],['🚑','Medical','#00ff88'],['🚦','Traffic','#ffd700']].map(([s,l,c])=>(
          <div key={l} style={{display:'flex',alignItems:'center',gap:'5px',marginBottom:'2px'}}>
            <span style={{fontSize:'12px'}}>{s}</span>
            <span style={{fontSize:'10px',color:c}}>{l}</span>
          </div>
        ))}
        <div style={{display:'flex',alignItems:'center',gap:'5px',borderTop:'1px solid rgba(255,255,255,0.05)',marginTop:'4px',paddingTop:'4px'}}>
          <span style={{fontSize:'12px'}}>⚠️</span>
          <span style={{fontSize:'10px',color:'#ff3b5c'}}>Active incident</span>
        </div>
      </div>
    </div>
  );
}
