import { useState } from 'react';

const SCENARIOS = [
  { id:'scenario-bridge-collapse', label:'Bridge Collapse', icon:'🌉', color:'#ff6b35', desc:'Yamuna Bridge collapses. AI reroutes all units.', badge:'AUTONOMY 25%' },
  { id:'scenario-mass-casualty',   label:'Mass Casualty',  icon:'🏥', color:'#ff3b5c', desc:'Building collapse, 25+ trapped. AI dispatches EMS.', badge:'TOOLS 20%' },
  { id:'scenario-power-outage',    label:'Grid Failure',   icon:'⚡', color:'#ffd700', desc:'Power out in Rohini + Shahdara. Multi-agency.', badge:'PLANNING 25%' },
  { id:'scenario-injection-attack',label:'Inject Attack',  icon:'🛡️', color:'#a855f7', desc:'Malicious 911 call. Watch firewall catch it live.', badge:'SECURITY 20%' },
];

export default function JudgePanel() {
  const [loading,  setLoading]  = useState(null);
  const [lastFired,setLastFired] = useState(null);

  async function trigger(id) {
    if (loading) return;
    setLoading(id);
    try {
      const r = await fetch(`/api/scenarios/trigger/${id}`, { method:'POST' });
      const d = await r.json();
      if (d.success) { setLastFired(id); setTimeout(()=>setLastFired(null),3000); }
    } catch {}
    finally { setLoading(null); }
  }

  async function reset() {
    if (loading) return;
    setLoading('reset');
    try { await fetch('/api/scenarios/reset',{method:'POST'}); } catch {}
    finally { setLoading(null); }
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', background:'var(--c-surface)', border:'1px solid var(--c-border)', borderRadius:'10px', overflow:'hidden' }}>

      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', gap:'8px', padding:'10px 14px', borderBottom:'1px solid rgba(255,255,255,0.05)', flexShrink:0 }}>
        <div style={{ width:7, height:7, borderRadius:'50%', background:'#ffd700', boxShadow:'0 0 6px #ffd700' }} />
        <span style={{ fontSize:'12px', fontWeight:'600', color:'#ffd700', letterSpacing:'0.08em', textTransform:'uppercase' }}>Scenario Triggers</span>
        <span style={{ marginLeft:'auto', fontSize:'10px', color:'#475569' }}>Click to inject</span>
      </div>

      {/* 2x2 grid */}
      <div style={{ flex:1, display:'grid', gridTemplateColumns:'1fr 1fr', gridTemplateRows:'1fr 1fr', gap:'6px', padding:'8px', minHeight:0 }}>
        {SCENARIOS.map(sc => {
          const active = lastFired === sc.id;
          const busy   = loading   === sc.id;
          return (
            <button
              key={sc.id}
              onClick={() => trigger(sc.id)}
              disabled={!!loading}
              style={{
                display:'flex', flexDirection:'column', alignItems:'flex-start',
                padding:'10px 12px', borderRadius:'8px',
                border:`1px solid ${active?sc.color:`${sc.color}45`}`,
                background: active?`${sc.color}18`:`${sc.color}08`,
                cursor: loading?'not-allowed':'pointer',
                opacity: loading&&!busy?0.5:1,
                boxShadow: active?`0 0 14px ${sc.color}40`:'none',
                transition:'all 0.15s', position:'relative',
                fontFamily:'inherit', textAlign:'left', width:'100%',
              }}
            >
              {busy && (
                <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(0,0,0,0.5)',borderRadius:'8px'}}>
                  <div style={{width:'16px',height:'16px',borderRadius:'50%',border:`2px solid ${sc.color}`,borderTopColor:'transparent',animation:'spin 0.7s linear infinite'}} />
                </div>
              )}
              {active && <span style={{position:'absolute',top:5,right:8,fontSize:'9px',fontWeight:'700',color:sc.color}}>FIRED</span>}

              <span style={{fontSize:'18px',marginBottom:'5px'}}>{sc.icon}</span>
              <span style={{fontSize:'11px',fontWeight:'700',color:sc.color,marginBottom:'3px',letterSpacing:'0.05em'}}>{sc.label}</span>
              <span style={{fontSize:'10px',color:'#64748b',lineHeight:1.4,flex:1,overflow:'hidden',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical'}}>{sc.desc}</span>
              <span style={{marginTop:'6px',fontSize:'9px',fontWeight:'700',padding:'2px 6px',borderRadius:'3px',color:sc.color,background:`${sc.color}18`,border:`1px solid ${sc.color}30`}}>{sc.badge}</span>
            </button>
          );
        })}
      </div>

      {/* Reset */}
      <div style={{ padding:'0 8px 8px', flexShrink:0 }}>
        <button
          onClick={reset}
          disabled={!!loading}
          style={{ width:'100%', padding:'7px 0', borderRadius:'6px', border:'1px solid rgba(100,116,139,0.2)', background:'transparent', color: loading==='reset'?'#00ff88':'#475569', fontSize:'11px', letterSpacing:'0.12em', cursor:loading?'not-allowed':'pointer', fontFamily:'inherit', transition:'color 0.2s' }}
        >
          {loading==='reset'?'↺  RESETTING...':'↺  Reset System'}
        </button>
      </div>
    </div>
  );
}