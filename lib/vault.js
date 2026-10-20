import crypto from 'node:crypto';
import fs from 'node:fs';
// Stream keys are sealed with the same 32-byte master key the Flask panel used
const key = () => fs.readFileSync(process.env.NOISY_MASTER_KEY || '/opt/noisy/secrets/master.key');
export function seal(text) {
  const n = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), n);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([n, c.getAuthTag(), ct]).toString('base64');
}
export function open(b64) {
  const x = Buffer.from(b64, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', key(), x.subarray(0, 12));
  d.setAuthTag(x.subarray(12, 28));
  return Buffer.concat([d.update(x.subarray(28)), d.final()]).toString('utf8');
}
