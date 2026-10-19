import { execFile } from 'node:child_process';
// Ring buffer of tunnel RTT samples, one every 5s (~1h of history)
export const ring = globalThis.__ring ??= [];
function sample() {
  execFile('sudo', ['-n', '/opt/noisy/scripts/egress-ping'], { timeout: 15000 }, (_e, out) => {
    let r = [];
    try { r = JSON.parse(out).rtts; } catch {}
    const ok = r.filter(x => x != null);
    let j = null;
    if (ok.length > 1) { let s = 0; for (let i = 1; i < ok.length; i++) s += Math.abs(ok[i] - ok[i - 1]); j = s / (ok.length - 1); }
    ring.push({ t: Date.now(), ping: ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null, jitter: j, loss: r.length ? 100 * (r.length - ok.length) / r.length : 100 });
    if (ring.length > 720) ring.shift();
  });
}
export function startSampler() { if (!globalThis.__sampler) { globalThis.__sampler = setInterval(sample, 5000); sample(); } }
