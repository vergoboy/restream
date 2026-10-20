import { NextResponse } from 'next/server';
import db, { log } from '@/lib/db';
import { currentUser, isJson } from '@/lib/auth';
import { seal } from '@/lib/vault';
import { parse, stopDest } from '@/lib/streams';
const bad = s => NextResponse.json({}, { status: s });
export async function POST(req) {
  const u = currentUser();
  if (!u || !isJson(req)) return bad(403);
  const b = await req.json().catch(() => ({}));
  const name = String(b.name || '').trim().slice(0, 40), url = String(b.url || '').trim(), key = String(b.key || '').trim();
  if (!name || !parse(url) || !/^[A-Za-z0-9_\-.?=&~%]{1,256}$/.test(key)) return bad(400);
  if (db.prepare('SELECT COUNT(*) c FROM destinations WHERE user_id=?').get(u.id).c >= 8) return bad(409);
  db.prepare('INSERT INTO destinations(user_id,name,url,key_enc,key_hint) VALUES(?,?,?,?,?)').run(u.id, name, url.replace(/\/+$/, ''), seal(key), '••••' + key.slice(-4));
  log(u.username, 'dest_added', name);
  return NextResponse.json({ ok: true });
}
export async function DELETE(req) {
  const u = currentUser();
  if (!u || !isJson(req)) return bad(403);
  const b = await req.json().catch(() => ({}));
  const d = db.prepare('SELECT * FROM destinations WHERE id=? AND user_id=?').get(parseInt(b.id), u.id);
  if (!d) return bad(404);
  await stopDest(d);
  db.prepare('DELETE FROM destinations WHERE id=?').run(d.id);
  log(u.username, 'dest_deleted', d.name);
  return NextResponse.json({ ok: true });
}
