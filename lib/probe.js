import { execFile } from 'node:child_process';
import { state } from './egress';
// Global tunnel ring: one sample every 5s, tagged with the active VPN route
export const ring = globalThis.__ring ??= [];
// Five TCP connects to host:port from inside the restreamer's netns (i.e. through the tunnel)
export const rtt = (host = '1.1.1.1', port = 443) => new Promise(res =>
  execFile('sudo', ['-n', '/opt/noisy/scripts/egress-ping', host, String(port)], { timeout: 20000 }, (_e, out) => {
    let r = [];
    try { r = JSON.parse(out).rtts; } catch {}
    const ok = r.filter(x => x != null);
    let j = null;
    if (ok.length > 1) { let s = 0; for (let i = 1; i < ok.length; i++) s += Math.abs(ok[i] - ok[i - 1]); j = s / (ok.length - 1); }
    res({ t: Date.now(), ping: ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null, jitter: j, loss: r.length ? 100 * (r.length - ok.length) / r.length : 100 });
  }));
export function startSampler() {
  if (globalThis.__sampler) return;
  let busy = false;
  const f = async () => {
    if (busy) return; busy = true;
    const x = await rtt();
    ring.push({ ...x, route: state.route }); if (ring.length > 720) ring.shift();
    busy = false;
  };
  globalThis.__sampler = setInterval(f, 15000); f();
}
