'use client';
import { useState } from 'react';
import { usePrefs } from './Prefs';
import { line } from '@/lib/chart';
const API = '/restream/api', J = { 'content-type': 'application/json' };
const host = u => { try { return new URL(u).host; } catch { return u; } };
export default function Dests({ x, reload }) {
  const { t } = usePrefs();
  const empty = { name: '', url: '', key: '' };
  const [sel, setSel] = useState([]), [f, setF] = useState(empty), [err, setErr] = useState(''), [tests, setTests] = useState({});
  const post = (p, method, body) => fetch(API + p, { method, headers: J, body: JSON.stringify(body) });
  const add = async e => {
    e.preventDefault();
    const r = await post('/destinations', 'POST', f);
    if (r.ok) { setF(empty); setErr(''); reload(); } else setErr(t('invalid'));
  };
  const act = async a => { const j = await (await post('/streams', 'POST', { action: a, ids: sel })).json().catch(() => ({})); setErr(Object.values(j.out || {}).includes(false) ? t('startfail') : ''); reload(); };
  const test = async id => { const j = await (await post('/streams', 'POST', { action: 'test', ids: [id] })).json(); setTests(p => ({ ...p, [id]: j.out?.[id] ?? false })); };
  const del = async id => { await post('/destinations', 'DELETE', { id }); setSel(s => s.filter(i => i !== id)); reload(); };
  const tog = id => setSel(s => s.includes(id) ? s.filter(i => i !== id) : [...s, id]);
  return (
    <div className="card wide">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>{t('dests')}</b>
        <span className="row">
          <button className="btn pri" disabled={!sel.length} onClick={() => act('start')}>{t('start')}</button>
          <button className="btn" disabled={!sel.length} onClick={() => act('stop')}>{t('stop')}</button>
        </span>
      </div>
      <form className="row" style={{ margin: '12px 0' }} onSubmit={add}>
        <input style={{ maxWidth: 150 }} placeholder={t('name')} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} />
        <input style={{ maxWidth: 280, direction: 'ltr' }} placeholder="rtmp://a.rtmp.youtube.com/live2" value={f.url} onChange={e => setF({ ...f, url: e.target.value })} />
        <input style={{ maxWidth: 200, direction: 'ltr' }} type="password" autoComplete="off" placeholder={t('skey')} value={f.key} onChange={e => setF({ ...f, key: e.target.value })} />
        <button className="btn">{t('add')}</button>{err && <span style={{ color: 'var(--a2)' }}>{err}</span>}
      </form>
      {x.dests.map(d => {
        const h = x.hist[d.id] || [], last = h[h.length - 1], tr = tests[d.id];
        const pm = Math.max(100, ...h.map(p => p.ping ?? 0)) * 1.2, km = Math.max(1000, ...h.map(p => p.kbps ?? 0)) * 1.2;
        return (
          <div key={d.id} className="row" style={{ padding: '10px 0', borderTop: '1px solid var(--bd)', justifyContent: 'space-between' }}>
            <label className="row" style={{ minWidth: 220 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={sel.includes(d.id)} disabled={!d.active} onChange={() => tog(d.id)} />
              <span><b>{d.name}</b><br /><span className="k" dir="ltr">{host(d.url)} · {d.key_hint}</span></span>
            </label>
            <span className="k" style={{ minWidth: 120 }}>
              <span className={'dot ' + (d.want && last?.exec === 'running' ? 'up' : 'dn')} /> {d.want ? (last?.exec ?? '…') : t('idle')}{d.want && last?.err && last.exec !== 'running' && <><br /><span dir="ltr" style={{ color: 'var(--a2)' }}>{last.err}</span></>}
              {last?.kbps != null && <><br />{Math.round(last.kbps)} kbps · {last.ping != null ? last.ping.toFixed(0) + ' ms' : '—'}</>}
            </span>
            <svg viewBox="0 0 640 120" style={{ flex: 1, minWidth: 160, maxWidth: 360, height: 48, direction: 'ltr' }} preserveAspectRatio="none">
              <path d={line(h, 'kbps', km)} fill="none" stroke="var(--a1)" strokeWidth="3" />
              <path d={line(h, 'ping', pm)} fill="none" stroke="var(--a3)" strokeWidth="3" />
            </svg>
            <span className="row">
              {tr !== undefined && <span className="k">{tr ? tr.ping?.toFixed(0) + ' ms / ' + tr.loss + '%' : '✕'}</span>}
              <button className="chip" onClick={() => test(d.id)}>{t('test')}</button>
              <button className="chip" onClick={() => del(d.id)}>{t('del')}</button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
