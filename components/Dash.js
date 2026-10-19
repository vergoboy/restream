'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import anime from 'animejs';
import { usePrefs } from './Prefs';
const API = '/noisy/api', W = 640, H = 180;
// Suggested YouTube ingest bitrates (kbps)
const PRESETS = [['720p30', 2500], ['1080p30', 4500], ['1080p60', 6800]];
// Build an SVG path; null samples leave a gap
const line = (s, k, max) => s.map((p, i) => p[k] == null ? '' :
  `${i && s[i - 1][k] != null ? 'L' : 'M'}${(i / Math.max(1, s.length - 1) * W).toFixed(1)},${(H - 6 - Math.min(p[k], max) / max * (H - 12)).toFixed(1)}`).join('');
const mb = b => (b / 1048576).toFixed(1);
export default function Dash({ me: m0, ingest }) {
  const { t } = usePrefs();
  const [me, setMe] = useState(m0), [s, setS] = useState([]), [br, setBr] = useState(m0.bitrate_kbps), [msg, setMsg] = useState('');
  const root = useRef(null);
  useEffect(() => {
    let on = true;
    const tick = async () => { const r = await fetch(API + '/me'); if (r.ok && on) { const j = await r.json(); setMe(j.me); setS(j.samples); } };
    tick();
    const id = setInterval(tick, 5000);
    anime({ targets: root.current.querySelectorAll('.card'), translateY: [18, 0], opacity: [0, 1], delay: anime.stagger(80), easing: 'easeOutExpo' });
    anime({ targets: root.current.querySelectorAll('.pulse'), scale: [1, 2.4], opacity: [0.6, 0], duration: 1600, loop: true, easing: 'easeOutQuad' });
    return () => { on = false; clearInterval(id); };
  }, []);
  const last = s[s.length - 1], up = last && last.ping != null;
  const max = Math.max(100, ...s.map(p => p.ping ?? 0)) * 1.2;
  const pct = me.quota_mb ? Math.min(100, (me.used_in + me.used_out) / (me.quota_mb * 10485.76)) : 0;
  const save = async () => {
    const r = await fetch(API + '/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bitrate_kbps: br }) });
    setMsg(r.ok ? t('saved') : '!');
  };
  const out = async () => { await fetch(API + '/login', { method: 'DELETE' }); location.href = '/noisy/login'; };
  return (
    <div ref={root}>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 18 }}>
        <span className="row"><span className={'dot ' + (up ? 'up' : 'dn')}><i className="pulse" /></span><b>{me.username}</b><span className="k">{up ? t('up') : t('down')}</span></span>
        <span className="row">
          {me.role === 'admin' && <Link className="btn" href="/admin">{t('admin')}</Link>}
          <button className="btn" onClick={out}>{t('logout')}</button>
        </span>
      </div>
      <div className="grid">
        {[['ping', last?.ping, 'ms'], ['jitter', last?.jitter, 'ms'], ['loss', last?.loss, '%']].map(([k, v, u]) => (
          <div className="card" key={k}><div className="k">{t(k)}</div><div className="v">{v == null ? '—' : v.toFixed(1)}<small className="k"> {u}</small></div></div>
        ))}
        <div className="card wide">
          <div className="k">{t('trace')}</div>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', direction: 'ltr' }}>
            <path d={line(s, 'jitter', max) + (s.length ? `L${W},${H}L0,${H}Z` : '')} fill="var(--a1)" opacity=".18" />
            <path d={line(s, 'ping', max)} fill="none" stroke="var(--a3)" strokeWidth="2.4" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 6px var(--a3))' }} />
          </svg>
        </div>
        <div className="card">
          <div className="k">{t('traffic')}</div>
          <div className="row" style={{ justifyContent: 'space-between' }}><span>↑ {t('sent')}</span><b>{mb(me.used_out)} {t('mb')}</b></div>
          <div className="row" style={{ justifyContent: 'space-between' }}><span>↓ {t('recv')}</span><b>{mb(me.used_in)} {t('mb')}</b></div>
          <div className="meter"><i style={{ width: pct + '%' }} /></div>
          <div className="k">{t('quota')}: {me.quota_mb ? me.quota_mb + ' ' + t('mb') : t('unlimited')}</div>
        </div>
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div className="k">{t('bitrate')} (kbps)</div>
          <div className="row">
            <input type="number" min="500" max="12000" step="100" value={br} onChange={e => setBr(+e.target.value)} style={{ maxWidth: 140 }} />
            <button className="btn pri" onClick={save}>{t('save')}</button><span className="k">{msg}</span>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <span className="k">{t('suggested')}:</span>
            {PRESETS.map(([n, v]) => <button key={n} className={'chip' + (br === v ? ' on' : '')} onClick={() => setBr(v)}>{n} · {v}</button>)}
          </div>
        </div>
        <div className="card wide"><div className="k">{t('ingest')}</div><code>{ingest}/{me.ingest_key}</code></div>
      </div>
    </div>
  );
}
