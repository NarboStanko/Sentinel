// Test suite: rate limiting su /approval/submit e IP globale
// Esegui con: npm run test:ratelimit

process.env['DB_PATH'] = ':memory:';

const { default: Fastify } = await import('fastify');
const { ok, equal } = await import('node:assert/strict');
const { db } = await import('../db.js');
const { approvalRoutes } = await import('../routes/approvals.js');
const { registerIpRateLimitHook } = await import('../services/rateLimiter.js');
const { mkKeyPair, signBody } = await import('../testUtils/authHelpers.js');

// ── Setup app ──────────────────────────────────────────────────────────────────
const app = Fastify({ logger: false, trustProxy: true });
registerIpRateLimitHook(app);
app.get('/health', async () => ({ ok: true }));
app.get('/test-ip', async () => ({ ok: true }));
await app.register(approvalRoutes);
await app.ready();

// ── Setup DB: owner + contatto per i test di submit ────────────────────────────
const RL_OWNER_ID = 'usr_rl_test';
const RL_CONTACT_ID = 'c_rl_test';
const ownerKP = mkKeyPair();
const contactKP = mkKeyPair();

db.prepare('INSERT INTO users (id, public_key, created_at) VALUES (?,?,?)')
  .run(RL_OWNER_ID, ownerKP.pub, Date.now());
db.prepare('INSERT INTO contacts (id, owner_id, public_key, push_token, to_hash, created_at) VALUES (?,?,?,?,?,?)')
  .run(RL_CONTACT_ID, RL_OWNER_ID, contactKP.pub, 'push_rl', 'hash_rl', Date.now());

// Crea uno switch per un dato sid (necessario per requireAuth('contact-of-switch'))
function mkRlSwitch(sid: string) {
  db.prepare('INSERT OR IGNORE INTO switches (id, owner_id, state, interval_sec, grace_sec) VALUES (?,?,?,?,?)')
    .run(sid, RL_OWNER_ID, 'APPROVAL_PENDING', 3600, 600);
}

// ── Helpers ────────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e?.message ?? e}`);
  }
}

// submit firma la richiesta con il contatto globale; l'IP serve solo per il rate-limit globale
function submit(ip: string, switchId: string, x = 1) {
  const body = signBody(contactKP.priv, contactKP.pub, 'POST', '/approval/submit', {
    switchId,
    share: { x, y: 'AAAA' },
  });
  return app.inject({
    method: 'POST',
    url: '/approval/submit',
    headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

function setWindow(key: string, count: number, windowStart = Math.floor(Date.now() / 3_600_000) * 3_600_000) {
  db.prepare('INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?, ?, ?)')
    .run(key, count, windowStart);
}

// ── Tests ──────────────────────────────────────────────────────────────────────
console.log('\nRate-limit tests\n');

// 1. Prod: 20 submit → 21a è 429
await test('1) prod — 20 submit passano, 21a è 429', async () => {
  process.env['NODE_ENV'] = 'production';
  const ip = '10.1.0.1';
  const sid = 'sw_rl1';
  mkRlSwitch(sid);
  for (let i = 1; i <= 20; i++) {
    const r = await submit(ip, sid, i);
    ok(r.statusCode !== 429, `submit ${i}: non dovrebbe essere 429 (prod 20/hr)`);
  }
  const r21 = await submit(ip, sid, 21);
  equal(r21.statusCode, 429, '21a submit: dovrebbe essere 429');
  const body = JSON.parse(r21.payload);
  equal(body.error, 'rate_limit_exceeded', 'body.error corretto');
});

// 2. Dev: limite è 200/hr (non 20 come in prod) — verificato con iniezione DB
await test('2) dev — limite submit è 200/hr: 200a passa, 201a è 429', async () => {
  process.env['NODE_ENV'] = 'development';
  const ip = '10.2.0.1';
  const sid = 'sw_rl2';
  mkRlSwitch(sid);
  // Imposta il contatore a 199 direttamente nel DB (evita di fare 200 chiamate reali)
  setWindow(`submit:${sid}:${RL_CONTACT_ID}`, 199);
  // 200a submit: dovrebbe passare (199+1 = 200, ancora nel limite)
  const r200 = await submit(ip, sid, 200);
  ok(r200.statusCode !== 429, '200a submit: non dovrebbe essere 429 (dev 200/hr)');
  // 201a submit: dovrebbe essere bloccata
  const r201 = await submit(ip, sid, 201);
  equal(r201.statusCode, 429, '201a submit: dovrebbe essere 429 (dev 200/hr esaurito)');
});

// 3. Dev: reset finestra → il contatore riparte da capo
await test('3) reset finestra — dopo la scadenza il contatore riparte', async () => {
  process.env['NODE_ENV'] = 'development';
  const ip = '10.3.0.1';
  const sid = 'sw_rl3';
  mkRlSwitch(sid);
  // Finestra piena
  setWindow(`submit:${sid}:${RL_CONTACT_ID}`, 200);
  const rBlocked = await submit(ip, sid, 1);
  equal(rBlocked.statusCode, 429, 'limite raggiunto — dovrebbe essere bloccato');
  // Simula scadenza finestra (window_start due ore fa)
  const twoHoursAgo = Date.now() - 2 * 3_600_000;
  db.prepare('UPDATE rate_limits SET window_start = ? WHERE key = ?')
    .run(twoHoursAgo, `submit:${sid}:${RL_CONTACT_ID}`);
  // Ora la finestra è nuova — la prima richiesta deve passare
  const rAfter = await submit(ip, sid, 2);
  ok(rAfter.statusCode !== 429, 'dopo reset finestra: prima richiesta non dovrebbe essere 429');
});

// 4. Prod: 60 GET stessa IP passano, 61a è 429 (limite IP globale)
await test('4) prod — IP globale: 60 richieste passano, 61a è 429', async () => {
  process.env['NODE_ENV'] = 'production';
  const ip = '10.4.0.1';
  for (let i = 1; i <= 60; i++) {
    const r = await app.inject({ method: 'GET', url: '/test-ip', headers: { 'x-forwarded-for': ip } });
    ok(r.statusCode === 200, `richiesta ${i}: dovrebbe passare (prod 60/min)`);
  }
  const r61 = await app.inject({ method: 'GET', url: '/test-ip', headers: { 'x-forwarded-for': ip } });
  equal(r61.statusCode, 429, '61a richiesta: dovrebbe essere 429 (IP globale)');
});

// 5. 100 submit cumulativi → audit SUSPICIOUS_SUBMIT_PATTERN, 101a è 429
await test('5) lockout cumulativo: 100a submit attiva lockout, 101a è 429', async () => {
  process.env['NODE_ENV'] = 'production';
  const ip = '10.5.0.1';
  const sid = 'sw_rl5';
  mkRlSwitch(sid);
  // Precarica il contatore cumulativo a 99 (evita di fare 99 chiamate reali)
  db.prepare('INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?, ?, ?)')
    .run(`cumul:${sid}:${RL_CONTACT_ID}`, 99, Date.now());
  // 100a submit cumulativa: passa e attiva il lockout
  const r100 = await submit(ip, sid, 1);
  ok(r100.statusCode !== 429, '100a submit cumulativa: non dovrebbe essere 429');
  // Verifica audit SUSPICIOUS_SUBMIT_PATTERN
  const auditRow = db.prepare(
    "SELECT COUNT(*) AS n FROM audit WHERE switch_id = ? AND event = 'SUSPICIOUS_SUBMIT_PATTERN'"
  ).get(sid) as { n: number };
  ok(auditRow.n >= 1, `audit SUSPICIOUS_SUBMIT_PATTERN presente (trovato: ${auditRow.n})`);
  // 101a: lockout attivo → 429
  const r101 = await submit(ip, sid, 2);
  equal(r101.statusCode, 429, '101a submit con lockout attivo: dovrebbe essere 429');
});

// 6. /health è esente dal rate-limit globale
await test('6) /health — esente: 200 richieste consecutive passano tutte', async () => {
  process.env['NODE_ENV'] = 'production';
  const ip = '10.6.0.1';
  for (let i = 1; i <= 200; i++) {
    const r = await app.inject({ method: 'GET', url: '/health', headers: { 'x-forwarded-for': ip } });
    ok(r.statusCode === 200, `richiesta health ${i}: dovrebbe passare (esente da rate-limit)`);
  }
});

// 7. Header X-RateLimit-* presenti sulla risposta 429
await test('7) header X-RateLimit-* presenti sulla risposta 429', async () => {
  process.env['NODE_ENV'] = 'production';
  const ip = '10.7.0.1';
  const sid = 'sw_rl7';
  mkRlSwitch(sid);
  // Finestra piena
  setWindow(`submit:${sid}:${RL_CONTACT_ID}`, 20);
  const r = await submit(ip, sid, 21);
  equal(r.statusCode, 429, '21a submit: dovrebbe essere 429');
  ok(r.headers['x-ratelimit-limit']     !== undefined, 'X-RateLimit-Limit presente');
  ok(r.headers['x-ratelimit-remaining'] !== undefined, 'X-RateLimit-Remaining presente');
  ok(r.headers['x-ratelimit-reset']     !== undefined, 'X-RateLimit-Reset presente');
  ok(r.headers['retry-after']           !== undefined, 'Retry-After presente');
  equal(r.headers['x-ratelimit-remaining'], '0', 'X-RateLimit-Remaining è 0');
  const retryAfter = Number(r.headers['retry-after']);
  ok(retryAfter >= 1, `Retry-After >= 1 (ricevuto: ${retryAfter})`);
});

// 8. Rate-limit per-identity: due contatti diversi non si bloccano a vicenda
await test('8) isolamento per-identity: contatto pieno non blocca contatto diverso', async () => {
  process.env['NODE_ENV'] = 'production';
  const ip = '10.8.0.1';
  const sid = 'sw_rl8';
  const contact2KP = mkKeyPair();
  const RL_CONTACT2_ID = 'c_rl_test2';
  db.prepare('INSERT OR IGNORE INTO contacts (id, owner_id, public_key, push_token, to_hash, created_at) VALUES (?,?,?,?,?,?)')
    .run(RL_CONTACT2_ID, RL_OWNER_ID, contact2KP.pub, 'push_rl2', 'hash_rl2', Date.now());
  mkRlSwitch(sid);

  // Riempi il limite per il contatto 1
  setWindow(`submit:${sid}:${RL_CONTACT_ID}`, 20);

  // Contatto 1: già al limite → 429
  const rBlocked = await submit(ip, sid, 1);
  equal(rBlocked.statusCode, 429, 'contatto 1: dovrebbe essere 429 (limite raggiunto)');

  // Contatto 2: identità diversa → non bloccato
  const body2 = signBody(contact2KP.priv, contact2KP.pub, 'POST', '/approval/submit', {
    switchId: sid,
    share: { x: 2, y: 'BBBB' },
  });
  const r2 = await app.inject({
    method: 'POST', url: '/approval/submit',
    headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' },
    payload: JSON.stringify(body2),
  });
  ok(r2.statusCode !== 429, `contatto 2: non dovrebbe essere 429 (isolamento per-identity); ricevuto ${r2.statusCode}`);
});

// ── Riepilogo ──────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} test — ${passed} ok, ${failed} falliti\n`);
if (failed > 0) process.exit(1);
