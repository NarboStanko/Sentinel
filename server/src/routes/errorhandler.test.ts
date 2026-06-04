// Test Compito 7.5: error handler, Zod validation, security headers, debug routes in prod/dev.
export {};

process.env['DB_PATH'] = ':memory:';

const { default: Fastify } = await import('fastify');
const { pairingRoutes }    = await import('./pairing.js');
const { switchRoutes }     = await import('./switch.js');
const { checkinRoutes }    = await import('./checkin.js');
const { approvalRoutes }   = await import('./approvals.js');
const { pushRoutes }       = await import('./push.js');
const { recoveryRoutes }   = await import('./recovery.js');
const { authRoutes }       = await import('./auth.js');
const { debugRoutes }      = await import('./debug.js');
const { devBlobRoutes }    = await import('./devblob.js');
const { db }               = await import('../db.js');

let passed = 0, failed = 0;

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

// Stessa logica di index.ts — deve restare sincronizzata.
const BODY_LIMIT = 200 * 1024 * 1024;
const CLIENT_STATUS = new Set([400, 401, 403, 404, 405, 409, 413, 415, 422, 429]);

async function buildApp(nodeEnv: string) {
  process.env['NODE_ENV'] = nodeEnv;
  const app = Fastify({ logger: false, trustProxy: true });

  app.setErrorHandler((err, req, reply) => {
    const status = (err as any).statusCode ?? 500;
    if (status === 413) {
      return reply.code(413).send({
        error: 'payload_too_large',
        message: `Payload troppo grande. Limite server: ${BODY_LIMIT / 1024 / 1024} MB.`,
      });
    }
    if (CLIENT_STATUS.has(status)) {
      return reply.code(status).send({
        error: (err as any).code ?? 'request_error',
        message: err.message,
      });
    }
    req.log.error(err);
    reply.code(500).send({ error: 'internal_error', message: 'Errore interno del server.' });
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'");
    if (req.protocol === 'https') {
      reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    }
  });

  app.get('/health', async () => ({ ok: true, ts: Date.now() }));
  app.get('/crash', async () => { throw new Error('crash_segreto:dati_sensibili'); });

  await app.register(pairingRoutes);
  await app.register(switchRoutes);
  await app.register(checkinRoutes);
  await app.register(approvalRoutes);
  await app.register(pushRoutes);
  await app.register(recoveryRoutes);
  await app.register(authRoutes);
  await app.register(debugRoutes);
  await app.register(devBlobRoutes);
  await app.ready();
  return app;
}

// ── App dev per i test 1-7 ────────────────────────────────────────────────────
console.log('\nError handler + security headers + Zod validation\n');

const appDev = await buildApp('test');

// ── Punto 3: security headers ─────────────────────────────────────────────────

await test('1) GET /health → ha X-Content-Type-Options: nosniff', async () => {
  const r = await appDev.inject({ method: 'GET', url: '/health' });
  if (r.statusCode !== 200) throw new Error(`atteso 200, ricevuto ${r.statusCode}`);
  const h = r.headers['x-content-type-options'];
  if (h !== 'nosniff') throw new Error(`atteso nosniff, ricevuto ${String(h)}`);
});

await test('2) GET /health → ha X-Frame-Options: DENY, Referrer-Policy: no-referrer, CSP', async () => {
  const r = await appDev.inject({ method: 'GET', url: '/health' });
  if (r.headers['x-frame-options'] !== 'DENY') throw new Error(`X-Frame-Options assente o errato: ${r.headers['x-frame-options']}`);
  if (r.headers['referrer-policy'] !== 'no-referrer') throw new Error(`Referrer-Policy assente: ${r.headers['referrer-policy']}`);
  if (!String(r.headers['content-security-policy'] ?? '').includes("default-src 'self'")) {
    throw new Error(`CSP assente o errato: ${r.headers['content-security-policy']}`);
  }
});

await test('3) GET /health HTTP → nessun header HSTS (req.protocol non è https)', async () => {
  const r = await appDev.inject({ method: 'GET', url: '/health' });
  const hsts = r.headers['strict-transport-security'];
  if (hsts !== undefined) throw new Error(`HSTS non dovrebbe essere presente su HTTP: ${hsts}`);
});

// ── Punto 1: error handler ────────────────────────────────────────────────────

await test('4) POST con Content-Type form-urlencoded → 415 (non 500)', async () => {
  const r = await appDev.inject({
    method: 'POST', url: '/owner/register',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'publicKey=test',
  });
  if (r.statusCode !== 415) throw new Error(`atteso 415, ricevuto ${r.statusCode}: ${r.payload}`);
  const body = JSON.parse(r.payload);
  // 415 è un codice client: il body non deve contenere stack o dettagli interni
  if (r.payload.includes('stack')) throw new Error('stack trace esposto nel payload');
});

await test('5) /invite senza auth → 401 passthrough con error:auth_failed', async () => {
  const r = await appDev.inject({ method: 'POST', url: '/invite', payload: {} });
  if (r.statusCode !== 401) throw new Error(`atteso 401, ricevuto ${r.statusCode}`);
  const body = JSON.parse(r.payload);
  if (body.error !== 'auth_failed') throw new Error(`atteso auth_failed, ricevuto ${body.error}`);
});

await test('6) Errore inatteso nel server → 500 senza stack né dettagli', async () => {
  const r = await appDev.inject({ method: 'GET', url: '/crash' });
  if (r.statusCode !== 500) throw new Error(`atteso 500, ricevuto ${r.statusCode}`);
  const body = JSON.parse(r.payload);
  if (body.error !== 'internal_error') throw new Error(`atteso internal_error, ricevuto ${body.error}`);
  if (r.payload.includes('crash_segreto')) throw new Error('messaggio interno esposto nel payload');
  if (r.payload.includes('dati_sensibili')) throw new Error('dati sensibili esposti nel payload');
  if (r.payload.includes('stack')) throw new Error('stack trace esposto nel payload');
});

// ── Punto 2: Zod validation ───────────────────────────────────────────────────

await test('7) POST /owner/register con publicKey mancante → 400 validation_failed', async () => {
  const r = await appDev.inject({
    method: 'POST', url: '/owner/register',
    payload: { displayName: 'Test' },
  });
  if (r.statusCode !== 400) throw new Error(`atteso 400, ricevuto ${r.statusCode}: ${r.payload}`);
  const body = JSON.parse(r.payload);
  if (body.error !== 'validation_failed') throw new Error(`atteso validation_failed, ricevuto ${body.error}`);
  if (typeof body.message !== 'string') throw new Error('message assente o non stringa');
});

await test('8) POST /owner/register con publicKey troppo corta → 400 validation_failed', async () => {
  const r = await appDev.inject({
    method: 'POST', url: '/owner/register',
    payload: { publicKey: '04abcd1234' },
  });
  if (r.statusCode !== 400) throw new Error(`atteso 400, ricevuto ${r.statusCode}: ${r.payload}`);
  const body = JSON.parse(r.payload);
  if (body.error !== 'validation_failed') throw new Error(`atteso validation_failed, ricevuto ${body.error}`);
});

await test('9) POST /auth/challenge con publicKey troppo lunga → 400 validation_failed', async () => {
  const r = await appDev.inject({
    method: 'POST', url: '/auth/challenge',
    payload: { publicKey: '02' + 'a'.repeat(128) },  // 130 chars ≠ 66
  });
  if (r.statusCode !== 400) throw new Error(`atteso 400, ricevuto ${r.statusCode}: ${r.payload}`);
  const body = JSON.parse(r.payload);
  if (body.error !== 'validation_failed') throw new Error(`atteso validation_failed, ricevuto ${body.error}`);
});

await test('10) POST /pair con campo extra → 400 validation_failed (.strict())', async () => {
  const r = await appDev.inject({
    method: 'POST', url: '/pair',
    payload: { token: 'tok_123', contactPublicKey: '02' + '0'.repeat(64), unexpectedField: 'evil' },
  });
  if (r.statusCode !== 400) throw new Error(`atteso 400, ricevuto ${r.statusCode}: ${r.payload}`);
  const body = JSON.parse(r.payload);
  if (body.error !== 'validation_failed') throw new Error(`atteso validation_failed, ricevuto ${body.error}`);
});

// ── Punto 4: debug routes off in production ───────────────────────────────────
console.log('\nDebug routes production guard\n');

const appProd = await buildApp('production');

await test('11) NODE_ENV=production → POST /debug/expire/:id → 404 (rotta non registrata)', async () => {
  const r = await appProd.inject({ method: 'POST', url: '/debug/expire/sw_test' });
  if (r.statusCode !== 404) throw new Error(`atteso 404, ricevuto ${r.statusCode}: ${r.payload}`);
});

await test('12) NODE_ENV=production → POST /debug/seed-contacts → 404 (rotta non registrata)', async () => {
  const r = await appProd.inject({
    method: 'POST', url: '/debug/seed-contacts',
    payload: { ownerId: 'usr_test' },
  });
  if (r.statusCode !== 404) throw new Error(`atteso 404, ricevuto ${r.statusCode}: ${r.payload}`);
});

await test('13) NODE_ENV=production → POST /dev/blob → 404 (rotta non registrata)', async () => {
  const r = await appProd.inject({
    method: 'POST', url: '/dev/blob',
    payload: { data: 'test' },
  });
  if (r.statusCode !== 404) throw new Error(`atteso 404, ricevuto ${r.statusCode}: ${r.payload}`);
});

// Dev: rotte di debug attive, rispondono con errori business-logic (non 404 generico)
const appDev2 = await buildApp('development');

// Crea un owner nel DB condiviso per testare seed-contacts
const devOwnerId = 'usr_eh_dev1';
db.prepare('INSERT OR IGNORE INTO users (id, public_key, created_at) VALUES (?,?,?)')
  .run(devOwnerId, '02' + 'f'.repeat(64), Date.now());

await test('14) NODE_ENV=development → POST /debug/seed-contacts con ownerId valido → 200', async () => {
  const r = await appDev2.inject({
    method: 'POST', url: '/debug/seed-contacts',
    payload: { ownerId: devOwnerId },
  });
  if (r.statusCode !== 200) throw new Error(`atteso 200, ricevuto ${r.statusCode}: ${r.payload}`);
  const body = JSON.parse(r.payload);
  if (!Array.isArray(body.contacts) || body.contacts.length !== 2) {
    throw new Error(`attesi 2 contatti, ricevuto: ${JSON.stringify(body)}`);
  }
});

await test('15) NODE_ENV=development → POST /dev/blob → 200 con pointer', async () => {
  const r = await appDev2.inject({
    method: 'POST', url: '/dev/blob',
    payload: { data: 'AABBCC' },
  });
  if (r.statusCode !== 200) throw new Error(`atteso 200, ricevuto ${r.statusCode}: ${r.payload}`);
  const body = JSON.parse(r.payload);
  if (typeof body.pointer !== 'string') throw new Error(`pointer assente: ${JSON.stringify(body)}`);
});

// ── Riepilogo ─────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} test — ${passed} ok, ${failed} falliti\n`);
if (failed > 0) process.exit(1);
