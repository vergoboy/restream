import db, { log } from '@/lib/db';
import { onPublish } from '@/lib/streams';
// Called by nginx-rtmp on_publish. It MUST answer with an EMPTY 2xx body:
// a non-empty body is read as a redirect to another stream name.
async function gate(req) {
  // nginx-rtmp calls 127.0.0.1:18081 directly; anything proxied by the public
  // nginx carries X-Real-IP, so it is not the RTMP module and gets a 404.
  if (req.headers.get('x-real-ip')) return new Response(null, { status: 404 });
  let name = new URL(req.url).searchParams.get('name');
  if (!name && req.method === 'POST') name = new URLSearchParams(await req.text()).get('name');
  const u = name && db.prepare('SELECT * FROM users WHERE ingest_key=? AND active=1').get(name);
  const over = u && u.quota_mb > 0 && u.used_in + u.used_out >= u.quota_mb * 1048576;
  if (!u || over) { log(u?.username ?? '-', 'publish_denied', over ? 'quota' : 'bad key'); return new Response('', { status: 403 }); }
  log(u.username, 'publish_ok');
  onPublish(u.id);
  return new Response('', { status: 200 });
}
export const GET = gate, POST = gate;
