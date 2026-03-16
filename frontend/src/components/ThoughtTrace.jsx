import { useRef, useEffect } from 'react';
import { useWorldStore } from '../store/useWorldStore.js';

const TOOL_READABLE = {
  getAvailableUnits:      '🔍 Checked available units',
  getRoute:               '📍 Calculated fastest route',
  blockRoad:              '🚧 Closed blocked road',
  dispatchUnit:           '🚀 Dispatched unit to scene',
  returnUnit:             '↩️  Recalled unit to base',
  notifyCitizens:         '📢 Broadcast public alert',
  getHospitalCapacity:    '🏥 Checked hospital beds',
  updateHospitalCapacity: '🏥 Updated hospital intake',
  getWeather:             '🌬️  Read wind & fire spread data',
};

function toolLabel(name) {
  return TOOL_READABLE[name] || `→ ${name}`;
}

function priorityBadge(priority) {
  if (priority >= 9) return { label: 'CRITICAL', bg: 'rgba(255,59,92,0.15)',  color: '#ff3b5c' };
  if (priority >= 7) return { label: 'HIGH',     bg: 'rgba(255,107,53,0.12)', color: '#ff6b35' };
  if (priority >= 5) return { label: 'MEDIUM',   bg: 'rgba(255,215,0,0.1)',   color: '#ffd700' };
  return               { label: 'LOW',      bg: 'rgba(0,212,255,0.08)',   color: '#00d4ff' };
}

function eventTypeLabel(type) {
  return (type || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function zoneLabel(zone) {
  const map = { CP:'Connaught Place',RP:'Rajpath',KB:'Karol Bagh',LN:'Lajpat Nagar',DW:'Dwarka',RH:'Rohini',SD:'Shahdara',NP:'Nehru Place',IGI:'IGI Airport',OKH:'Okhla' };
  return map[zone] || zone;
}

// ─── Active Thought — the big live card ──────────────────────────────────────

function ActiveCard({ thought }) {
  const scrollRef = useRef(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [thought.tokens]);

  const dispatched = thought.toolCalls.filter(tc => tc.tool === 'dispatchUnit' && tc.result?.success);
  const hasFailed  = thought.toolCalls.some(tc => tc.result?.success === false);

  return (
    <div style={{ border: '1px solid rgba(0,255,136,0.25)', borderRadius: '10px', background: 'rgba(0,255,136,0.03)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', background: 'rgba(0,0,0,0.2)', borderBottom: '1px solid rgba(0,255,136,0.1)' }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#00ff88', boxShadow: '0 0 8px #00ff88', animation: 'pulse 0.8s ease-in-out infinite', flexShrink: 0 }} />
        <span style={{ fontSize: '13px', fontWeight: '600', color: '#00ff88' }}>AI is thinking now</span>
        <span style={{ fontSize: '11px', color: '#475569', marginLeft: 'auto' }}>
          {thought.toolCalls.length > 0 && `${thought.toolCalls.length} action${thought.toolCalls.length > 1 ? 's' : ''} so far`}
        </span>
      </div>

      {/* Streaming text */}
      <div
        ref={scrollRef}
        style={{ padding: '12px 14px', maxHeight: '220px', overflowY: 'auto', fontFamily: 'var(--font-mono)', fontSize: '12px', color: '#94a3b8', lineHeight: 1.8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
      >
        {thought.tokens || 'Starting analysis...'}
        <span style={{ color: '#00ff88', animation: 'blink 1s step-end infinite' }}>▊</span>
      </div>

      {/* Tool calls so far */}
      {thought.toolCalls.length > 0 && (
        <div style={{ padding: '0 14px 12px', display: 'flex', flexDirection: 'column', gap: '4px', borderTop: '1px solid rgba(255,255,255,0.04)', paddingTop: '10px' }}>
          <div style={{ fontSize: '10px', fontWeight: '600', color: '#475569', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '2px' }}>Actions taken</div>
          {thought.toolCalls.map((tc, i) => {
            const ok = tc.result?.success !== false;
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', padding: '4px 8px', borderRadius: '5px', background: ok ? 'rgba(234,179,8,0.06)' : 'rgba(239,68,68,0.06)' }}>
                <span style={{ color: ok ? '#fbbf24' : '#f87171', flex: 1 }}>{toolLabel(tc.tool)}</span>
                {tc.result?.message && <span style={{ fontSize: '10px', color: '#475569', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tc.result.message}</span>}
                <span style={{ color: ok ? '#22c55e' : '#ef4444', flexShrink: 0 }}>{ok ? '✓' : '✗'}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── History pill — compact summary of a completed thought ───────────────────

function HistoryPill({ thought }) {
  const dispatched = thought.toolCalls.filter(tc => tc.tool === 'dispatchUnit' && tc.result?.success).length;
  const type = (thought.tokens.match(/Type: ([^\n]+)/) || [])[1]?.trim();
  const zone = (thought.tokens.match(/Zone: ([^\s|]+)/) || [])[1]?.trim();

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 12px', borderRadius: '6px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
      <span style={{ fontSize: '13px' }}>🧠</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '11px', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {type && zone ? `${type} — ${zoneLabel(zone)}` : 'Incident handled'}
        </div>
      </div>
      <div style={{ display: 'flex', align: 'center', gap: '6px', flexShrink: 0 }}>
        {dispatched > 0 && (
          <span style={{ fontSize: '10px', color: '#00ff88', background: 'rgba(0,255,136,0.1)', padding: '1px 6px', borderRadius: '10px' }}>
            {dispatched} unit{dispatched > 1 ? 's' : ''} sent
          </span>
        )}
        <span style={{ fontSize: '10px', color: '#22c55e' }}>✓ done</span>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ThoughtTrace() {
  const activeThought  = useWorldStore(s => s.activeThought);
  const thoughtHistory = useWorldStore(s => s.thoughtHistory);

  const isEmpty = !activeThought && thoughtHistory.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--c-surface)', border: '1px solid var(--c-border)', borderRadius: '10px' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0 }}>
        <div style={{ width: 7, height: 7, borderRadius: '50%', background: activeThought ? '#00ff88' : '#00d4ff', boxShadow: `0 0 6px ${activeThought ? '#00ff88' : '#00d4ff'}`, ...(activeThought ? { animation: 'pulse 0.8s ease-in-out infinite' } : {}) }} />
        <span style={{ fontSize: '12px', fontWeight: '600', color: 'var(--c-cyan)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>AI Thought Stream</span>
        {activeThought && <span style={{ marginLeft: 'auto', fontSize: '11px', color: '#00ff88', fontWeight: '600' }}>● LIVE</span>}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>

        {isEmpty && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '12px', textAlign: 'center' }}>
            <div style={{ fontSize: '36px' }}>🧠</div>
            <div style={{ fontSize: '13px', color: '#475569' }}>Waiting for an emergency</div>
            <div style={{ fontSize: '11px', color: '#334155', lineHeight: 1.7 }}>
              Go to <strong style={{ color: '#64748b' }}>Control Room</strong> tab<br />
              and trigger a scenario to watch<br />
              the AI think live
            </div>
          </div>
        )}

        {/* Active thought — always on top */}
        {activeThought && <ActiveCard thought={activeThought} />}

        {/* History — compact pills */}
        {thoughtHistory.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {activeThought && (
              <div style={{ fontSize: '10px', color: '#334155', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '4px 0 2px' }}>Previous</div>
            )}
            {thoughtHistory.map((t, i) => <HistoryPill key={i} thought={t} />)}
          </div>
        )}
      </div>
    </div>
  );
}