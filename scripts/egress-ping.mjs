// TCP connect time to host:port, five samples. DNS goes to 1.1.1.1 explicitly:
// inside the tunnel netns it is hijacked by sing-box, the host resolver is not reachable.
import net from 'node:net';
import dns from 'node:dns';
const [host = '1.1.1.1', port = '443'] = process.argv.slice(2);
let ip = host;
if (!net.isIP(host)) {
  const r = new dns.promises.Resolver(); r.setServers(['1.1.1.1']);
  try { ip = (await r.resolve4(host))[0]; } catch { console.log(JSON.stringify({ rtts: [null, null, null, null, null] })); process.exit(0); }
}
const one = () => new Promise(res => {
  const t0 = process.hrtime.bigint(), s = net.connect({ host: ip, port: +port });
  const done = v => { s.destroy(); res(v); };
  s.setTimeout(2000);
  s.once('connect', () => done(Number(process.hrtime.bigint() - t0) / 1e6));
  s.once('timeout', () => done(null));
  s.once('error', () => done(null));
});
const r = [];
for (let i = 0; i < 5; i++) { r.push(await one()); await new Promise(x => setTimeout(x, 150)); }
console.log(JSON.stringify({ rtts: r }));
