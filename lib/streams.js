import db, { log } from './db';
import { open } from './vault';
import { core } from './core';
import { rtt } from './probe';
// Per-destination history: { t, kbps, ping, jitter, exec }
export const hist = globalThis.__hist ??= new Map();
const pid = id => 'rs-' + id;
// Accept rtmp(s) URLs to public hosts only: the probe and ffmpeg run inside the tunnel netns
export function parse(url) {
  let u; try { u = new URL(url); } catch { return null; }
  const h = u.hostname;
  if (!['rtmp:', 'rtmps:'].includes(u.protocol) || h === 'localhost' || h.endsWith('.local') || h.includes(':') ||
      /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(h) || !/^[A-Za-z0-9.-]+$/.test(h)) return null;
  return { host: h, port: +u.port || (u.protocol === 'rtmps:' ? 443 : 1935) };
}
// ffmpeg log lines can contain the full output URL: strip everything after the app path
const clean = l => l ? String(l).replace(/(rtmps?:\/\/[^/\s]+\/[^/\s]*\/)\S+/g, '$1…').slice(0, 160) : null;
function config(d, u) {
  const k = u.bitrate_kbps;
  // -c copy costs no CPU; re-encoding is opt-in because it multiplies per destination
  const out = u.reencode
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', k + 'k', '-maxrate', k + 'k', '-bufsize', 2 * k + 'k', '-g', '60', '-c:a', 'aac', '-b:a', '128k', '-f', 'flv']
    : ['-c', 'copy', '-f', 'flv'];
  const e = process.env;
  return { id: pid(d.id), reference: 'user-' + u.id, type: 'ffmpeg',
    input: [{ id: 'in', address: `rtmp://${e.NOISY_NGINX_RTMP_HOST || '172.28.240.1'}:${e.NOISY_INGEST_PORT || 19350}/${e.NOISY_INGEST_APP || 'noisy'}/${u.ingest_key}`, options: [] }],
    output: [{ id: 'out', address: `${d.url.replace(/\/+$/, '')}/${open(d.key_enc)}`, options: out }],
    options: ['-loglevel', 'level+error'], autostart: true, reconnect: true,
    // 15s: every failed attempt leaks a zombie in the core (see README), so retry slowly
    reconnect_delay_seconds: 15, stale_timeout_seconds: 30 };
}
const drop = async d => { await core('PUT', `/api/v3/process/${pid(d.id)}/command`, { command: 'stop' }); await core('DELETE', `/api/v3/process/${pid(d.id)}`); };
const over = u => u.quota_mb > 0 && u.used_in + u.used_out >= u.quota_mb * 1048576;
export async function startDest(d, u0) {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(u0.id);
  const why = !d.active ? 'inactive' : !parse(d.url) ? 'bad url' : over(u) ? 'quota' : null;
  if (why) { log(u.username, 'start_skipped', `${d.name}: ${why}`); return false; }
  db.prepare('UPDATE destinations SET want=1 WHERE id=?').run(d.id);
  // No live publisher: ffmpeg would only fail and retry (leaking a zombie per attempt). Arm it and wait for OBS.
  if (!u.publishing) { log(u.username, 'stream_armed', d.name); return true; }
  return launch(d, u);
}
async function launch(d, u) {
  let cfg;
  try { cfg = config(d, u); } catch (e) { log(u.username, 'start_failed', `${d.name} config: ${e.message}`); return false; }
  await drop(d);
  const r = await core('POST', '/api/v3/process', cfg);
  if (!r.ok) { log(u.username, 'start_failed', `${d.name} core ${r.status} ${r.error || ''}`); db.prepare('UPDATE destinations SET want=0 WHERE id=?').run(d.id); return false; }
  db.prepare('UPDATE destinations SET last_in=0,last_out=0 WHERE id=?').run(d.id);
  log(u.username, 'stream_start', d.name);
  return true;
}
export async function stopDest(d) {
  await drop(d);
  db.prepare('UPDATE destinations SET want=0 WHERE id=?').run(d.id);
  log('-', 'stream_stop', d.name);
  return true;
}
export async function stopById(id) { const d = db.prepare('SELECT * FROM destinations WHERE id=?').get(id); if (d) await stopDest(d); }

let busy = false;
async function tick() {
  if (busy) return; busy = true;
  try {
    const rows = db.prepare('SELECT * FROM destinations WHERE want=1').all(), use = new Map();
    for (const d of rows) {
      const r = await core('GET', `/api/v3/process/${pid(d.id)}/state`);
      const s = r.ok ? await r.json() : {}, p = s.progress || {};
      const o = (p.output?.[0]?.size_kb ?? 0) * 1024, i = (p.input?.[0]?.size_kb ?? 0) * 1024;
      // A reconnect resets the counters: a drop means "start again from zero"
      const dO = o >= d.last_out ? o - d.last_out : o, dI = i >= d.last_in ? i - d.last_in : i;
      db.prepare('UPDATE destinations SET last_in=?,last_out=? WHERE id=?').run(i, o, d.id);
      // Outgoing bytes add up per destination; the single ingest is counted once
      const a = use.get(d.user_id) ?? { o: 0, i: 0 }; a.o += dO; a.i = Math.max(a.i, dI); use.set(d.user_id, a);
      const dest = parse(d.url), x = dest && r.ok ? await rtt(dest.host, dest.port) : {};
      const h = hist.get(d.id) ?? []; hist.set(d.id, h);
      h.push({ t: Date.now(), kbps: p.output?.[0]?.bitrate_kbit ?? null, ping: x.ping ?? null, jitter: x.jitter ?? null, exec: r.ok ? (s.exec ?? 'unknown') : 'waiting', err: clean(s.last_logline) });
      if (h.length > 360) h.shift();
    }
    for (const [uid, a] of use) {
      db.prepare('UPDATE users SET used_out=used_out+?, used_in=used_in+? WHERE id=?').run(Math.round(a.o), Math.round(a.i), uid);
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
      if (over(u)) { for (const d of rows.filter(x => x.user_id === uid)) await stopDest(d); log(u.username, 'quota_stop'); }
    }
  } finally { busy = false; }
}
export function startMeter() { if (!globalThis.__meter) globalThis.__meter = setInterval(() => tick().catch(() => {}), 5000); }

// Publish events from nginx-rtmp: processes only exist while OBS is actually publishing
const timers = globalThis.__doneTimers ??= new Map();
export function onPublish(uid) {
  clearTimeout(timers.get(uid));
  db.prepare('UPDATE users SET publishing=1 WHERE id=?').run(uid);
  // on_publish fires before nginx registers the stream; ffmpeg waits for it, but give it a moment
  setTimeout(async () => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
    for (const d of db.prepare('SELECT * FROM destinations WHERE user_id=? AND want=1 AND active=1').all(uid)) if (!over(u)) await launch(d, u);
  }, 1500);
}
export function onDone(uid) {
  db.prepare('UPDATE users SET publishing=0 WHERE id=?').run(uid);
  // Grace period: a quick OBS reconnect must not tear the processes down
  clearTimeout(timers.get(uid));
  timers.set(uid, setTimeout(async () => {
    if (db.prepare('SELECT publishing FROM users WHERE id=?').get(uid)?.publishing) return;
    for (const d of db.prepare('SELECT * FROM destinations WHERE user_id=? AND want=1').all(uid)) await drop(d);
  }, 8000));
}
