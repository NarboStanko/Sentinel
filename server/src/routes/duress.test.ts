// Test Compito 7.2: POST /duress/trigger
// 6 test: trigger base, rate-limit, auth, no switch attivi, eventi catena, switch GRACE
export {};

process.env['DB_PATH'] = ':memory:';

const { default: Fastify }   = await import('fastify');
const { db }                 = await import('../db.js');
const { p256 }               = await import('@noble/curves/p256');
const { sha256 }             = await import('@noble/hashes/sha256');
const { bytesToHex }         = await import('@noble/hashes/utils');
const { canonicalize }       = await import('../middleware/auth.js');
const { duressRoutes }       = await import('./duress.js');
const { pairingRoutes }      = await import('./pairing.js');
const { switchRoutes }       = await import('./switch.js');

let passed = 0, failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
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

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function buildApp() {
  const app = Fastify({ logger: false, trustProxy: true });
  app.setErrorHandler((err, _req, reply) => {
    const s = (err as any).statusCode ?? 500;
    reply.code(s).send({ error: (err as any).code ?? 'error', message: err.message });
  });
  await app.register(pairingRoutes);
  await app.register(switchRoutes);
  await app.register(duressRoutes);
  await app.ready();
  return app;
}

function signPost(priv: Uint8Array, pub: string, path: string, body: Record<string, unknown>) {
  const ts = Date.now();
  const sig = bytesToHex(
    p256.sign(sha256(new TextEncoder().encode(canonicalize('POST', path, ts, pub, body))), priv)
      .toCompactRawBytes()
  );
  return { pub, ts, sig };
}

async function registerOwner(app: any) {
  const priv = p256.utils.randomPrivateKey();
  const pub  = bytesToHex(p256.getPublicKey(priv, true));
  const res  = await app.inject({ method: 'POST', url: '/owner/register', payload: { publicKey: pub } });
  const { ownerId } = JSON.parse(res.payload) as { ownerId: string };
  return { ownerId, priv, pub };
}

async function createAndArmSwitch(app: any, priv: Uint8Array, pub: string): Promise<string> {
  const createBody = { intervalSec: 30, graceSec: 10 };
  const createRes = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: { ...createBody, ...signPost(priv, pub, '/switch/create', createBody) },
  });
  const { switchId } = JSON.parse(createRes.payload) as { switchId: string };

  const armBody = {
    switchId,
    drivePointer: 'ptr://test',
    contentIv:    'a'.repeat(64),
    label:        'test',
    shares:       [{ blob: 'b'.repeat(64) }],
  };
  await app.inject({
    method: 'POST', url: '/switch/arm',
    payload: { ...armBody, ...signPost(priv, pub, '/switch/arm', armBody) },
  });
  return switchId;
}

const app = await buildApp();
console.log('\nCompito 7.2 — POST /duress/trigger\n');

// ── 1) Trigger con switch ACTIVE → 200, switch diventa APPROVAL_PENDING ────────
await test('1) trigger switch ACTIVE → 200, stato diventa APPROVAL_PENDING', async () => {
  const { ownerId, priv, pub } = await registerOwner(app);
  const switchId = await createAndArmSwitch(app, priv, pub);

  const before = db.prepare('SELECT state FROM switches WHERE id=?').get(switchId) as any;
  assert(before?.state === 'ACTIVE', `atteso ACTIVE prima del trigger, trovato ${before?.state}`);

  const res = await app.inject({
    method: 'POST', url: '/duress/trigger',
    payload: signPost(priv, pub, '/duress/trigger', {}),
  });
  assert(res.statusCode === 200, `atteso 200, ricevuto ${res.statusCode}: ${res.payload}`);
  const body = JSON.parse(res.payload) as any;
  assert(body.ok === true, 'ok deve essere true');
  assert(body.switchesTriggered === 1, `atteso 1, ricevuto ${body.switchesTriggered}`);

  const after = db.prepare('SELECT state FROM switches WHERE id=?').get(switchId) as any;
  assert(after?.state === 'APPROVAL_PENDING', `atteso APPROVAL_PENDING, trovato ${after?.state}`);
});

// ── 2) Rate-limit: 4° chiamata nello stesso giorno → 429 ──────────────────────
await test('2) 4° trigger nello stesso giorno → 429 rate_limit', async () => {
  const { priv, pub } = await registerOwner(app);

  for (let i = 0; i < 3; i++) {
    await app.inject({
      method: 'POST', url: '/duress/trigger',
      payload: signPost(priv, pub, '/duress/trigger', {}),
    });
  }

  const res = await app.inject({
    method: 'POST', url: '/duress/trigger',
    payload: signPost(priv, pub, '/duress/trigger', {}),
  });
  assert(res.statusCode === 429, `atteso 429, ricevuto ${res.statusCode}`);
  const body = JSON.parse(res.payload) as any;
  assert(body.error === 'rate_limit', `error atteso 'rate_limit', ricevuto '${body.error}'`);
  assert(typeof body.resetAt === 'number', 'resetAt deve essere presente');
});

// ── 3) Chiamata non autenticata → 401 ─────────────────────────────────────────
await test('3) chiamata senza firma valida → 401', async () => {
  const res = await app.inject({
    method: 'POST', url: '/duress/trigger',
    payload: { pub: '02' + 'a'.repeat(64), ts: Date.now(), sig: 'b'.repeat(128) },
  });
  assert(res.statusCode === 401, `atteso 401, ricevuto ${res.statusCode}`);
});

// ── 4) Nessun switch attivo → 200 con switchesTriggered=0 ─────────────────────
await test('4) nessun switch ACTIVE/GRACE → 200 con switchesTriggered=0', async () => {
  const { priv, pub } = await registerOwner(app);

  const res = await app.inject({
    method: 'POST', url: '/duress/trigger',
    payload: signPost(priv, pub, '/duress/trigger', {}),
  });
  assert(res.statusCode === 200, `atteso 200, ricevuto ${res.statusCode}: ${res.payload}`);
  const body = JSON.parse(res.payload) as any;
  assert(body.switchesTriggered === 0, `atteso 0, ricevuto ${body.switchesTriggered}`);
});

// ── 5) Eventi DURESS_TRIGGERED_INITIATED e DURESS_TRIGGERED in catena ─────────
await test('5) eventi DURESS_TRIGGERED_INITIATED e DURESS_TRIGGERED inseriti in catena', async () => {
  const { ownerId, priv, pub } = await registerOwner(app);
  await createAndArmSwitch(app, priv, pub);

  await app.inject({
    method: 'POST', url: '/duress/trigger',
    payload: signPost(priv, pub, '/duress/trigger', {}),
  });

  const events = db.prepare(
    'SELECT event_type FROM audit_chain WHERE chain_owner_id=? ORDER BY chain_index ASC'
  ).all(ownerId) as { event_type: string }[];
  const types = events.map(e => e.event_type);

  assert(
    types.includes('DURESS_TRIGGERED_INITIATED'),
    `DURESS_TRIGGERED_INITIATED mancante in catena: [${types.join(', ')}]`
  );
  assert(
    types.includes('DURESS_TRIGGERED'),
    `DURESS_TRIGGERED mancante in catena: [${types.join(', ')}]`
  );
});

// ── 6) Switch in stato GRACE viene triggerato correttamente ───────────────────
await test('6) switch in GRACE viene portato ad APPROVAL_PENDING', async () => {
  const { ownerId, priv, pub } = await registerOwner(app);
  const switchId = await createAndArmSwitch(app, priv, pub);

  db.prepare("UPDATE switches SET state='GRACE' WHERE id=?").run(switchId);
  const inGrace = db.prepare('SELECT state FROM switches WHERE id=?').get(switchId) as any;
  assert(inGrace?.state === 'GRACE', `stato atteso GRACE, trovato ${inGrace?.state}`);

  const res = await app.inject({
    method: 'POST', url: '/duress/trigger',
    payload: signPost(priv, pub, '/duress/trigger', {}),
  });
  assert(res.statusCode === 200, `atteso 200, ricevuto ${res.statusCode}: ${res.payload}`);
  const body = JSON.parse(res.payload) as any;
  assert(body.switchesTriggered === 1, `atteso 1, ricevuto ${body.switchesTriggered}`);

  const after = db.prepare('SELECT state FROM switches WHERE id=?').get(switchId) as any;
  assert(after?.state === 'APPROVAL_PENDING', `atteso APPROVAL_PENDING, trovato ${after?.state}`);
});

// ── Riepilogo ─────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} test — ${passed} ok, ${failed} falliti\n`);
if (failed > 0) process.exit(1);
