// Test rotte di debug: /debug/seed-contacts e /debug/expire/:switchId
// Verifica che esistano (non "Route not found") e rispondano correttamente.
export {}; // marca come modulo ES per tsc

process.env['DB_PATH'] = ':memory:';
// NODE_ENV volutamente non impostato → comportamento identico a npm run dev

const { default: Fastify } = await import('fastify');
const { debugRoutes } = await import('./debug.js');
const { pairingRoutes } = await import('./pairing.js');
const { db } = await import('../db.js');

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => {
  if (c) { pass++; console.log('  ✓', m); }
  else   { fail++; console.log('  ✗ FAIL:', m); }
};

async function buildApp() {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    reply.code(500).send({ error: 'internal_error', message: 'Errore interno.' });
  });
  await app.register(pairingRoutes); // per poter creare owner nel DB
  await app.register(debugRoutes);
  return app;
}

const app = await buildApp();

// ── 1) La rotta esiste: {} → 404 custom (non Fastify "Route not found") ────────
console.log('1) /debug/seed-contacts esiste — {} → 404 custom, non "Route not found"');
{
  const res = await app.inject({ method: 'POST', url: '/debug/seed-contacts', payload: {} });
  const body = JSON.parse(res.payload) as Record<string, unknown>;
  ok(res.statusCode === 404, `status 404 (ricevuto: ${res.statusCode})`);
  // Fastify restituisce { statusCode:404, error:"Not Found", message:"..." }
  // Il nostro handler restituisce { error:"owner_non_trovato", message:"..." }
  ok(body['error'] !== 'Not Found', `non è il 404 generico di Fastify (error=${body['error']})`);
  ok(body['error'] === 'owner_non_trovato', `body.error === "owner_non_trovato" (${body['error']})`);
  ok(typeof body['message'] === 'string', 'body.message presente');
}

// ── 2) ownerId valido → 200, 2 contatti con le chiavi ─────────────────────────
console.log('2) ownerId valido → 200 + 2 contatti P-256');
{
  const ownerRes = await app.inject({
    method: 'POST', url: '/owner/register',
    payload: { publicKey: '04testdebug0001', displayName: 'DebugOwner' },
  });
  const { ownerId } = JSON.parse(ownerRes.payload) as { ownerId: string };

  const res = await app.inject({
    method: 'POST', url: '/debug/seed-contacts',
    payload: { ownerId },
  });
  const body = JSON.parse(res.payload) as any;

  ok(res.statusCode === 200, `status 200 (ricevuto: ${res.statusCode})`);
  ok(Array.isArray(body.contacts), 'body.contacts è un array');
  ok(body.contacts.length === 2, `2 contatti (ricevuti: ${body.contacts?.length})`);

  const c0 = body.contacts[0];
  const c1 = body.contacts[1];
  ok(typeof c0.contactId === 'string' && c0.contactId.startsWith('c_dev_'), `contactId[0] prefisso c_dev_: ${c0.contactId}`);
  ok(typeof c0.publicKey === 'string' && c0.publicKey.length === 66, `publicKey[0] 33B hex: ${c0.publicKey?.length} chars`);
  ok(c0.contactId !== c1.contactId, 'i due contactId sono distinti');
  ok(c0.publicKey !== c1.publicKey, 'le due publicKey sono distinte');

  // I contatti devono essere nel DB con il token DEVTEST_NO_PUSH
  const rows = db.prepare('SELECT id, push_token FROM contacts WHERE owner_id = ?').all(ownerId) as any[];
  ok(rows.length === 2, `2 righe nel DB (trovate: ${rows.length})`);
  ok(rows.every((r: any) => r.push_token === 'DEVTEST_NO_PUSH'), 'push_token = DEVTEST_NO_PUSH');

  // Secondo seed sullo stesso owner → altri 2 contatti (idempotenza non richiesta, espandibile)
  const res2 = await app.inject({
    method: 'POST', url: '/debug/seed-contacts',
    payload: { ownerId },
  });
  ok(JSON.parse(res2.payload).contacts?.length === 2, 'secondo seed produce altri 2 contatti');
}

// ── 3) /debug/expire/:switchId — id inesistente → 404 custom ──────────────────
console.log('3) /debug/expire/:switchId — id inesistente → 404 custom');
{
  const res = await app.inject({ method: 'POST', url: '/debug/expire/sw_NONEXIST' });
  const body = JSON.parse(res.payload) as Record<string, unknown>;
  ok(res.statusCode === 404, `status 404 (ricevuto: ${res.statusCode})`);
  ok(body['error'] === 'switch_non_trovato', `error=switch_non_trovato (${body['error']})`);
}

// ── 4) /debug/expire/:switchId — switch ACTIVE → next_check_at nel passato ─────
console.log('4) /debug/expire/:switchId — switch ACTIVE → scadenza immediata');
{
  const ownerRes = await app.inject({
    method: 'POST', url: '/owner/register',
    payload: { publicKey: '04testdebug0002' },
  });
  const { ownerId } = JSON.parse(ownerRes.payload) as { ownerId: string };

  const futureTs = Date.now() + 9_999_000;
  db.prepare(
    "INSERT INTO switches (id, owner_id, state, interval_sec, grace_sec, next_check_at, armed_at) VALUES (?,?,'ACTIVE',60,30,?,?)"
  ).run('sw_dbgtest1', ownerId, futureTs, Date.now());

  const res = await app.inject({ method: 'POST', url: '/debug/expire/sw_dbgtest1' });
  const body = JSON.parse(res.payload) as any;
  ok(res.statusCode === 200, `status 200 (ricevuto: ${res.statusCode})`);
  ok(body.ok === true, 'body.ok === true');
  ok(body.fromState === 'ACTIVE', `fromState=ACTIVE (${body.fromState})`);

  const sw = db.prepare('SELECT next_check_at FROM switches WHERE id=?').get('sw_dbgtest1') as any;
  ok(sw.next_check_at < Date.now(), `next_check_at nel passato (${sw.next_check_at} < ${Date.now()})`);
}

// ── 5) /debug/expire/:switchId — switch non ACTIVE/GRACE → 400 ────────────────
console.log('5) /debug/expire/:switchId — switch DISARMED → 400');
{
  const ownerRes = await app.inject({
    method: 'POST', url: '/owner/register',
    payload: { publicKey: '04testdebug0003' },
  });
  const { ownerId } = JSON.parse(ownerRes.payload) as { ownerId: string };
  db.prepare(
    "INSERT INTO switches (id, owner_id, state, interval_sec, grace_sec) VALUES (?,?,'DISARMED',60,30)"
  ).run('sw_dbgtest2', ownerId);

  const res = await app.inject({ method: 'POST', url: '/debug/expire/sw_dbgtest2' });
  const body = JSON.parse(res.payload) as any;
  ok(res.statusCode === 400, `status 400 (ricevuto: ${res.statusCode})`);
  ok(body.error === 'stato_non_scadibile', `error=stato_non_scadibile (${body.error})`);
}

console.log(`\nRisultato: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
