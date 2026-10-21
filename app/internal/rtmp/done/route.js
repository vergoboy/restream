import db, { log } from '@/lib/db';
import { onDone } from '@/lib/streams';
// nginx-rtmp on_publish_done: same loopback-only rule as the publish gate
async function done(req) {
  if (req.headers.get('x-real-ip')) return new Response(null, { status: 404 });
  let name = new URL(req.url).searchParams.get('name');
  if (!name && req.method === 'POST') name = new URLSearchParams(await req.text()).get('name');
  const u = name && db.prepare('SELECT * FROM users WHERE ingest_key=?').get(name);
  if (u) { log(u.username, 'publish_done'); onDone(u.id); }
  return new Response('', { status: 200 });
}
export const GET = done, POST = done;
