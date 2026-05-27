// Test validazione /switch/create: limiti dev vs produzione, conversione tempi, persistenza DB.
export {};

process.env['DB_PATH'] = ':memory:';

const { default: Fastify } = await import('fastify');
const { switchRoutes } = await import('./switch.js');
const { db } = await import('../db.js');

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => {
  if (c) { pass++; console.log('  ✓', m); }
  else   { fail++; console.log('  ✗ FAIL:', m); }
};

async function buildApp() {
  const app = Fastify({ logger: false });
  app.setErrorHandler((_err, _req, reply) => {
    reply.code(500).send({ error: 'internal_error', message: 'Errore interno.' });
  });
  await app.register(switchRoutes);
  return app;
}

const app = await buildApp();

// ── 1) Conversione: 2 giorni = 172800 s (pura aritmetica) ────────────────────
console.log('1) Conversione tempi: aritmetica pura');
{
  const HOUR = 3600, DAY = 86400;
  ok(2 * DAY  === 172800, '2 giorni = 172800 s');
  ok(7 * DAY  === 604800, '7 giorni = 604800 s (settimanale)');
  ok(6 * HOUR === 21600,  '6 ore = 21600 s (grazia default)');
  ok(1 * HOUR === 3600,   '1 ora = 3600 s');
}

// ── 2) Produzione: intervallo < 1h → 400 ─────────────────────────────────────
console.log('2) Produzione: intervallo 1800s (< 3600) → 400');
{
  process.env['NODE_ENV'] = 'production';
  const res = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: { ownerId: 'usr_test', intervalSec: 1800, graceSec: 3600 },
  });
  const body = JSON.parse(res.payload) as any;
  ok(res.statusCode === 400, `status 400 (ricevuto: ${res.statusCode})`);
  ok(body.error === 'intervallo_non_valido', `error=intervallo_non_valido (${body.error})`);
}

// ── 3) Produzione: intervallo > 31 giorni → 400 ───────────────────────────────
console.log('3) Produzione: intervallo 32 giorni (> 31) → 400');
{
  process.env['NODE_ENV'] = 'production';
  const res = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: { ownerId: 'usr_test', intervalSec: 32 * 86400, graceSec: 3600 },
  });
  const body = JSON.parse(res.payload) as any;
  ok(res.statusCode === 400, `status 400 (ricevuto: ${res.statusCode})`);
  ok(body.error === 'intervallo_non_valido', `error=intervallo_non_valido (${body.error})`);
}

// ── 4) Produzione: grazia < 1h → 400 ─────────────────────────────────────────
console.log('4) Produzione: grazia 1800s (< 3600) → 400');
{
  process.env['NODE_ENV'] = 'production';
  const res = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: { ownerId: 'usr_test', intervalSec: 86400, graceSec: 1800 },
  });
  const body = JSON.parse(res.payload) as any;
  ok(res.statusCode === 400, `status 400 (ricevuto: ${res.statusCode})`);
  ok(body.error === 'grazia_non_valida', `error=grazia_non_valida (${body.error})`);
}

// ── 5) Sviluppo: intervallo 30s → 200 ────────────────────────────────────────
console.log('5) Sviluppo: intervallo 30s → 200');
{
  process.env['NODE_ENV'] = 'test';
  const res = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: { ownerId: 'usr_test', intervalSec: 30, graceSec: 10 },
  });
  const body = JSON.parse(res.payload) as any;
  ok(res.statusCode === 200, `status 200 (ricevuto: ${res.statusCode})`);
  ok(typeof body.switchId === 'string', `switchId presente (${body.switchId})`);
  ok(body.switchId.startsWith('sw_'), `switchId ha prefisso sw_ (${body.switchId})`);
}

// ── 6) Sviluppo: grazia < 10s → 400 ──────────────────────────────────────────
console.log('6) Sviluppo: grazia 5s (< 10) → 400');
{
  process.env['NODE_ENV'] = 'test';
  const res = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: { ownerId: 'usr_test', intervalSec: 30, graceSec: 5 },
  });
  const body = JSON.parse(res.payload) as any;
  ok(res.statusCode === 400, `status 400 (ricevuto: ${res.statusCode})`);
  ok(body.error === 'grazia_non_valida', `error=grazia_non_valida (${body.error})`);
}

// ── 7) Preset giornaliero (86400s) — salvato correttamente nel DB ─────────────
console.log('7) Preset giornaliero (86400s) e grazia 6h (21600s) → interval_sec e grace_sec nel DB');
{
  process.env['NODE_ENV'] = 'test';
  const res = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: { ownerId: 'usr_test2', intervalSec: 86400, graceSec: 21600 },
  });
  const body = JSON.parse(res.payload) as any;
  ok(res.statusCode === 200, `status 200 (ricevuto: ${res.statusCode})`);

  const sw = db.prepare('SELECT interval_sec, grace_sec FROM switches WHERE id=?').get(body.switchId) as any;
  ok(sw?.interval_sec === 86400, `interval_sec=86400 nel DB (${sw?.interval_sec})`);
  ok(sw?.grace_sec    === 21600, `grace_sec=21600 nel DB (${sw?.grace_sec})`);
}

// ── 8) Preset settimanale (604800s) salvato correttamente ─────────────────────
console.log('8) Preset settimanale (604800s) e grazia 1g (86400s) → DB corretto');
{
  process.env['NODE_ENV'] = 'test';
  const res = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: { ownerId: 'usr_test3', intervalSec: 604800, graceSec: 86400 },
  });
  const body = JSON.parse(res.payload) as any;
  ok(res.statusCode === 200, `status 200 (ricevuto: ${res.statusCode})`);

  const sw = db.prepare('SELECT interval_sec, grace_sec FROM switches WHERE id=?').get(body.switchId) as any;
  ok(sw?.interval_sec === 604800, `interval_sec=604800 nel DB (${sw?.interval_sec})`);
  ok(sw?.grace_sec    === 86400,  `grace_sec=86400 nel DB (${sw?.grace_sec})`);
}

// ── 9) Produzione: limite esatto 1h → 200 ────────────────────────────────────
console.log('9) Produzione: intervallo esattamente 3600s (limite) → 200');
{
  process.env['NODE_ENV'] = 'production';
  const res = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: { ownerId: 'usr_test4', intervalSec: 3600, graceSec: 3600 },
  });
  ok(res.statusCode === 200, `status 200 (ricevuto: ${res.statusCode})`);
}

// ── 10) Produzione: ogni 2 giorni (172800s) → 200 ────────────────────────────
console.log('10) Produzione: preset Ogni 2 giorni (172800s) → 200');
{
  process.env['NODE_ENV'] = 'production';
  const res = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: { ownerId: 'usr_test5', intervalSec: 172800, graceSec: 21600 },
  });
  ok(res.statusCode === 200, `status 200 (ricevuto: ${res.statusCode})`);
}

// ── 11) add-content su switch ACTIVE → 200 + puntatore aggiornato + timer rinnovato ──
console.log('11) add-content su switch ACTIVE → 200, DB aggiornato, next_check_at rinnovato');
{
  process.env['NODE_ENV'] = 'test';
  const createRes = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: { ownerId: 'usr_add', intervalSec: 30, graceSec: 10 },
  });
  const { switchId } = JSON.parse(createRes.payload) as any;
  const oldNext = Date.now() + 30_000;
  db.prepare("UPDATE switches SET state='ACTIVE', drive_pointer='old-ptr', content_iv='old-iv', next_check_at=? WHERE id=?")
    .run(oldNext, switchId);

  const addRes = await app.inject({
    method: 'POST', url: '/switch/add-content',
    payload: { switchId, drivePointer: 'new-ptr', contentIv: 'new-iv' },
  });
  const addBody = JSON.parse(addRes.payload) as any;
  ok(addRes.statusCode === 200, `status 200 (${addRes.statusCode})`);
  ok(addBody.ok === true, 'ok === true');
  ok(typeof addBody.nextCheckAt === 'number', `nextCheckAt presente`);

  const sw = db.prepare('SELECT drive_pointer, content_iv, next_check_at FROM switches WHERE id=?').get(switchId) as any;
  ok(sw.drive_pointer === 'new-ptr', `drive_pointer aggiornato (${sw.drive_pointer})`);
  ok(sw.content_iv   === 'new-iv',  `content_iv aggiornato (${sw.content_iv})`);
  ok(sw.next_check_at !== oldNext,  'next_check_at rinnovato');
}

// ── 12) add-content su switch DISARMED → 409 ─────────────────────────────────
console.log('12) add-content su switch DISARMED → 409');
{
  process.env['NODE_ENV'] = 'test';
  const createRes = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: { ownerId: 'usr_add2', intervalSec: 30, graceSec: 10 },
  });
  const { switchId } = JSON.parse(createRes.payload) as any;

  const res = await app.inject({
    method: 'POST', url: '/switch/add-content',
    payload: { switchId, drivePointer: 'ptr', contentIv: 'iv' },
  });
  const body = JSON.parse(res.payload) as any;
  ok(res.statusCode === 409, `status 409 (${res.statusCode})`);
  ok(body.error === 'switch_non_attivo', `error=switch_non_attivo (${body.error})`);
}

// ── 13) add-content su switch inesistente → 404 ───────────────────────────────
console.log('13) add-content su switch inesistente → 404');
{
  const res = await app.inject({
    method: 'POST', url: '/switch/add-content',
    payload: { switchId: 'sw_nonexistent_xyz', drivePointer: 'ptr', contentIv: 'iv' },
  });
  ok(res.statusCode === 404, `status 404 (${res.statusCode})`);
}

// ── 14) add-content su switch APPROVAL_PENDING → 409 ─────────────────────────
console.log('14) add-content su switch APPROVAL_PENDING → 409');
{
  process.env['NODE_ENV'] = 'test';
  const createRes = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: { ownerId: 'usr_add3', intervalSec: 30, graceSec: 10 },
  });
  const { switchId } = JSON.parse(createRes.payload) as any;
  db.prepare("UPDATE switches SET state='APPROVAL_PENDING' WHERE id=?").run(switchId);

  const res = await app.inject({
    method: 'POST', url: '/switch/add-content',
    payload: { switchId, drivePointer: 'ptr', contentIv: 'iv' },
  });
  ok(res.statusCode === 409, `status 409 (${res.statusCode})`);
}

console.log(`\nRisultato: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
