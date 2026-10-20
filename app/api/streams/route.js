import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { currentUser, isJson } from '@/lib/auth';
import { startDest, stopDest, parse } from '@/lib/streams';
import { rtt } from '@/lib/probe';
// action: start | stop | test, over several destination ids at once
export async function POST(req) {
  const u = currentUser();
  if (!u || !isJson(req)) return NextResponse.json({}, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Boolean).slice(0, 10), out = {};
  for (const id of ids) {
    const d = db.prepare('SELECT * FROM destinations WHERE id=? AND user_id=?').get(id, u.id);
    if (!d) continue;
    if (b.action === 'start') out[id] = await startDest(d, u);
    else if (b.action === 'stop') out[id] = await stopDest(d);
    else if (b.action === 'test') { const p = parse(d.url); out[id] = p ? await rtt(p.host, p.port) : null; }
  }
  return NextResponse.json({ out });
}
