import { useWorldStore } from '../store/useWorldStore.js';

function ThreatBar({ score }) {
  const pct   = (score / 10) * 100;
  const color = score >= 8 ? '#ff3b5c' : score >= 5 ? '#ff6b35' : '#ffd700';
  return (
    <div style={{ marginTop:'6px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'3px' }}>
        <span style={{ fontSize:'9px', color:'#475569' }}>Threat level</span>
        <span style={{ fontSize:'10px', fontWeight:'700', color }}>{score.toFixed(1)} / 10</span>
      </div>
      <div style={{ height:'4px', background:'rgba(255,255,255,0.06)', borderRadius:'2px', overflow:'hidden' }}>
        <div style={{ height:'100%', width:`${pct}%`, background:`linear-gradient(90deg,${color}80,${color})`, borderRadius:'2px', transition:'width 0.5s ease', boxShadow:`0 0 6px ${color}` }} />
      </div>
    </div>
  );
}

export default function SecurityFeed() {
  const feed         = useWorldStore(s => s.securityFeed);
  const blockedEdges = useWorldStore(s => s.blockedEdges);

  const attacks = feed.filter(e => e.eventType === 'FIREWALL_BLOCK').length;
  const roads   = blockedEdges.length;

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden', background:'var(--c-surface)', border:'1px solid var(--c-border)', borderRadius:'10px' }}>

      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', gap:'8px', padding:'10px 14px', borderBottom:'1px solid rgba(255,255,255,0.05)', flexShrink:0 }}>
        <div style={{ width:7, height:7, borderRadius:'50%', background: attacks>0?'#ff3b5c':'#00d4ff', boxShadow:`0 0 6px ${attacks>0?'#ff3b5c':'#00d4ff'}` }} />
        <span style={{ fontSize:'12px', fontWeight:'600', color:'var(--c-cyan)', letterSpacing:'0.08em', textTransform:'uppercase' }}>Security</span>
        <span style={{ marginLeft:'auto', fontSize:'11px', color:'#475569' }}>{feed.length} events</span>
      </div>

      {/* Quick stats */}
      <div style={{ display:'flex', borderBottom:'1px solid rgba(255,255,255,0.04)', flexShrink:0 }}>
        <div style={{ flex:1, padding:'8px 12px', textAlign:'center', borderRight:'1px solid rgba(255,255,255,0.04)' }}>
          <div style={{ fontSize:'18px', fontWeight:'700', color: attacks>0?'#ff3b5c':'#475569', lineHeight:1 }}>{attacks}</div>
          <div style={{ fontSize:'9px', color:'#475569', marginTop:'2px' }}>Attacks blocked</div>
        </div>
        <div style={{ flex:1, padding:'8px 12px', textAlign:'center' }}>
          <div style={{ fontSize:'18px', fontWeight:'700', color: roads>0?'#ff6b35':'#475569', lineHeight:1 }}>{roads}</div>
          <div style={{ fontSize:'9px', color:'#475569', marginTop:'2px' }}>Roads closed</div>
        </div>
      </div>

      {/* Blocked roads banner */}
      {blockedEdges.length > 0 && (
        <div style={{ margin:'8px 8px 0', padding:'8px 10px', borderRadius:'6px', background:'rgba(255,107,53,0.08)', border:'1px solid rgba(255,107,53,0.25)', flexShrink:0 }}>
          <div style={{ fontSize:'11px', fontWeight:'600', color:'#ff6b35', marginBottom:'2px' }}>🚧 Active Road Closures</div>
          <div style={{ fontSize:'10px', color:'#64748b' }}>Edges blocked: {blockedEdges.join(', ')} — routing automatically avoids these</div>
        </div>
      )}

      {/* Events */}
      <div style={{ flex:1, overflowY:'auto', padding:'8px', display:'flex', flexDirection:'column', gap:'6px' }}>
        {feed.length === 0 && (
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:'10px', textAlign:'center' }}>
            <div style={{fontSize:'28px'}}>🛡️</div>
            <div style={{fontSize:'12px',color:'#475569'}}>All clear</div>
            <div style={{fontSize:'10px',color:'#334155',lineHeight:1.6}}>Try "Inject Attack" in<br/>Control Room to see<br/>the firewall in action</div>
          </div>
        )}

        {feed.map((ev, i) => {
          if (ev.eventType === 'FIREWALL_BLOCK') {
            return (
              <div key={i} style={{ borderRadius:'8px', border:'1px solid rgba(255,59,92,0.3)', background:'rgba(255,59,92,0.06)', padding:'10px 12px', animation:'slideIn 0.2s ease-out' }}>
                <div style={{ display:'flex', alignItems:'center', gap:'8px', marginBottom:'4px' }}>
                  <span style={{fontSize:'14px'}}>🛡️</span>
                  <span style={{fontSize:'11px',fontWeight:'700',color:'#ff3b5c'}}>ATTACK BLOCKED</span>
                  <span style={{marginLeft:'auto',fontSize:'10px',color:'#ff3b5c',background:'rgba(255,59,92,0.12)',padding:'1px 6px',borderRadius:'3px',fontWeight:'700'}}>
                    {ev.threatScore}/10
                  </span>
                </div>
                <div style={{fontSize:'10px',color:'#64748b',lineHeight:1.5,marginBottom:'4px'}}>
                  {ev.layer === 1
                    ? 'Caught instantly by pattern matching — injection phrase detected'
                    : 'Caught by AI threat scorer — content analysis flagged this as adversarial'}
                </div>
                {ev.reason && <div style={{fontSize:'10px',color:'#475569',fontStyle:'italic',marginBottom:'4px'}}>{ev.reason.slice(0,80)}</div>}
                <ThreatBar score={ev.threatScore || 0} />
                <div style={{fontSize:'9px',color:'#334155',marginTop:'4px',display:'flex',gap:'8px'}}>
                  {ev.layer&&<span>Layer {ev.layer} defense</span>}
                  {ev.latencyMs&&<span>· {ev.latencyMs}ms</span>}
                  {ev.timestamp&&<span>· {new Date(ev.timestamp).toLocaleTimeString()}</span>}
                </div>
              </div>
            );
          }

          if (ev.eventType === 'ROAD_BLOCKED') {
            return (
              <div key={i} style={{ borderRadius:'8px', border:'1px solid rgba(255,107,53,0.3)', background:'rgba(255,107,53,0.06)', padding:'10px 12px', animation:'slideIn 0.2s ease-out' }}>
                <div style={{display:'flex',alignItems:'center',gap:'8px'}}>
                  <span style={{fontSize:'14px'}}>🚧</span>
                  <span style={{fontSize:'11px',fontWeight:'700',color:'#ff6b35'}}>ROAD CLOSED</span>
                  <span style={{marginLeft:'auto',fontSize:'9px',color:'#475569'}}>{new Date(ev._key||Date.now()).toLocaleTimeString()}</span>
                </div>
                <div style={{fontSize:'10px',color:'#64748b',marginTop:'4px'}}>
                  Edge {ev.edgeId} blocked — all units automatically rerouted
                </div>
              </div>
            );
          }

          if (ev.eventType === 'CITIZEN_ALERT') {
            return (
              <div key={i} style={{ borderRadius:'8px', border:'1px solid rgba(168,85,247,0.25)', background:'rgba(168,85,247,0.05)', padding:'10px 12px' }}>
                <div style={{display:'flex',alignItems:'center',gap:'8px',marginBottom:'3px'}}>
                  <span style={{fontSize:'14px'}}>📢</span>
                  <span style={{fontSize:'11px',fontWeight:'700',color:'#a855f7'}}>PUBLIC ALERT</span>
                  <span style={{marginLeft:'auto',fontSize:'9px',color:'#475569'}}>{ev.zone}</span>
                </div>
                <div style={{fontSize:'10px',color:'#64748b'}}>{ev.message||ev.description}</div>
              </div>
            );
          }

          return null;
        })}
      </div>
    </div>
  );
}