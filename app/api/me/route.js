import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { currentUser, pub, isJson } from '@/lib/auth';
import { ring } from '@/lib/probe';
import { hist } from '@/lib/streams';
import { state, ROUTES } from '@/lib/egress';
export const dynamic = 'force-dynamic';
export async function GET() {
  const u = currentUser();
  if (!u) return NextResponse.json({}, { status: 401 });
  const dests = db.prepare('SELECT id,name,url,key_hint,want,active FROM destinations WHERE user_id=?').all(u.id);
  return NextResponse.json({ me: pub(u), samples: ring, dests, hist: Object.fromEntries(dests.map(d => [d.id, hist.get(d.id) ?? []])),
    egress: { route: state.route, busy: state.busy, routes: ROUTES } });
}
export async function PATCH(req) {
  const u = currentUser();
  if (!u || !isJson(req)) return NextResponse.json({}, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const v = parseInt(b.bitrate_kbps);
  if (!v) return NextResponse.json({}, { status: 400 });
  db.prepare('UPDATE users SET bitrate_kbps=?, reencode=? WHERE id=?').run(Math.min(12000, Math.max(500, v)), b.reencode ? 1 : 0, u.id);
  return NextResponse.json({ ok: true });
}
