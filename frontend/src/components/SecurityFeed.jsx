/*
 * Why changed: render the exact firewall payload fields and keep quarantine visibility even when persistence is delayed.
 * Security rationale: operators can see eventId, reason, matched text, explain steps, and persisted state directly from the live websocket feed.
 */
import { useWorldStore } from '../store/useWorldStore.js';

function ThreatBar({ score }) {
  const pct = (score / 10) * 100;
  const color = score >= 8 ? '#ff3b5c' : score >= 5 ? '#ff6b35' : '#ffd700';
  return (
    <div style={{ marginTop: '6px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
        <span style={{ fontSize: '9px', color: '#475569' }}>Threat level</span>
        <span style={{ fontSize: '10px', fontWeight: '700', color }}>{score.toFixed(1)} / 10</span>
      </div>
      <div style={{ height: '4px', background: 'rgba(255,255,255,0.06)', borderRadius: '2px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: `linear-gradient(90deg,${color}80,${color})`, borderRadius: '2px', transition: 'width 0.5s ease', boxShadow: `0 0 6px ${color}` }} />
      </div>
    </div>
  );
}

function EventMeta({ children }) {
  return <span style={{ fontSize: '9px', color: '#334155' }}>{children}</span>;
}

export default function SecurityFeed() {
  const feed = useWorldStore(state => state.securityFeed);
  const blockedEdges = useWorldStore(state => state.blockedEdges);

  const attacks = feed.filter(event => event.eventType === 'FIREWALL_BLOCK').length;
  const roads = blockedEdges.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--c-surface)', border: '1px solid var(--c-border)', borderRadius: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0 }}>
        <div style={{ width: 7, height: 7, borderRadius: '50%', background: attacks > 0 ? '#ff3b5c' : '#00d4ff', boxShadow: `0 0 6px ${attacks > 0 ? '#ff3b5c' : '#00d4ff'}` }} />
        <span style={{ fontSize: '12px', fontWeight: '600', color: 'var(--c-cyan)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Security</span>
        <span style={{ marginLeft: 'auto', fontSize: '11px', color: '#475569' }}>{feed.length} events</span>
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.04)', flexShrink: 0 }}>
        <div style={{ flex: 1, padding: '8px 12px', textAlign: 'center', borderRight: '1px solid rgba(255,255,255,0.04)' }}>
          <div style={{ fontSize: '18px', fontWeight: '700', color: attacks > 0 ? '#ff3b5c' : '#475569', lineHeight: 1 }}>{attacks}</div>
          <div style={{ fontSize: '9px', color: '#475569', marginTop: '2px' }}>Quarantines</div>
        </div>
        <div style={{ flex: 1, padding: '8px 12px', textAlign: 'center' }}>
          <div style={{ fontSize: '18px', fontWeight: '700', color: roads > 0 ? '#ff6b35' : '#475569', lineHeight: 1 }}>{roads}</div>
          <div style={{ fontSize: '9px', color: '#475569', marginTop: '2px' }}>Roads closed</div>
        </div>
      </div>

      {blockedEdges.length > 0 && (
        <div style={{ margin: '8px 8px 0', padding: '8px 10px', borderRadius: '6px', background: 'rgba(255,107,53,0.08)', border: '1px solid rgba(255,107,53,0.25)', flexShrink: 0 }}>
          <div style={{ fontSize: '11px', fontWeight: '600', color: '#ff6b35', marginBottom: '2px' }}>Active Road Closures</div>
          <div style={{ fontSize: '10px', color: '#64748b' }}>Edges blocked: {blockedEdges.join(', ')} - routing automatically avoids these</div>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {feed.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '10px', textAlign: 'center' }}>
            <div style={{ fontSize: '28px' }}>Shield</div>
            <div style={{ fontSize: '12px', color: '#475569' }}>All clear</div>
            <div style={{ fontSize: '10px', color: '#334155', lineHeight: 1.6 }}>Trigger an injection scenario to validate the firewall feed.</div>
          </div>
        )}

        {feed.map((event, index) => {
          if (event.eventType === 'FIREWALL_BLOCK') {
            return (
              <div key={event._key || index} style={{ borderRadius: '8px', border: '1px solid rgba(255,59,92,0.3)', background: 'rgba(255,59,92,0.06)', padding: '10px 12px', animation: 'slideIn 0.2s ease-out' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                  <span style={{ fontSize: '14px' }}>Shield</span>
                  <span style={{ fontSize: '11px', fontWeight: '700', color: '#ff3b5c' }}>THREAT QUARANTINED</span>
                  <span style={{ marginLeft: 'auto', fontSize: '10px', color: '#ff3b5c', background: 'rgba(255,59,92,0.12)', padding: '1px 6px', borderRadius: '3px', fontWeight: '700' }}>
                    {(event.threatScore || 0).toFixed(1)}/10
                  </span>
                </div>

                <div style={{ fontSize: '10px', color: '#94a3b8', lineHeight: 1.55, marginBottom: '6px' }}>
                  {event.message || 'Threat blocked before coordinator execution'}
                </div>

                <div style={{ fontSize: '10px', color: '#64748b', lineHeight: 1.6, display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  <span>Event: {event.eventId || 'unknown'}{event.zone ? ` - ${event.zone}` : ''}</span>
                  <span>Reason: {event.reason || 'No reason provided'}</span>
                  {event.matchedText && <span>Matched text: "{event.matchedText}"</span>}
                  {event.advice && <span>Advice: {event.advice}</span>}
                </div>

                {Array.isArray(event.explainSteps) && event.explainSteps.length > 0 && (
                  <div style={{ marginTop: '6px', paddingLeft: '14px', color: '#94a3b8', fontSize: '10px', lineHeight: 1.55 }}>
                    {event.explainSteps.map((step, stepIndex) => (
                      <div key={stepIndex}>{stepIndex + 1}. {step}</div>
                    ))}
                  </div>
                )}

                <ThreatBar score={event.threatScore || 0} />

                <div style={{ fontSize: '9px', color: '#334155', marginTop: '6px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {event.layer && <EventMeta>Layer {event.layer}</EventMeta>}
                  {event.latencyMs && <EventMeta>{event.latencyMs}ms</EventMeta>}
                  <EventMeta>{event.persisted ? 'persisted' : 'memory only'}</EventMeta>
                  {event.timestamp && <EventMeta>{new Date(event.timestamp).toLocaleTimeString()}</EventMeta>}
                </div>
              </div>
            );
          }

          if (event.eventType === 'FIREWALL_PASS') {
            return (
              <div key={event._key || index} style={{ borderRadius: '8px', border: '1px solid rgba(0,212,255,0.18)', background: 'rgba(0,212,255,0.04)', padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                  <span style={{ fontSize: '14px' }}>Check</span>
                  <span style={{ fontSize: '11px', fontWeight: '700', color: '#00d4ff' }}>EVENT CLEARED</span>
                  <span style={{ marginLeft: 'auto', fontSize: '10px', color: '#00d4ff' }}>{(event.threatScore || 0).toFixed(1)}/10</span>
                </div>
                <div style={{ fontSize: '10px', color: '#64748b', lineHeight: 1.55 }}>
                  {event.reasoning || event.message}
                </div>
              </div>
            );
          }

          if (event.eventType === 'ROAD_BLOCKED') {
            return (
              <div key={event._key || index} style={{ borderRadius: '8px', border: '1px solid rgba(255,107,53,0.3)', background: 'rgba(255,107,53,0.06)', padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '14px' }}>Road</span>
                  <span style={{ fontSize: '11px', fontWeight: '700', color: '#ff6b35' }}>ROAD CLOSED</span>
                </div>
                <div style={{ fontSize: '10px', color: '#64748b', marginTop: '4px' }}>
                  Edge {event.edgeId} blocked - all units automatically rerouted
                </div>
              </div>
            );
          }

          if (event.eventType === 'CITIZEN_ALERT') {
            return (
              <div key={event._key || index} style={{ borderRadius: '8px', border: '1px solid rgba(168,85,247,0.25)', background: 'rgba(168,85,247,0.05)', padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
                  <span style={{ fontSize: '14px' }}>Alert</span>
                  <span style={{ fontSize: '11px', fontWeight: '700', color: '#a855f7' }}>PUBLIC ALERT</span>
                  <span style={{ marginLeft: 'auto', fontSize: '9px', color: '#475569' }}>{event.zone}</span>
                </div>
                <div style={{ fontSize: '10px', color: '#64748b' }}>{event.message || event.description}</div>
              </div>
            );
          }

          return null;
        })}
      </div>
    </div>
  );
}
