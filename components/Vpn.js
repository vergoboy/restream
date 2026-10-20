'use client';
import { useState } from 'react';
import { usePrefs } from './Prefs';
import { line } from '@/lib/chart';
// Samples are tagged with the route that was active, so each VPN gets its own trace over time
export default function Vpn({ x, s, admin, reload }) {
  const { t } = usePrefs();
  const [wait, setWait] = useState(false), eg = x.egress || {}, routes = eg.routes || [];
  const col = r => `hsl(${(routes.indexOf(r) + 1) * 47} 85% 60%)`;
  const seen = [...new Set(s.map(p => p.route).filter(Boolean))];
  const max = Math.max(100, ...s.map(p => p.ping ?? 0)) * 1.2;
  const pick = async r => {
    setWait(true);
    await fetch('/restream/api/egress', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ route: r }) });
    setWait(false); reload();
  };
  return (
    <div className="card wide">
      <div className="row" style={{ justifyContent: 'space-between' }}><b>{t('vpn')}</b>{(wait || eg.busy) && <span className="k">{t('busy')}</span>}</div>
      <div className="row" style={{ margin: '10px 0' }}>
        {routes.map(r => (
          <button key={r} className={'chip' + (eg.route === r ? ' on' : '')} disabled={!admin || wait || eg.busy} onClick={() => pick(r)}
            style={{ borderInlineStartColor: col(r), borderInlineStartWidth: 4 }}>{r.replace('vpn-', '')}</button>
        ))}
      </div>
      <svg viewBox="0 0 640 120" style={{ width: '100%', height: 90, direction: 'ltr' }} preserveAspectRatio="none">
        {seen.map(r => <path key={r} fill="none" strokeWidth="2.5" stroke={col(r)} d={line(s.map(p => ({ v: p.route === r ? p.ping : null })), 'v', max)} />)}
      </svg>
    </div>
  );
}
