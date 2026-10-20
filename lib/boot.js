import db, { log } from './db';
import { hash, newKey } from './auth';
import { startSampler } from './probe';
import { startMeter } from './streams';
import { refresh } from './egress';
export function boot() {
  if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    if (!process.env.NOISY_ADMIN_PASSWORD) console.error('first start: set NOISY_ADMIN_PASSWORD');
    else {
      db.prepare('INSERT INTO users(username,pw,role,ingest_key) VALUES(?,?,?,?)').run(process.env.NOISY_USER || 'admin', hash(process.env.NOISY_ADMIN_PASSWORD), 'admin', newKey());
      log('system', 'admin_created');
    }
  }
  startSampler();
  startMeter();
  refresh();
}
