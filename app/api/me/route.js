import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { currentUser, pub, isJson } from '@/lib/auth';
import { ring } from '@/lib/probe';
export const dynamic = 'force-dynamic';
export async function GET() {
  const u = currentUser();
  if (!u) return NextResponse.json({}, { status: 401 });
  return NextResponse.json({ me: pub(u), samples: ring });
}
export async function PATCH(req) {
  const u = currentUser();
  if (!u || !isJson(req)) return NextResponse.json({}, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const v = parseInt(b.bitrate_kbps);
  if (!v) return NextResponse.json({}, { status: 400 });
  db.prepare('UPDATE users SET bitrate_kbps=? WHERE id=?').run(Math.min(12000, Math.max(500, v)), u.id);
  return NextResponse.json({ ok: true });
}
