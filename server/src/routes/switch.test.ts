// Test validazione /switch/*: auth, limiti dev vs produzione, conversione tempi, persistenza DB.
export {};

process.env['DB_PATH'] = ':memory:';

const { default: Fastify } = await import('fastify');
const { switchRoutes }     = await import('./switch.js');
const { db }               = await import('../db.js');
const { mkKeyPair, signBody } = await import('../testUtils/authHelpers.js');

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

// ── Owner globale per tutti i test autenticati ────────────────────────────────
// Inserito direttamente nel DB: evita di importare pairingRoutes.
const owner = mkKeyPair();
const ownerId = 'usr_sw_global';
db.prepare('INSERT INTO users (id, public_key, created_at) VALUES (?,?,?)').run(ownerId, owner.pub, Date.now());

let _ts = Date.now();
function nextTs() { return ++_ts; }

// Helper: payload firmato con l'owner globale
function ownerBody(method: string, url: string, body: Record<string, unknown>): Record<string, unknown> {
  return signBody(owner.priv, owner.pub, method, url, body, nextTs());
}

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
    payload: ownerBody('POST', '/switch/create', { intervalSec: 1800, graceSec: 3600 }),
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
    payload: ownerBody('POST', '/switch/create', { intervalSec: 32 * 86400, graceSec: 3600 }),
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
    payload: ownerBody('POST', '/switch/create', { intervalSec: 86400, graceSec: 1800 }),
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
    payload: ownerBody('POST', '/switch/create', { intervalSec: 30, graceSec: 10 }),
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
    payload: ownerBody('POST', '/switch/create', { intervalSec: 30, graceSec: 5 }),
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
    payload: ownerBody('POST', '/switch/create', { intervalSec: 86400, graceSec: 21600 }),
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
    payload: ownerBody('POST', '/switch/create', { intervalSec: 604800, graceSec: 86400 }),
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
    payload: ownerBody('POST', '/switch/create', { intervalSec: 3600, graceSec: 3600 }),
  });
  ok(res.statusCode === 200, `status 200 (ricevuto: ${res.statusCode})`);
}

// ── 10) Produzione: ogni 2 giorni (172800s) → 200 ────────────────────────────
console.log('10) Produzione: preset Ogni 2 giorni (172800s) → 200');
{
  process.env['NODE_ENV'] = 'production';
  const res = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: ownerBody('POST', '/switch/create', { intervalSec: 172800, graceSec: 21600 }),
  });
  ok(res.statusCode === 200, `status 200 (ricevuto: ${res.statusCode})`);
}

// ── 11) Dev custom 60s: interval_sec=60 e grace_sec=60 nel DB ─────────────────
console.log('11) Dev custom 60s: interval_sec=60 e grace_sec=60 nel DB — non i default');
{
  process.env['NODE_ENV'] = 'test';
  const res = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: ownerBody('POST', '/switch/create', { intervalSec: 60, graceSec: 60 }),
  });
  const body = JSON.parse(res.payload) as any;
  ok(res.statusCode === 200, `status 200 (ricevuto: ${res.statusCode})`);
  ok(typeof body.switchId === 'string', `switchId presente`);

  const sw = db.prepare('SELECT interval_sec, grace_sec FROM switches WHERE id=?').get(body.switchId) as any;
  ok(sw?.interval_sec === 60,
    `interval_sec=60 nel DB (ricevuto: ${sw?.interval_sec})`);
  ok(sw?.grace_sec === 60,
    `grace_sec=60 nel DB (ricevuto: ${sw?.grace_sec})`);
}

// Helper: crea uno switch ACTIVE con un contenuto iniziale.
// Tutte le richieste HTTP usano l'owner globale.
async function mkActiveWithContent(ptr = 'ptr-0', iv = 'iv-0', label = 'Test') {
  process.env['NODE_ENV'] = 'test';
  const cr = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: ownerBody('POST', '/switch/create', { intervalSec: 30, graceSec: 10 }),
  });
  const { switchId } = JSON.parse(cr.payload) as any;
  const now = Date.now();
  db.prepare("UPDATE switches SET state='ACTIVE', next_check_at=?, armed_at=? WHERE id=?")
    .run(now + 30_000, now, switchId);
  const contentId = 'sc_test_' + Math.random().toString(36).slice(2, 8);
  db.prepare('INSERT INTO switch_contents (id, switch_id, drive_pointer, content_iv, label, created_at) VALUES (?,?,?,?,?,?)')
    .run(contentId, switchId, ptr, iv, label, now);
  return { switchId, contentId };
}

// ── 12) arm → inserisce riga in switch_contents e restituisce contentId ────────
console.log('12) arm → switch_contents ha 1 riga, risposta include contentId');
{
  process.env['NODE_ENV'] = 'test';
  const cr = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: ownerBody('POST', '/switch/create', { intervalSec: 30, graceSec: 10 }),
  });
  const { switchId } = JSON.parse(cr.payload) as any;

  const armRes = await app.inject({
    method: 'POST', url: '/switch/arm',
    payload: ownerBody('POST', '/switch/arm', {
      switchId, drivePointer: 'arm-ptr', contentIv: 'arm-iv', label: 'Prima versione', shares: [],
    }),
  });
  const armBody = JSON.parse(armRes.payload) as any;
  ok(armRes.statusCode === 200, `arm status 200 (${armRes.statusCode})`);
  ok(typeof armBody.contentId === 'string', `contentId presente (${armBody.contentId})`);

  const rows = db.prepare('SELECT * FROM switch_contents WHERE switch_id=?').all(switchId) as any[];
  ok(rows.length === 1, `switch_contents ha 1 riga (${rows.length})`);
  ok(rows[0].drive_pointer === 'arm-ptr', `drive_pointer corretto`);
  ok(rows[0].content_iv    === 'arm-iv',  `content_iv corretto`);
  ok(rows[0].label         === 'Prima versione', `label corretto`);
}

// ── 13) add-content appende nuova riga (NON sovrascrive) ──────────────────────
console.log('13) add-content su ACTIVE → append: switch_contents ha 2 righe');
{
  const { switchId } = await mkActiveWithContent('old-ptr', 'old-iv', 'Contenuto 1');

  const addRes = await app.inject({
    method: 'POST', url: '/switch/add-content',
    payload: ownerBody('POST', '/switch/add-content', {
      switchId, drivePointer: 'new-ptr', contentIv: 'new-iv', label: 'Contenuto 2',
    }),
  });
  const addBody = JSON.parse(addRes.payload) as any;
  ok(addRes.statusCode === 200, `status 200 (${addRes.statusCode})`);
  ok(addBody.ok === true, 'ok === true');
  ok(typeof addBody.contentId === 'string', `contentId presente`);
  ok(typeof addBody.nextCheckAt === 'number', `nextCheckAt presente`);

  const rows = db.prepare('SELECT drive_pointer FROM switch_contents WHERE switch_id=? ORDER BY created_at').all(switchId) as any[];
  ok(rows.length === 2, `2 righe in switch_contents (${rows.length})`);
  ok(rows[0].drive_pointer === 'old-ptr', `prima riga intatta`);
  ok(rows[1].drive_pointer === 'new-ptr', `seconda riga aggiunta`);
}

// ── 14) add-content resetta il timer ─────────────────────────────────────────
console.log('14) add-content → next_check_at rinnovato');
{
  const { switchId } = await mkActiveWithContent();
  const before = (db.prepare('SELECT next_check_at FROM switches WHERE id=?').get(switchId) as any).next_check_at;

  await new Promise(r => setTimeout(r, 5));
  await app.inject({
    method: 'POST', url: '/switch/add-content',
    payload: ownerBody('POST', '/switch/add-content', { switchId, drivePointer: 'p2', contentIv: 'iv2' }),
  });
  const after = (db.prepare('SELECT next_check_at FROM switches WHERE id=?').get(switchId) as any).next_check_at;
  ok(after !== before, `next_check_at cambiato (${before} → ${after})`);
}

// ── 15) add-content DISARMED → 409 ────────────────────────────────────────────
console.log('15) add-content su DISARMED → 409');
{
  process.env['NODE_ENV'] = 'test';
  const cr = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: ownerBody('POST', '/switch/create', { intervalSec: 30, graceSec: 10 }),
  });
  const { switchId } = JSON.parse(cr.payload) as any;
  const res = await app.inject({
    method: 'POST', url: '/switch/add-content',
    payload: ownerBody('POST', '/switch/add-content', { switchId, drivePointer: 'p', contentIv: 'iv' }),
  });
  const body = JSON.parse(res.payload) as any;
  ok(res.statusCode === 409, `status 409 (${res.statusCode})`);
  ok(body.error === 'switch_non_attivo', `error corretto`);
}

// ── 16) add-content switch inesistente → 401 (owner-of-switch lookup fallisce) ─
console.log('16) add-content switch inesistente → 401');
{
  const res = await app.inject({
    method: 'POST', url: '/switch/add-content',
    payload: ownerBody('POST', '/switch/add-content', { switchId: 'sw_nonexistent_xyz', drivePointer: 'p', contentIv: 'iv' }),
  });
  // Auth lookup: owner-of-switch join non trova righe → 401
  ok(res.statusCode === 401 || res.statusCode === 404, `status 401 o 404 (${res.statusCode})`);
}

// ── 17) add-content APPROVAL_PENDING → 409 ────────────────────────────────────
console.log('17) add-content APPROVAL_PENDING → 409');
{
  const { switchId } = await mkActiveWithContent();
  db.prepare("UPDATE switches SET state='APPROVAL_PENDING' WHERE id=?").run(switchId);
  const res = await app.inject({
    method: 'POST', url: '/switch/add-content',
    payload: ownerBody('POST', '/switch/add-content', { switchId, drivePointer: 'p', contentIv: 'iv' }),
  });
  ok(res.statusCode === 409, `status 409 (${res.statusCode})`);
}

// ── 18) remove-content: rimuove riga, resetta timer ───────────────────────────
console.log('18) remove-content → riga rimossa, timer resettato');
{
  const { switchId, contentId: firstId } = await mkActiveWithContent('p1', 'iv1', 'A');
  const addRes = await app.inject({
    method: 'POST', url: '/switch/add-content',
    payload: ownerBody('POST', '/switch/add-content', { switchId, drivePointer: 'p2', contentIv: 'iv2', label: 'B' }),
  });
  const { contentId: secondId } = JSON.parse(addRes.payload) as any;
  const before = (db.prepare('SELECT next_check_at FROM switches WHERE id=?').get(switchId) as any).next_check_at;

  await new Promise(r => setTimeout(r, 5));
  const rmRes = await app.inject({
    method: 'POST', url: '/switch/remove-content',
    payload: ownerBody('POST', '/switch/remove-content', { switchId, contentId: firstId }),
  });
  const rmBody = JSON.parse(rmRes.payload) as any;
  ok(rmRes.statusCode === 200, `status 200 (${rmRes.statusCode})`);
  ok(rmBody.ok === true, 'ok === true');
  ok(typeof rmBody.nextCheckAt === 'number', 'nextCheckAt presente');

  const rows = db.prepare('SELECT id FROM switch_contents WHERE switch_id=?').all(switchId) as any[];
  ok(rows.length === 1, `1 riga rimasta (${rows.length})`);
  ok(rows[0].id === secondId, `rimasto il secondo contenuto`);
  const after = (db.prepare('SELECT next_check_at FROM switches WHERE id=?').get(switchId) as any).next_check_at;
  ok(after !== before, 'timer resettato dopo rimozione');
}

// ── 19) remove-content ultimo contenuto → 409 ─────────────────────────────────
console.log('19) remove-content su ultimo contenuto → 409 (minimo un contenuto)');
{
  const { switchId, contentId } = await mkActiveWithContent();
  const res = await app.inject({
    method: 'POST', url: '/switch/remove-content',
    payload: ownerBody('POST', '/switch/remove-content', { switchId, contentId }),
  });
  const body = JSON.parse(res.payload) as any;
  ok(res.statusCode === 409, `status 409 (${res.statusCode})`);
  ok(body.error === 'contenuto_minimo', `error=contenuto_minimo`);
  const rows = db.prepare('SELECT id FROM switch_contents WHERE switch_id=?').all(switchId) as any[];
  ok(rows.length === 1, `riga intatta nel DB`);
}

// ── 20) remove-content switch inesistente → 401 ───────────────────────────────
console.log('20) remove-content switch inesistente → 401');
{
  const res = await app.inject({
    method: 'POST', url: '/switch/remove-content',
    payload: ownerBody('POST', '/switch/remove-content', { switchId: 'sw_xxx', contentId: 'sc_xxx' }),
  });
  ok(res.statusCode === 401 || res.statusCode === 404, `status 401 o 404 (${res.statusCode})`);
}

// ── 21) remove-content switch DISARMED → 409 ──────────────────────────────────
console.log('21) remove-content switch DISARMED → 409');
{
  process.env['NODE_ENV'] = 'test';
  const cr = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: ownerBody('POST', '/switch/create', { intervalSec: 30, graceSec: 10 }),
  });
  const { switchId } = JSON.parse(cr.payload) as any;
  const res = await app.inject({
    method: 'POST', url: '/switch/remove-content',
    payload: ownerBody('POST', '/switch/remove-content', { switchId, contentId: 'sc_whatever' }),
  });
  ok(res.statusCode === 409, `status 409 (${res.statusCode})`);
}

// ── 22) /switch/contents → lista label/id (no puntatori) ─────────────────────
console.log('22) /switch/contents → lista label+id, nessun pointer esposto');
{
  const { switchId } = await mkActiveWithContent('secret-ptr', 'iv', 'Primo');
  await app.inject({
    method: 'POST', url: '/switch/add-content',
    payload: ownerBody('POST', '/switch/add-content', {
      switchId, drivePointer: 'secret-ptr2', contentIv: 'iv2', label: 'Secondo',
    }),
  });

  const res = await app.inject({ method: 'GET', url: `/switch/contents?switchId=${switchId}` });
  const body = JSON.parse(res.payload) as any;
  ok(res.statusCode === 200, `status 200`);
  ok(Array.isArray(body.contents), 'contents è array');
  ok(body.contents.length === 2, `2 contenuti (${body.contents.length})`);
  ok(body.contents[0].label === 'Primo',   `primo label corretto`);
  ok(body.contents[1].label === 'Secondo', `secondo label corretto`);
  ok(typeof body.contents[0].id === 'string', `id presente`);
  ok(typeof body.contents[0].created_at === 'number', `created_at presente`);
  ok(!('drive_pointer' in body.contents[0]), `drive_pointer NON esposto`);
  ok(!('content_iv'    in body.contents[0]), `content_iv NON esposto`);
}

// ── 23) arm + 2 add-content → 3 righe in switch_contents ─────────────────────
console.log('23) arm + 2× add-content → 3 righe totali nel pacchetto');
{
  process.env['NODE_ENV'] = 'test';
  const cr = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: ownerBody('POST', '/switch/create', { intervalSec: 30, graceSec: 10 }),
  });
  const { switchId } = JSON.parse(cr.payload) as any;

  await app.inject({
    method: 'POST', url: '/switch/arm',
    payload: ownerBody('POST', '/switch/arm', {
      switchId, drivePointer: 'p0', contentIv: 'iv0', label: 'Base', shares: [],
    }),
  });
  await app.inject({
    method: 'POST', url: '/switch/add-content',
    payload: ownerBody('POST', '/switch/add-content', { switchId, drivePointer: 'p1', contentIv: 'iv1', label: 'Aggiunta 1' }),
  });
  await app.inject({
    method: 'POST', url: '/switch/add-content',
    payload: ownerBody('POST', '/switch/add-content', { switchId, drivePointer: 'p2', contentIv: 'iv2', label: 'Aggiunta 2' }),
  });

  const rows = db.prepare('SELECT drive_pointer FROM switch_contents WHERE switch_id=? ORDER BY created_at').all(switchId) as any[];
  ok(rows.length === 3, `3 righe in switch_contents (${rows.length})`);
  ok(rows[0].drive_pointer === 'p0', `riga 1: p0`);
  ok(rows[1].drive_pointer === 'p1', `riga 2: p1`);
  ok(rows[2].drive_pointer === 'p2', `riga 3: p2`);
}

console.log(`\nRisultato: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
