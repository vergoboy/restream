// TCP connect time to 1.1.1.1:443 (an IP, so no DNS), five samples
import net from 'node:net';
const one = () => new Promise(res => {
  const t0 = process.hrtime.bigint(), s = net.connect({ host: '1.1.1.1', port: 443 });
  const done = v => { s.destroy(); res(v); };
  s.setTimeout(2000);
  s.once('connect', () => done(Number(process.hrtime.bigint() - t0) / 1e6));
  s.once('timeout', () => done(null));
  s.once('error', () => done(null));
});
const r = [];
for (let i = 0; i < 5; i++) { r.push(await one()); await new Promise(x => setTimeout(x, 150)); }
console.log(JSON.stringify({ rtts: r }));
