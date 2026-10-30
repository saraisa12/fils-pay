// Checkout load test: POST /v1/payment-links/:token/pay with a fresh Idempotency-Key per request.
// Needs `autocannon` (npm i -g autocannon, or npm i --no-save autocannon). See docs/CAPACITY.md.
// usage: node scripts/loadtest/checkout.cjs <PG_POOL_MAX> <connections> <seconds> <tokenOffset> [acquirerMinMs,acquirerMaxMs]
//        BASE_URL=http://host node scripts/loadtest/checkout.cjs 0 <connections> <seconds> <tokenOffset>   (remote server)
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const autocannon = require('autocannon');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const [POOL, CONN, DUR, OFFSET, LAT] = [process.argv[2]||'5', +process.argv[3]||20, +process.argv[4]||15, +process.argv[5]||0, process.argv[6]||'100,400'];
const [lmin, lmax] = LAT.split(',');
const env = { ...process.env, PORT: '3001', PG_POOL_MAX: POOL, DATABASE_URL: process.env.DATABASE_URL || 'postgres://filspay:filspay@localhost:5432/filspay',
  WEBHOOK_SECRET_ENCRYPTION_KEY: 'Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=', ACQUIRER_LATENCY_MIN_MS: lmin, ACQUIRER_LATENCY_MAX_MS: lmax };
// BASE_URL=http://<host> tests a server that is already running (e.g. the hosted one) and skips the
// local API / CPU measurement. Without it, the script starts the API from this repo on :3001.
const REMOTE = process.env.BASE_URL;
const URL_UNDER_TEST = REMOTE || 'http://127.0.0.1:3001';
const api = REMOTE ? { pid: 0 } : spawn('npx', ['tsx', 'apps/api/src/index.ts'], { env, detached: true, stdio: 'ignore', cwd: REPO });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pidOf = () => { try { return execSync(`ps --no-headers -o pid -g ${api.pid}`).toString().trim().split('\n').map(Number); } catch { return []; } };
const cpu = pids => pids.reduce((s, p) => { try { const f = fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(' '); return s + (+f[13] + +f[14]) / 100; } catch { return s; } }, 0);
(async () => {
  for (let i = 0; i < 40; i++) { try { const r = await fetch(URL_UNDER_TEST + '/healthz'); if (r.ok) break; } catch {} await sleep(500); }
  await sleep(1500);
  const pids = REMOTE ? [] : pidOf();
  const c0 = cpu(pids); let n = OFFSET;
  const res = await autocannon({ url: URL_UNDER_TEST, connections: CONN, duration: DUR, timeout: 30, requests: [{ method: 'POST',
    setupRequest: req => { const k = n++; req.path = `/v1/payment-links/plink_ld_${k}/pay`; req.headers = { 'content-type': 'application/json', 'idempotency-key': `k${k}-${Date.now()}` };
      req.body = JSON.stringify({ card: { pan: '4242424242424242', expiryMonth: 12, expiryYear: 2030, cvv: '123' } }); return req; } }] });
  const cpuUsed = cpu(pids) - c0;
  const ok = res['2xx'], tot = res.requests.total;
  console.log(JSON.stringify({ pool: POOL, conns: CONN, acquirerMs: LAT, seconds: DUR, total: tot, ok2xx: ok, non2xx: res.non2xx, errors: res.errors, timeouts: res.timeouts,
    codes: res.statusCodeStats, rps_total: +(tot / DUR).toFixed(1), rps_ok: +(ok / DUR).toFixed(1), lat_p50: res.latency.p50, lat_p97_5: res.latency.p97_5, lat_p99: res.latency.p99, lat_max: res.latency.max,
    cpu_sec: +cpuUsed.toFixed(2), cpu_ms_per_req: +(cpuUsed * 1000 / tot).toFixed(1) }));
  if (!REMOTE) { try { process.kill(-api.pid); } catch {} }
  process.exit(0);
})();
