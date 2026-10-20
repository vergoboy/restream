import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import db, { log } from '@/lib/db';
import { verify, newSession, rateLimited, fail, isJson } from '@/lib/auth';
export async function POST(req) {
  const ip = req.headers.get('x-real-ip') || 'local';
  if (!isJson(req)) return NextResponse.json({}, { status: 415 });
  if (rateLimited(ip)) return NextResponse.json({ error: 'rate' }, { status: 429 });
  const b = await req.json().catch(() => ({}));
  const u = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(String(b.username || ''));
  if (!u || !verify(String(b.password || ''), u.pw)) { fail(ip); log(b.username, 'login_fail', ip); return NextResponse.json({ error: 'bad' }, { status: 401 }); }
  const res = NextResponse.json({ ok: true });
  res.cookies.set('noisy_sid', newSession(u.id), { httpOnly: true, sameSite: 'strict', path: '/restream', secure: process.env.NOISY_SECURE_COOKIES === '1', maxAge: 43200 });
  log(u.username, 'login', ip);
  return res;
}
export async function DELETE() {
  const t = cookies().get('noisy_sid')?.value;
  if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(t);
  const res = NextResponse.json({ ok: true });
  res.cookies.set('noisy_sid', '', { path: '/restream', maxAge: 0 });
  return res;
}
