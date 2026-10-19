import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import db from './db';
export const hash = pw => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
export function verify(pw, stored) {
  const [s, h] = stored.split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64), Buffer.from(h, 'hex'));
}
export const newKey = () => crypto.randomBytes(18).toString('base64url');
export function newSession(uid) {
  const t = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(t, uid, Date.now() + 720 * 60000);
  return t;
}
export function currentUser() {
  const t = cookies().get('noisy_sid')?.value;
  if (!t) return null;
  return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.exp>? AND u.active=1').get(t, Date.now()) || null;
}
export const pub = ({ pw, ...u }) => u;
// State-changing calls must be JSON: a cross-site form cannot send this content type
export const isJson = req => (req.headers.get('content-type') || '').includes('application/json');
// 5 failed logins per 5 minutes per IP (in memory, like the Flask panel)
const hits = new Map();
const recent = ip => (hits.get(ip) || []).filter(t => t > Date.now() - 3e5);
export const fail = ip => hits.set(ip, [...recent(ip), Date.now()]);
export const rateLimited = ip => recent(ip).length >= 5;
