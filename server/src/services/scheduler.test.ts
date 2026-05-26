// Unit test per lo scheduler (ciclo ACTIVE→GRACE→APPROVAL_PENDING).
// Usa DB in-memory e pushFn mock: nessuna chiamata a Expo/FCM.
// Struttura: ogni sezione è indipendente (ID unici via nanoid).
export {}; // marca il file come modulo ES per tsc (evita conflitti di scope)

process.env['DB_PATH'] = ':memory:';

const { db } = await import('../db.js');
const { tick } = await import('./scheduler.js');
const { nanoid } = await import('nanoid');

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => {
  if (c) { pass++; console.log('  ✓', m); }
  else   { fail++; console.log('  ✗ FAIL:', m); }
};

// Logger silenzioso per i test
const nullLog = { info: () => {}, warn: () => {} };

// ── Helpers di setup ──────────────────────────────────────────────────────────
function mkOwner(pushToken?: string) {
  const id = 'usr_' + nanoid(8);
  db.prepare('INSERT INTO users (id, display_name, public_key, push_token, created_at) VALUES (?,?,?,?,?)')
    .run(id, 'TestOwner', '04' + nanoid(32), pushToken ?? null, Date.now());
  return id;
}

function mkContact(ownerId: string, pushToken?: string) {
  const id = 'c_' + nanoid(8);
  db.prepare('INSERT INTO contacts (id, owner_id, public_key, push_token, to_hash, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, ownerId, '04' + nanoid(32), pushToken ?? null, 'th_' + nanoid(8), Date.now());
  return id;
}

function mkActiveSwitch(ownerId: string, opts: { intervalSec: number; graceSec: number; armedAt: number }) {
  const id = 'sw_' + nanoid(8);
  const nextCheckAt = opts.armedAt + opts.intervalSec * 1000;
  db.prepare(
    "INSERT INTO switches (id, owner_id, state, interval_sec, grace_sec, next_check_at, armed_at) VALUES (?,?,'ACTIVE',?,?,?,?)"
  ).run(id, ownerId, opts.intervalSec, opts.graceSec, nextCheckAt, opts.armedAt);
  return { id, nextCheckAt };
}

function swState(switchId: string): string {
  return (db.prepare('SELECT state FROM switches WHERE id=?').get(switchId) as any).state;
}
function swNextCheck(switchId: string): number {
  return (db.prepare('SELECT next_check_at FROM switches WHERE id=?').get(switchId) as any).next_check_at;
}

// ── Parametri base ─────────────────────────────────────────────────────────────
const T0          = 1_000_000_000; // ms base
const INTERVAL    = 60;            // 60 s
const GRACE       = 30;            // 30 s

// Il tick processa TUTTI gli switch ACTIVE/GRACE nel DB condiviso.
// Resetta tra sezioni per evitare che switch rimasti da sezioni precedenti
// vengano processati dai tick successivi.
function resetDb() {
  db.prepare('DELETE FROM switches').run();
  db.prepare('DELETE FROM contacts').run();
  db.prepare('DELETE FROM users').run();
  db.prepare('DELETE FROM audit').run();
}

// ── 1) Nessuna transizione prima della scadenza ───────────────────────────────
console.log('1) Tick prima della scadenza → nessuna transizione');
{
  resetDb();
  const calls: unknown[][] = [];
  const mockPush = (msgs: unknown[]) => { calls.push(msgs); };

  const ownerId = mkOwner('ExponentPushToken[owner_001]');
  const { id: swId, nextCheckAt } = mkActiveSwitch(ownerId, { intervalSec: INTERVAL, graceSec: GRACE, armedAt: T0 });

  tick(nextCheckAt - 1, nullLog, mockPush as any);
  ok(swState(swId) === 'ACTIVE', 'stato rimane ACTIVE');
  ok(calls.length === 0, 'pushFn non chiamata');
}

// ── 2) Transizione ACTIVE → GRACE al tick esatto ─────────────────────────────
console.log('2) ACTIVE → GRACE: stato, next_check_at, push owner');
{
  resetDb();
  const calls: unknown[][] = [];
  const mockPush = (msgs: unknown[]) => { calls.push(msgs); };

  const OWNER_TOKEN = 'ExponentPushToken[owner_002]';
  const ownerId = mkOwner(OWNER_TOKEN);
  const { id: swId, nextCheckAt } = mkActiveSwitch(ownerId, { intervalSec: INTERVAL, graceSec: GRACE, armedAt: T0 });

  const T1 = nextCheckAt; // esattamente al limite
  tick(T1, nullLog, mockPush as any);

  ok(swState(swId) === 'GRACE', 'stato → GRACE');
  ok(swNextCheck(swId) === T1 + GRACE * 1000, `next_check_at = T1 + grace (${swNextCheck(swId)} vs ${T1 + GRACE * 1000})`);
  ok(calls.length === 1, 'pushFn chiamata esattamente una volta');
  const msgs = calls[0] as any[];
  ok(msgs.length === 1, 'un solo messaggio push');
  ok(msgs[0].to === OWNER_TOKEN, 'push inviata al token dell\'owner');
  ok(msgs[0].data?.type === 'checkin', 'data.type === "checkin"');
}

// ── 3) Idempotenza: nessuna seconda push su tick ripetuto in GRACE ────────────
console.log('3) Idempotenza GRACE: tick ripetuto non invia una seconda push');
{
  resetDb();
  const calls: unknown[][] = [];
  const mockPush = (msgs: unknown[]) => { calls.push(msgs); };

  const ownerId = mkOwner('ExponentPushToken[owner_003]');
  const { id: swId, nextCheckAt } = mkActiveSwitch(ownerId, { intervalSec: INTERVAL, graceSec: GRACE, armedAt: T0 });

  const T1 = nextCheckAt;
  tick(T1, nullLog, mockPush as any); // prima transizione
  const callsAfterFirst = calls.length;
  ok(swState(swId) === 'GRACE', 'transizione avvenuta');

  tick(T1, nullLog, mockPush as any); // stesso istante
  tick(T1, nullLog, mockPush as any); // ancora
  ok(calls.length === callsAfterFirst, 'nessuna push aggiuntiva su tick ripetuti');
  ok(swState(swId) === 'GRACE', 'stato rimane GRACE');
}

// ── 4) Nessuna transizione GRACE prima della scadenza della grazia ────────────
console.log('4) Tick in GRACE prima della scadenza → nessuna transizione');
{
  resetDb();
  const calls: unknown[][] = [];
  const mockPush = (msgs: unknown[]) => { calls.push(msgs); };

  const ownerId = mkOwner('ExponentPushToken[owner_004]');
  const { id: swId, nextCheckAt } = mkActiveSwitch(ownerId, { intervalSec: INTERVAL, graceSec: GRACE, armedAt: T0 });

  tick(nextCheckAt, nullLog, mockPush as any); // ACTIVE→GRACE, T_grace_deadline = nextCheckAt + GRACE*1000
  const graceDeadline = swNextCheck(swId);
  calls.length = 0; // resetta contatore

  tick(graceDeadline - 1, nullLog, mockPush as any); // 1 ms prima
  ok(swState(swId) === 'GRACE', 'ancora GRACE');
  ok(calls.length === 0, 'pushFn non chiamata');
}

// ── 5) Transizione GRACE → APPROVAL_PENDING con push ai contatti ─────────────
console.log('5) GRACE → APPROVAL_PENDING: stato e push ai contatti');
{
  resetDb();
  const calls: unknown[][] = [];
  const mockPush = (msgs: unknown[]) => { calls.push(msgs); };

  const CONTACT_TOKEN_A = 'ExponentPushToken[contact_005a]';
  const CONTACT_TOKEN_B = 'ExponentPushToken[contact_005b]';

  const ownerId = mkOwner('ExponentPushToken[owner_005]');
  mkContact(ownerId, CONTACT_TOKEN_A);
  mkContact(ownerId, CONTACT_TOKEN_B);
  const { id: swId, nextCheckAt } = mkActiveSwitch(ownerId, { intervalSec: INTERVAL, graceSec: GRACE, armedAt: T0 });

  tick(nextCheckAt, nullLog, mockPush as any);         // ACTIVE→GRACE
  const graceDeadline = swNextCheck(swId);
  calls.length = 0;

  tick(graceDeadline, nullLog, mockPush as any);       // GRACE→APPROVAL_PENDING
  ok(swState(swId) === 'APPROVAL_PENDING', 'stato → APPROVAL_PENDING');
  ok(calls.length === 1, 'pushFn chiamata una volta');
  const msgs = calls[0] as any[];
  ok(msgs.length === 2, 'due messaggi push (uno per contatto)');
  const tokens = msgs.map((m: any) => m.to);
  ok(tokens.includes(CONTACT_TOKEN_A), 'push a contatto A');
  ok(tokens.includes(CONTACT_TOKEN_B), 'push a contatto B');
  ok(msgs.every((m: any) => m.data?.type === 'approval'), 'data.type === "approval" per tutti');
}

// ── 6) Idempotenza APPROVAL_PENDING: nessuna push aggiuntiva ─────────────────
console.log('6) Idempotenza APPROVAL_PENDING: tick ripetuti non inviano push');
{
  resetDb();
  const calls: unknown[][] = [];
  const mockPush = (msgs: unknown[]) => { calls.push(msgs); };

  const ownerId = mkOwner('ExponentPushToken[owner_006]');
  mkContact(ownerId, 'ExponentPushToken[contact_006]');
  const { id: swId, nextCheckAt } = mkActiveSwitch(ownerId, { intervalSec: INTERVAL, graceSec: GRACE, armedAt: T0 });

  tick(nextCheckAt, nullLog, mockPush as any);
  const graceDeadline = swNextCheck(swId);
  tick(graceDeadline, nullLog, mockPush as any);       // GRACE→APPROVAL_PENDING
  const callsAfterTransition = calls.length;

  // Tick aggiuntivi allo stesso istante o oltre
  tick(graceDeadline, nullLog, mockPush as any);
  tick(graceDeadline + 10_000, nullLog, mockPush as any);
  ok(calls.length === callsAfterTransition, 'nessuna push aggiuntiva dopo APPROVAL_PENDING');
  ok(swState(swId) === 'APPROVAL_PENDING', 'stato stabile');
}

// ── 7) Nessuna push se owner non ha push token ────────────────────────────────
console.log('7) Nessuna push se owner non ha push_token');
{
  resetDb();
  const calls: unknown[][] = [];
  const mockPush = (msgs: unknown[]) => { calls.push(msgs); };

  const ownerId = mkOwner(/* senza token */);
  const { id: swId, nextCheckAt } = mkActiveSwitch(ownerId, { intervalSec: INTERVAL, graceSec: GRACE, armedAt: T0 });

  tick(nextCheckAt, nullLog, mockPush as any);
  ok(swState(swId) === 'GRACE', 'transizione ACTIVE→GRACE avviene comunque');
  ok(calls.length === 0, 'pushFn non chiamata (nessun token owner)');
}

// ── 8) Nessuna push ai contatti senza push token ─────────────────────────────
console.log('8) Contatti senza push_token: push non inviata');
{
  resetDb();
  const calls: unknown[][] = [];
  const mockPush = (msgs: unknown[]) => { calls.push(msgs); };

  const ownerId = mkOwner('ExponentPushToken[owner_008]');
  mkContact(ownerId, /* senza token */);
  mkContact(ownerId, /* senza token */);
  const { id: swId, nextCheckAt } = mkActiveSwitch(ownerId, { intervalSec: INTERVAL, graceSec: GRACE, armedAt: T0 });

  tick(nextCheckAt, nullLog, mockPush as any);
  const graceDeadline = swNextCheck(swId);
  calls.length = 0;

  tick(graceDeadline, nullLog, mockPush as any);
  ok(swState(swId) === 'APPROVAL_PENDING', 'transizione GRACE→APPROVAL_PENDING avviene comunque');
  ok(calls.length === 0, 'pushFn non chiamata (nessun contatto con token)');
}

// ── 9) Solo i contatti con token ricevono la push ────────────────────────────
console.log('9) Push solo ai contatti con token (misto)');
{
  resetDb();
  const calls: unknown[][] = [];
  const mockPush = (msgs: unknown[]) => { calls.push(msgs); };

  const HAS_TOKEN = 'ExponentPushToken[contact_009_with]';
  const ownerId = mkOwner('ExponentPushToken[owner_009]');
  mkContact(ownerId, HAS_TOKEN);           // con token
  mkContact(ownerId, /* senza token */);   // senza token

  const { id: swId, nextCheckAt } = mkActiveSwitch(ownerId, { intervalSec: INTERVAL, graceSec: GRACE, armedAt: T0 });
  tick(nextCheckAt, nullLog, mockPush as any);
  const graceDeadline = swNextCheck(swId);
  calls.length = 0;

  tick(graceDeadline, nullLog, mockPush as any);
  ok(calls.length === 1, 'pushFn chiamata una volta');
  const msgs = calls[0] as any[];
  ok(msgs.length === 1, 'un solo messaggio (solo contatto con token)');
  ok(msgs[0].to === HAS_TOKEN, 'push inviata al contatto con token');
}

// ── 10) Più switch indipendenti nello stesso tick ─────────────────────────────
console.log('10) Più switch: ogni switch transisce indipendentemente');
{
  resetDb();
  const calls: unknown[][] = [];
  const mockPush = (msgs: unknown[]) => { calls.push(msgs); };

  const ownerA = mkOwner('ExponentPushToken[ownerA_010]');
  const ownerB = mkOwner('ExponentPushToken[ownerB_010]');

  const { id: swA, nextCheckAt: deadA } = mkActiveSwitch(ownerA, { intervalSec: INTERVAL, graceSec: GRACE, armedAt: T0 });
  // switch B scade 10 s dopo
  const { id: swB, nextCheckAt: deadB } = mkActiveSwitch(ownerB, { intervalSec: INTERVAL + 10, graceSec: GRACE, armedAt: T0 });

  // Tick alla scadenza di A ma non di B
  tick(deadA, nullLog, mockPush as any);
  ok(swState(swA) === 'GRACE', 'switch A → GRACE');
  ok(swState(swB) === 'ACTIVE', 'switch B rimane ACTIVE');
  ok(calls.length === 1, 'una sola push (solo per A)');

  // Tick alla scadenza di B
  calls.length = 0;
  tick(deadB, nullLog, mockPush as any);
  ok(swState(swB) === 'GRACE', 'switch B → GRACE');
  ok(calls.length === 1, 'una push per B');
}

console.log(`\nRisultato: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
