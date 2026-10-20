import { NextResponse } from 'next/server';
import { log } from '@/lib/db';
import { currentUser, isJson } from '@/lib/auth';
import { setRoute } from '@/lib/egress';
// Admin only: the VPN exit is shared by every destination
export async function POST(req) {
  const u = currentUser();
  if (u?.role !== 'admin' || !isJson(req)) return NextResponse.json({}, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const ok = await setRoute(String(b.route));
  log(u.username, ok ? 'route_set' : 'route_failed', b.route);
  return NextResponse.json({ ok });
}
