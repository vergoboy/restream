'use client';
import { useState } from 'react';
import { usePrefs } from '@/components/Prefs';
export default function Login() {
  const { t } = usePrefs();
  const [f, setF] = useState({ username: '', password: '' }), [err, setErr] = useState('');
  const go = async e => {
    e.preventDefault();
    const r = await fetch('/noisy/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(f) });
    if (r.ok) location.href = '/noisy/'; else setErr((await r.json().catch(() => ({}))).error);
  };
  return (
    <form onSubmit={go} className="card" style={{ maxWidth: 380, margin: '14vh auto 0', display: 'grid', gap: 12 }}>
      <h2 style={{ margin: 0 }}>{t('login')}</h2>
      <input placeholder={t('user')} autoComplete="username" value={f.username} onChange={e => setF({ ...f, username: e.target.value })} />
      <input type="password" placeholder={t('pass')} autoComplete="current-password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} />
      {err && <span style={{ color: 'var(--a2)' }}>{t(err)}</span>}
      <button className="btn pri">{t('login')}</button>
    </form>
  );
}
