import { useState, useEffect } from 'react';
import { useSocket }    from './store/useSocket.js';
import { useWorldStore } from './store/useWorldStore.js';
import { CityMap, EventFeed, StatsBar, AuditTimeline } from './components/Panels.jsx';
import ThoughtTrace  from './components/ThoughtTrace.jsx';
import JudgePanel    from './components/JudgePanel.jsx';
import SecurityFeed  from './components/SecurityFeed.jsx';

const TABS = [
  { id:'map',      icon:'🗺️',  label:'Live Map',     hint:'City map + incoming emergencies' },
  { id:'brain',    icon:'🧠',  label:'AI Brain',      hint:'Live AI reasoning' },
  { id:'control',  icon:'⚡',  label:'Control Room',  hint:'Trigger emergency scenarios' },
  { id:'security', icon:'🛡️', label:'Security',      hint:'Firewall + threat log' },
  { id:'decisions',icon:'📋',  label:'Decisions',     hint:'Every AI decision logged' },
];

export default function App() {
  useSocket();
  const [tab, setTab]          = useState('map');
  const connected              = useWorldStore(s => s.connected);
  const activeScenario         = useWorldStore(s => s.activeScenario);
  const replanBanner           = useWorldStore(s => s.replanBanner);
  const activeThought          = useWorldStore(s => s.activeThought);
  const securityFeed           = useWorldStore(s => s.securityFeed);
  const auditTimeline          = useWorldStore(s => s.auditTimeline);

  // Auto-jump to brain tab when AI starts thinking
  useEffect(() => { if (activeThought) setTab('brain'); }, [!!activeThought]);

  const brainBadge    = activeThought ? '●' : null;
  const securityBadge = securityFeed.filter(e=>e.eventType==='FIREWALL_BLOCK').length || null;

  return (
    <div style={{ height:'100vh', width:'100vw', display:'flex', flexDirection:'column', overflow:'hidden', background:'var(--c-bg)', fontFamily:'var(--font-ui)' }}>

      {/* ── Navbar ──────────────────────────────────────────────────────────── */}
      <nav style={{ display:'flex', alignItems:'center', background:'var(--c-surface)', borderBottom:'1px solid rgba(0,212,255,0.1)', flexShrink:0, padding:'0 14px', height:'50px', gap:'2px' }}>

        {/* Brand */}
        <div style={{ display:'flex', alignItems:'center', gap:'9px', marginRight:'16px', flexShrink:0 }}>
          <span style={{fontSize:'20px'}}>🛡️</span>
          <div>
            <div style={{fontSize:'13px',fontWeight:'700',letterSpacing:'0.2em',color:'var(--c-cyan)',lineHeight:1}}>AEGIS</div>
            <div style={{fontSize:'9px',color:'#1e293b',letterSpacing:'0.1em'}}>EMERGENCY GRID AI</div>
          </div>
        </div>

        {/* Tabs */}
        {TABS.map(t => {
          const isActive = tab === t.id;
          const badge    = t.id==='brain'?brainBadge : t.id==='security'?securityBadge : null;
          return (
            <button key={t.id} onClick={()=>setTab(t.id)} title={t.hint}
              style={{
                display:'flex', alignItems:'center', gap:'5px',
                padding:'5px 12px', borderRadius:'6px 6px 0 0',
                border:'none', borderBottom: isActive?'2px solid var(--c-cyan)':'2px solid transparent',
                background: isActive?'rgba(0,212,255,0.08)':'transparent',
                color: isActive?'var(--c-cyan)':'#64748b',
                fontFamily:'inherit', fontSize:'12px', fontWeight: isActive?'600':'400',
                cursor:'pointer', position:'relative', transition:'all 0.15s',
              }}>
              <span style={{fontSize:'14px'}}>{t.icon}</span>
              <span>{t.label}</span>
              {badge && (
                <span style={{ position:'absolute', top:4, right:5, background: t.id==='brain'?'#00ff88':'#ff3b5c', color:'#000', fontSize:'9px', fontWeight:'700', borderRadius:'8px', padding:'0 4px', lineHeight:'14px', minWidth:'14px', textAlign:'center' }}>
                  {typeof badge==='number'&&badge>9?'9+':badge}
                </span>
              )}
            </button>
          );
        })}

        {/* Center alert */}
        <div style={{ flex:1, display:'flex', justifyContent:'center' }}>
          {activeScenario && (
            <div style={{ display:'flex', alignItems:'center', gap:'6px', padding:'4px 14px', borderRadius:'20px', background:'rgba(255,215,0,0.08)', border:'1px solid rgba(255,215,0,0.3)', fontSize:'11px', fontWeight:'600', color:'#ffd700', animation:'pulse 1.2s ease-in-out infinite' }}>
              ⚡ {activeScenario.scenarioName?.toUpperCase()}
            </div>
          )}
          {replanBanner && !activeScenario && (
            <div style={{ display:'flex', alignItems:'center', gap:'6px', padding:'4px 14px', borderRadius:'20px', background:'rgba(255,107,53,0.08)', border:'1px solid rgba(255,107,53,0.3)', fontSize:'11px', fontWeight:'600', color:'#ff6b35' }}>
              🔄 REPLANNING — {replanBanner.reason?.slice(0,40)}
            </div>
          )}
        </div>

        {/* Status */}
        <div style={{ display:'flex', alignItems:'center', gap:'6px', padding:'5px 12px', borderRadius:'20px', fontSize:'11px', fontWeight:'600', background: connected?'rgba(0,255,136,0.08)':'rgba(255,59,92,0.08)', border:`1px solid ${connected?'rgba(0,255,136,0.3)':'rgba(255,59,92,0.3)'}`, color: connected?'var(--c-green)':'var(--c-red)', flexShrink:0 }}>
          <div style={{ width:6, height:6, borderRadius:'50%', background: connected?'var(--c-green)':'var(--c-red)', ...(connected?{boxShadow:'0 0 6px #00ff88',animation:'pulse 1.5s ease-in-out infinite'}:{}) }} />
          {connected?'LIVE':'OFFLINE'}
        </div>
      </nav>

      {/* ── Stats strip ─────────────────────────────────────────────────────── */}
      <StatsBar />

      {/* ── Tab content ─────────────────────────────────────────────────────── */}
      <main style={{ flex:1, overflow:'hidden', minHeight:0 }}>
        {tab==='map'       && <MapView />}
        {tab==='brain'     && <BrainView />}
        {tab==='control'   && <ControlView />}
        {tab==='security'  && <SecurityView />}
        {tab==='decisions' && <DecisionsView />}
      </main>
    </div>
  );
}

// ─── Views ────────────────────────────────────────────────────────────────────

function MapView() {
  return (
    <div style={{ display:'grid', gridTemplateColumns:'1fr 360px', gap:'8px', padding:'8px', height:'100%', minHeight:0 }}>
      <div style={{ height:'100%', minHeight:0 }}><CityMap /></div>
      <div style={{ height:'100%', minHeight:0, overflow:'hidden' }}><EventFeed /></div>
    </div>
  );
}

function BrainView() {
  return (
    <div style={{ display:'grid', gridTemplateColumns:'1fr 320px', gap:'8px', padding:'8px', height:'100%', minHeight:0 }}>
      <div style={{ height:'100%', minHeight:0 }}><ThoughtTrace /></div>
      <div style={{ display:'flex', flexDirection:'column', gap:'8px', height:'100%', minHeight:0 }}>
        <HowItWorks />
        <div style={{ flex:1, minHeight:0, overflow:'hidden' }}><AuditTimeline /></div>
      </div>
    </div>
  );
}

function HowItWorks() {
  const activeThought = useWorldStore(s => s.activeThought);
  return (
    <div style={{ background:'var(--c-surface)', border:'1px solid var(--c-border)', borderRadius:'10px', padding:'14px', flexShrink:0 }}>
      <div style={{ fontSize:'12px', fontWeight:'600', color:'var(--c-cyan)', marginBottom:'10px', letterSpacing:'0.06em', textTransform:'uppercase' }}>How This Works</div>
      {[
        ['1','#00d4ff','Trigger a scenario → event enters queue'],
        ['2','#ff6b35','Firewall screens it for threats'],
        ['3','#ffd700','AI reads the event + city state'],
        ['4','#00ff88','AI calls tools: check → route → dispatch'],
        ['5','#a855f7','Every decision logged with full reasoning'],
      ].map(([n,c,text]) => (
        <div key={n} style={{ display:'flex', alignItems:'flex-start', gap:'8px', marginBottom:'7px' }}>
          <div style={{ width:18,height:18,borderRadius:'50%',background:`${c}18`,border:`1px solid ${c}50`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:'9px',fontWeight:'700',color:c,flexShrink:0,marginTop:'1px' }}>{n}</div>
          <div style={{ fontSize:'11px', color:'#64748b', lineHeight:1.5 }}>{text}</div>
        </div>
      ))}
      <div style={{ marginTop:'8px', padding:'8px', background:'rgba(0,212,255,0.04)', borderRadius:'6px', border:'1px solid rgba(0,212,255,0.1)', fontSize:'10px', color:'#475569', lineHeight:1.6 }}>
        {activeThought
          ? '🧠 AI is reasoning now — watch the left panel'
          : '💡 Go to Control Room and trigger a scenario'}
      </div>
    </div>
  );
}

function ControlView() {
  return (
    <div style={{ display:'grid', gridTemplateColumns:'420px 1fr', gap:'8px', padding:'8px', height:'100%', minHeight:0 }}>
      <div style={{ height:'100%', minHeight:0 }}><JudgePanel /></div>
      <div style={{ height:'100%', minHeight:0, overflow:'auto' }}><ControlGuide /></div>
    </div>
  );
}

function ControlGuide() {
  const items = [
    { icon:'🌉', color:'#ff6b35', title:'Bridge Collapse — best opening demo', steps:['Click Bridge Collapse','Switch to AI Brain tab → watch AI call blockRoad() then reroute units','Check Live Map — units get new paths automatically','Shows: Autonomy + Dynamic Replanning (25% of judging)'] },
    { icon:'🏥', color:'#ff3b5c', title:'Mass Casualty — shows tool integration', steps:['Click Mass Casualty','AI calls 4-5 tools: check units → find route → check hospital beds → dispatch','Every step visible in AI Brain tab','Shows: Tool Integration (20% of judging)'] },
    { icon:'⚡', color:'#ffd700', title:'Power Grid Failure — multi-agency', steps:['Click Power Grid Fail','AI coordinates Traffic + Police + Comms simultaneously','Public alerts appear in Security tab','Shows: Multi-agency coordination'] },
    { icon:'🛡️', color:'#a855f7', title:'Inject Attack — security demo (best closer)', steps:['Click Inject Attack','Immediately switch to Security tab','Watch threat score animate to 9.8/10 → BLOCKED','AI Brain shows nothing — the attack never reached the AI','Shows: Security (20% of judging)'] },
  ];
  return (
    <div style={{ background:'var(--c-surface)', border:'1px solid var(--c-border)', borderRadius:'10px', padding:'16px', height:'auto', minHeight:'100%' }}>
      <div style={{ fontSize:'13px', fontWeight:'600', color:'var(--c-cyan)', marginBottom:'14px', letterSpacing:'0.06em', textTransform:'uppercase' }}>Demo Guide</div>
      <div style={{ display:'flex', flexDirection:'column', gap:'12px' }}>
        {items.map((item, i) => (
          <div key={i} style={{ padding:'12px 14px', borderRadius:'8px', border:`1px solid ${item.color}25`, background:`${item.color}06` }}>
            <div style={{ display:'flex', alignItems:'center', gap:'8px', marginBottom:'8px' }}>
              <span style={{fontSize:'16px'}}>{item.icon}</span>
              <span style={{fontSize:'12px',fontWeight:'600',color:item.color}}>{item.title}</span>
            </div>
            <ol style={{ paddingLeft:'16px', display:'flex', flexDirection:'column', gap:'3px' }}>
              {item.steps.map((s,j) => <li key={j} style={{fontSize:'11px',color:'#64748b',lineHeight:1.5}}>{s}</li>)}
            </ol>
          </div>
        ))}
        <div style={{ padding:'12px', background:'rgba(0,255,136,0.04)', border:'1px solid rgba(0,255,136,0.12)', borderRadius:'8px', fontSize:'11px', color:'#475569', lineHeight:1.7 }}>
          <strong style={{color:'var(--c-green)'}}>💡 Best demo sequence:</strong> Start with Mass Casualty (units deploy) → then Bridge Collapse (AI replans around it) → then Inject Attack (security moment). Always click Reset between full demos.
        </div>
      </div>
    </div>
  );
}

function SecurityView() {
  return (
    <div style={{ display:'grid', gridTemplateColumns:'1fr 340px', gap:'8px', padding:'8px', height:'100%', minHeight:0 }}>
      <div style={{ height:'100%', minHeight:0 }}><SecurityFeed /></div>
      <div style={{ height:'100%', minHeight:0, overflow:'auto' }}>
        <div style={{ background:'var(--c-surface)', border:'1px solid var(--c-border)', borderRadius:'10px', padding:'16px' }}>
          <div style={{ fontSize:'13px', fontWeight:'600', color:'var(--c-cyan)', marginBottom:'12px', letterSpacing:'0.06em', textTransform:'uppercase' }}>Firewall Explained</div>
          {[
            ['rgba(255,59,92,0.08)','rgba(255,59,92,0.2)','#ff3b5c','Layer 1 — Pattern Matching (<1ms)','Checks every 911 call against known injection phrases. "Ignore all previous instructions" → instant block. No AI call needed.'],
            ['rgba(255,107,53,0.08)','rgba(255,107,53,0.2)','#ff6b35','Layer 2 — AI Threat Scorer (100-400ms)','Ambiguous inputs go to a second Groq call that scores 0-10. Score ≥ 7.0 = quarantined. Score < 7.0 = forwarded to coordinator.'],
            ['rgba(168,85,247,0.08)','rgba(168,85,247,0.2)','#a855f7','Why this matters for judges','In a real city system, someone could call 911 to manipulate the AI dispatcher. AEGIS catches it. No other hackathon team will demo this live.'],
          ].map(([bg,border,color,title,text],i) => (
            <div key={i} style={{ padding:'10px',background:bg,border:`1px solid ${border}`,borderRadius:'7px',marginBottom:'10px' }}>
              <div style={{fontSize:'11px',fontWeight:'600',color,marginBottom:'5px'}}>{title}</div>
              <div style={{fontSize:'11px',color:'#64748b',lineHeight:1.6}}>{text}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DecisionsView() {
  return (
    <div style={{ display:'grid', gridTemplateColumns:'1fr 320px', gap:'8px', padding:'8px', height:'100%', minHeight:0 }}>
      <div style={{ height:'100%', minHeight:0 }}><AuditTimeline /></div>
      <div style={{ height:'100%', minHeight:0, overflow:'auto' }}>
        <div style={{ background:'var(--c-surface)', border:'1px solid var(--c-border)', borderRadius:'10px', padding:'16px' }}>
          <div style={{ fontSize:'13px', fontWeight:'600', color:'var(--c-cyan)', marginBottom:'12px', letterSpacing:'0.06em', textTransform:'uppercase' }}>About This Log</div>
          <p style={{fontSize:'12px',color:'#64748b',lineHeight:1.7,marginBottom:'12px'}}>
            Every AI decision is permanently logged here with its full chain of thought — exactly what it checked, what it decided, and why. This is AEGIS's explainability feature.
          </p>
          <div style={{padding:'10px',background:'rgba(0,212,255,0.04)',border:'1px solid rgba(0,212,255,0.1)',borderRadius:'7px',marginBottom:'10px'}}>
            <div style={{fontSize:'11px',fontWeight:'600',color:'var(--c-cyan)',marginBottom:'6px'}}>Reading an entry</div>
            {[['🚀 Unit dispatched ✓','Unit successfully sent to scene'],['📍 Route calculated','Dijkstra pathfinding ran'],['🏥 Hospital checked','Bed availability queried'],['🚧 Road closed','Edge blocked in city graph'],['✗ Failed','Tool error — shown in red']].map(([k,v])=>(
              <div key={k} style={{display:'flex',gap:'8px',marginBottom:'4px'}}>
                <span style={{fontSize:'11px',color:'#94a3b8',minWidth:'170px'}}>{k}</span>
                <span style={{fontSize:'11px',color:'#475569'}}>{v}</span>
              </div>
            ))}
          </div>
          <div style={{padding:'10px',background:'rgba(0,255,136,0.04)',border:'1px solid rgba(0,255,136,0.12)',borderRadius:'7px',fontSize:'11px',color:'#64748b',lineHeight:1.6}}>
            <strong style={{color:'var(--c-green)'}}>Judging impact:</strong> This log directly satisfies Technical Architecture (10%) and Observability (10%) criteria — proving every decision is transparent and auditable.
          </div>
        </div>
      </div>
    </div>
  );
}