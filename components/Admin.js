'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePrefs } from './Prefs';
const API = '/restream/api/admin/users', J = { 'content-type': 'application/json' };
const mb = b => (b / 1048576).toFixed(1);
export default function Admin() {
  const { t } = usePrefs();
  const [d, setD] = useState({ users: [], logs: [] }), empty = { username: '', password: '', quota_mb: 0 }, [f, setF] = useState(empty);
  const load = async () => { const r = await fetch(API); if (r.ok) setD(await r.json()); };
  useEffect(() => { load(); }, []);
  const send = async (method, body) => { await fetch(API, { method, headers: J, body: JSON.stringify(body) }); load(); };
  return (
    <div className="grid">
      <div className="card wide row" style={{ justifyContent: 'space-between' }}><b>{t('users')}</b><Link className="btn" href="/">{t('back')}</Link></div>
      <form className="card wide row" onSubmit={e => { e.preventDefault(); send('POST', f); setF(empty); }}>
        <input style={{ maxWidth: 180 }} placeholder={t('user')} value={f.username} onChange={e => setF({ ...f, username: e.target.value })} />
        <input style={{ maxWidth: 180 }} type="password" placeholder={t('pass')} value={f.password} onChange={e => setF({ ...f, password: e.target.value })} />
        <input style={{ maxWidth: 140 }} type="number" min="0" placeholder={t('quota') + ' (' + t('mb') + ')'} value={f.quota_mb} onChange={e => setF({ ...f, quota_mb: e.target.value })} />
        <button className="btn pri">{t('create')}</button>
      </form>
      <div className="card wide" style={{ overflowX: 'auto' }}>
        <table><thead><tr><th>{t('user')}</th><th>{t('role')}</th><th>↑ {t('sent')}</th><th>↓ {t('recv')}</th><th>{t('quota')} ({t('mb')})</th><th /></tr></thead>
          <tbody>{d.users.map(u => (
            <tr key={u.id}><td>{u.username}</td><td>{u.role}</td><td>{mb(u.used_out)}</td><td>{mb(u.used_in)}</td>
              <td><input style={{ maxWidth: 110 }} type="number" min="0" defaultValue={u.quota_mb} onBlur={e => send('PATCH', { id: u.id, quota_mb: e.target.value })} /></td>
              <td><button className={'chip' + (u.active ? ' on' : '')} onClick={() => send('PATCH', { id: u.id, active: !u.active })}>{u.active ? t('active') : t('off')}</button></td></tr>
          ))}</tbody></table>
      </div>
      <div className="card wide" style={{ overflowX: 'auto' }}>
        <b>{t('dests')}</b>
        <table><tbody>{(d.dests || []).map(x => (
          <tr key={x.id}><td>{x.username}</td><td>{x.name}</td><td><code>{x.url}</code> {x.key_hint}</td>
            <td><button className={'chip' + (x.active ? ' on' : '')} onClick={() => send('PATCH', { dest_id: x.id, dest_active: !x.active })}>{x.active ? t('active') : t('off')}</button></td>
            <td><button className="chip" onClick={() => send('DELETE', { dest_id: x.id })}>{t('del')}</button></td></tr>
        ))}</tbody></table>
      </div>
      <div className="card wide" style={{ overflowX: 'auto' }}>
        <b>{t('logs')}</b>
        <table><thead><tr><th>{t('time')}</th><th>{t('user')}</th><th>{t('event')}</th><th /></tr></thead>
          <tbody>{d.logs.map(l => <tr key={l.id}><td>{new Date(l.ts).toLocaleString()}</td><td>{l.user}</td><td>{l.event}</td><td className="k">{l.detail}</td></tr>)}</tbody></table>
      </div>
    </div>
  );
}
