// Minimal datarhei core API client (token cached, never throws)
const BASE = process.env.NOISY_CORE_API || 'http://127.0.0.1:18080';
let tok = null, exp = 0;
async function auth() {
  if (tok && Date.now() < exp) return tok;
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.NOISY_CORE_USER, password: process.env.NOISY_CORE_PASS }) });
  if (!r.ok) throw new Error('core login ' + r.status);
  tok = (await r.json()).access_token; exp = Date.now() + 8 * 60000;
  return tok;
}
export async function core(method, path, body) {
  try {
    const r = await fetch(BASE + path, { method, headers: { authorization: 'Bearer ' + await auth(), 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    if (r.status === 401) tok = null;
    return r;
  } catch (e) { return { ok: false, status: 0, error: String(e.message).slice(0, 80), json: async () => ({}) }; }
}
