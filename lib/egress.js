import { execFile } from 'node:child_process';
export const ROUTES = ['vpn-hysteria2', 'vpn-grpc', 'vpn-reality', 'vpn-httpupgrade', 'vpn-xhttp', 'vpn-httpobf', 'vpn-xray'];
export const state = globalThis.__eg ??= { route: null, busy: false };
const run = (args, ms) => new Promise(res => execFile('sudo', ['-n', ...args], { timeout: ms }, (e, out) => res({ ok: !e, out: String(out) })));
// Read the live primary route once at boot; later changes go through setRoute
export async function refresh() {
  const m = (await run(['/opt/noisy/scripts/egress-status'], 40000)).out.match(/primary route\s*:\s*(\S+)/);
  if (m) state.route = m[1];
}
// egress-set restarts noisy-egress: running streams reconnect on their own
export async function setRoute(route) {
  if (!ROUTES.includes(route) || state.busy) return false;
  state.busy = true;
  const r = await run(['/opt/noisy/scripts/egress-set', route], 60000);
  state.busy = false;
  if (r.ok) state.route = route;
  return r.ok;
}
