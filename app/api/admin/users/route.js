import { NextResponse } from 'next/server';
import db, { log } from '@/lib/db';
import { currentUser, hash, newKey, isJson, pub } from '@/lib/auth';
const admin = () => { const u = currentUser(); return u?.role === 'admin' ? u : null; };
const no = () => NextResponse.json({}, { status: 403 });
export const dynamic = 'force-dynamic';
export async function GET() {
  if (!admin()) return no();
  return NextResponse.json({ users: db.prepare('SELECT * FROM users').all().map(pub), logs: db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 100').all() });
}
export async function POST(req) {
  const a = admin();
  if (!a || !isJson(req)) return no();
  const b = await req.json().catch(() => ({}));
  const name = String(b.username || '').trim();
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(name) || String(b.password || '').length < 8) return NextResponse.json({ error: 'invalid' }, { status: 400 });
  try { db.prepare('INSERT INTO users(username,pw,ingest_key,quota_mb) VALUES(?,?,?,?)').run(name, hash(b.password), newKey(), Math.max(0, parseInt(b.quota_mb) || 0)); }
  catch { return NextResponse.json({ error: 'exists' }, { status: 409 }); }
  log(a.username, 'user_created', name);
  return NextResponse.json({ ok: true });
}
export async function PATCH(req) {
  const a = admin();
  if (!a || !isJson(req)) return no();
  const b = await req.json().catch(() => ({}));
  const id = parseInt(b.id);
  if ('quota_mb' in b) db.prepare('UPDATE users SET quota_mb=? WHERE id=?').run(Math.max(0, parseInt(b.quota_mb) || 0), id);
  if ('active' in b && id !== a.id) db.prepare('UPDATE users SET active=? WHERE id=?').run(b.active ? 1 : 0, id);
  log(a.username, 'user_updated', JSON.stringify({ id, ...b }));
  return NextResponse.json({ ok: true });
}
