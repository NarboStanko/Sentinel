// Test suite: autenticazione a firma su tutte le rotte protette (Fase 1 + Fase 2)
// Verifica: 401 senza firma, ts scaduto, payload manomesso, ruolo sbagliato, replay; 200 con firma valida
// Esegui con: npm run test:auth

export {};

process.env['DB_PATH'] = ':memory:';

const { default: Fastify }        = await import('fastify');
const { pairingRoutes }           = await import('./pairing.js');
const { switchRoutes }            = await import('./switch.js');
const { approvalRoutes }          = await import('./approvals.js');
const { checkinRoutes }           = await import('./checkin.js');
const { pushRoutes }              = await import('./push.js');
const { recoveryRoutes }          = await import('./recovery.js');
const { auditRoutes }             = await import('./audit.js');
const { registerIpRateLimitHook } = await import('../services/rateLimiter.js');
const { clearNonceCache, canonicalize } = await import('../middleware/auth.js');
const { canonicalize: canonicalizeClient } = await import('../../../app/lib/canonicalize.js');
const { db }                      = await import('../db.js');
const { p256 }                    = await import('@noble/curves/p256');
const { sha256 }                  = await import('@noble/hashes/sha256');
const { bytesToHex }              = await import('@noble/hashes/utils');
const { hexToBytes }              = await import('@noble/curves/abstract/utils');

// ── App ────────────────────────────────────────────────────────────────────────
const app = Fastify({ logger: false, trustProxy: true });
registerIpRateLimitHook(app);
await app.register(pairingRoutes);
await app.register(switchRoutes);
await app.register(approvalRoutes);
await app.register(checkinRoutes);
await app.register(pushRoutes);
await app.register(recoveryRoutes);
await app.register(auditRoutes);
await app.ready();

// ── Helpers ────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  clearNonceCache();
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

function signRequest(
  priv: Uint8Array,
  pub: string,
  method: string,
  urlPath: string,
  ts: number,
  body: Record<string, unknown>,
): string {
  const hash = sha256(new TextEncoder().encode(canonicalize(method, urlPath, ts, pub, body)));
  return bytesToHex(p256.sign(hash, priv).toCompactRawBytes());
}

// Produce il payload firmato completo da inviare come body della richiesta.
function signed(
  priv: Uint8Array,
  pub: string,
  method: string,
  urlPath: string,
  body: Record<string, unknown>,
  ts?: number,
): Record<string, unknown> {
  const t = ts ?? nextTs();
  return { ...body, pub, ts: t, sig: signRequest(priv, pub, method, urlPath, t, body) };
}

let _ts = Date.now();
function nextTs() { return ++_ts; }

// Crea owner, contatto e switch APPROVAL_PENDING pronti per /release/confirm
async function mkScenario() {
  const ownerPriv = p256.utils.randomPrivateKey();
  const ownerPub  = bytesToHex(p256.getPublicKey(ownerPriv, true));
  const { ownerId } = JSON.parse(
    (await app.inject({ method: 'POST', url: '/owner/register', payload: { publicKey: ownerPub } })).payload
  ) as { ownerId: string };

  const contactPriv = p256.utils.randomPrivateKey();
  const contactPub  = bytesToHex(p256.getPublicKey(contactPriv, true));

  // Firma l'invito (ora richiede auth owner)
  const inviteTs = nextTs();
  const inviteSig = signRequest(ownerPriv, ownerPub, 'POST', '/invite', inviteTs, {});
  const { token } = JSON.parse(
    (await app.inject({ method: 'POST', url: '/invite', payload: { pub: ownerPub, ts: inviteTs, sig: inviteSig } })).payload
  ) as { token: string };

  const { contactId } = JSON.parse(
    (await app.inject({ method: 'POST', url: '/pair', payload: { token, contactPublicKey: contactPub, pushToken: `t_${ownerId}` } })).payload
  ) as { contactId: string };

  const switchId = `sw_auth_${ownerId.slice(-4)}_${Date.now()}`;
  db.prepare('INSERT INTO switches (id, owner_id, state, interval_sec, grace_sec) VALUES (?,?,?,?,?)')
    .run(switchId, ownerId, 'APPROVAL_PENDING', 86400, 3600);

  return { ownerId, ownerPriv, ownerPub, contactId, contactPriv, contactPub, switchId };
}

// ── Tests 1–10: /release/confirm (Fase 1) ─────────────────────────────────────
console.log('\nAuth tests — /release/confirm (Fase 1)\n');

// 1. Nessun campo di firma → 401
await test('1) nessun campo pub/ts/sig → 401', async () => {
  const { switchId } = await mkScenario();
  const r = await app.inject({ method: 'POST', url: '/release/confirm', payload: { switchId } });
  if (r.statusCode !== 401) throw new Error(`atteso 401, ricevuto ${r.statusCode}`);
  const body = JSON.parse(r.payload);
  if (body.error !== 'auth_failed') throw new Error(`atteso auth_failed, ricevuto ${body.error}`);
});

// 2. Timestamp scaduto (> 5 min fa) → 401
await test('2) timestamp scaduto (6 min fa) → 401', async () => {
  const { switchId, contactPriv, contactPub } = await mkScenario();
  const ts  = Date.now() - 6 * 60_000;
  const sig = signRequest(contactPriv, contactPub, 'POST', '/release/confirm', ts, { switchId });
  const r = await app.inject({ method: 'POST', url: '/release/confirm', payload: { switchId, pub: contactPub, ts, sig } });
  if (r.statusCode !== 401) throw new Error(`atteso 401, ricevuto ${r.statusCode}`);
});

// 3. Payload manomesso dopo la firma → 401
await test('3) payload manomesso (switchId alterato dopo firma) → 401', async () => {
  const { switchId, contactPriv, contactPub } = await mkScenario();
  const ts  = nextTs();
  const sig = signRequest(contactPriv, contactPub, 'POST', '/release/confirm', ts, { switchId });
  const r = await app.inject({
    method: 'POST', url: '/release/confirm',
    payload: { switchId: 'sw_tampered_000', pub: contactPub, ts, sig },
  });
  if (r.statusCode !== 401) throw new Error(`atteso 401, ricevuto ${r.statusCode}`);
});

// 4. Chiave di owner (ruolo sbagliato) → 401
await test('4) firma con chiave owner invece di contatto → 401', async () => {
  const { switchId, ownerPriv, ownerPub } = await mkScenario();
  const ts  = nextTs();
  const sig = signRequest(ownerPriv, ownerPub, 'POST', '/release/confirm', ts, { switchId });
  const r = await app.inject({ method: 'POST', url: '/release/confirm', payload: { switchId, pub: ownerPub, ts, sig } });
  if (r.statusCode !== 401) throw new Error(`atteso 401, ricevuto ${r.statusCode}`);
});

// 5. Firma valida + ruolo corretto → 200
await test('5) firma valida — contatto dello switch → 200, stato RELEASED', async () => {
  const { switchId, contactPriv, contactPub } = await mkScenario();
  const ts  = nextTs();
  const sig = signRequest(contactPriv, contactPub, 'POST', '/release/confirm', ts, { switchId });
  const r = await app.inject({ method: 'POST', url: '/release/confirm', payload: { switchId, pub: contactPub, ts, sig } });
  if (r.statusCode !== 200) throw new Error(`atteso 200, ricevuto ${r.statusCode}: ${r.payload}`);
  const sw = db.prepare('SELECT state FROM switches WHERE id=?').get(switchId) as { state: string } | undefined;
  if (sw?.state !== 'RELEASED') throw new Error(`atteso RELEASED, trovato ${sw?.state}`);
});

// 6. Replay dello stesso (pub, ts, sig) → 401
await test('6) replay — stessa firma riutilizzata → 401', async () => {
  const { switchId, contactPriv, contactPub } = await mkScenario();
  const ts  = nextTs();
  const sig = signRequest(contactPriv, contactPub, 'POST', '/release/confirm', ts, { switchId });
  const payload = { switchId, pub: contactPub, ts, sig };
  const r1 = await app.inject({ method: 'POST', url: '/release/confirm', payload });
  if (r1.statusCode !== 200) throw new Error(`prima chiamata: atteso 200, ricevuto ${r1.statusCode}`);
  const r2 = await app.inject({ method: 'POST', url: '/release/confirm', payload });
  if (r2.statusCode !== 401) throw new Error(`replay: atteso 401, ricevuto ${r2.statusCode}`);
});

// 6b. Anti-replay PERSISTENTE (A2): il nonce visto sta in seen_nonces (SQLite),
//     non in una Map in memoria → sopravvive al riavvio del server. Un riavvio
//     azzererebbe solo la memoria del processo, mai la tabella: se il nonce è
//     nel DB, il replay resta 401 anche dopo restart.
await test('6b) anti-replay persistente — nonce nel DB, replay 401 dopo "riavvio"', async () => {
  const { switchId, contactPriv, contactPub } = await mkScenario();
  const ts  = nextTs();
  const sig = signRequest(contactPriv, contactPub, 'POST', '/release/confirm', ts, { switchId });
  const payload = { switchId, pub: contactPub, ts, sig };
  const r1 = await app.inject({ method: 'POST', url: '/release/confirm', payload });
  if (r1.statusCode !== 200) throw new Error(`prima chiamata: atteso 200, ricevuto ${r1.statusCode}`);
  // Il nonce deve essere PERSISTITO nella tabella, non in memoria.
  const row = db.prepare('SELECT inserted_at FROM seen_nonces WHERE key = ?')
    .get(`${contactPub}:${ts}:${sig}`) as { inserted_at: number } | undefined;
  if (!row) throw new Error('nonce non trovato in seen_nonces: la persistenza non funziona');
  // "Riavvio" simulato: la memoria del processo non custodisce più alcuno stato
  // anti-replay (non esiste più la Map); ciò che conta è solo il DB, che dopo
  // un restart reale è intatto. Il replay deve restare 401.
  const r2 = await app.inject({ method: 'POST', url: '/release/confirm', payload });
  if (r2.statusCode !== 401) throw new Error(`replay post-riavvio: atteso 401, ricevuto ${r2.statusCode}`);
});

// 7. Contatto di uno switch diverso (non collegato a questo switch) → 401
await test('7) contatto valido ma di uno switch diverso → 401', async () => {
  const s1 = await mkScenario();
  const s2 = await mkScenario();
  const ts  = nextTs();
  const sig = signRequest(s2.contactPriv, s2.contactPub, 'POST', '/release/confirm', ts, { switchId: s1.switchId });
  const r = await app.inject({
    method: 'POST', url: '/release/confirm',
    payload: { switchId: s1.switchId, pub: s2.contactPub, ts, sig },
  });
  if (r.statusCode !== 401) throw new Error(`atteso 401, ricevuto ${r.statusCode}`);
});

// 8. Deep sort — oggetti annidati con chiavi in ordine diverso → stringa identica
await test('8) canonicalize deep sort — chiavi annidate in ordine diverso → stessa stringa', async () => {
  const ts  = 1_000_000_000;
  const pub = 'aabbcc';
  const c1 = canonicalize('POST', '/test', ts, pub, { a: 1, share: { y: 'foo', x: 1 } });
  const c2 = canonicalize('POST', '/test', ts, pub, { share: { x: 1, y: 'foo' }, a: 1 });
  if (c1 !== c2) throw new Error(`canonicalize diverge:\n  A: ${c1}\n  B: ${c2}`);
  const expected = `POST|/test|${ts}|${pub}|${JSON.stringify({ a: 1, share: { x: 1, y: 'foo' } })}`;
  if (c1 !== expected) throw new Error(`valore atteso diverso:\n  ottenuto: ${c1}\n  atteso:   ${expected}`);
});

// 9. Equivalenza client ≡ server — stessa stringa su payload identico
await test('9) canonicalize client ≡ server — output bit-per-bit identico', async () => {
  const ts   = 1_000_000_001;
  const pub  = 'deadbeef';
  const body = { switchId: 'sw_x', share: { y: 'abc', x: 2 } };
  const s = canonicalize('POST', '/release/confirm', ts, pub, body);
  const c = canonicalizeClient('POST', '/release/confirm', ts, pub, body);
  if (s !== c) throw new Error(`server≠client:\n  server: ${s}\n  client: ${c}`);
});

// 10. Firma client verificata dal server — P-256 round-trip
await test('10) firma client verificata dal server — P-256 round-trip', async () => {
  const priv = p256.utils.randomPrivateKey();
  const pub  = bytesToHex(p256.getPublicKey(priv, true));
  const ts   = nextTs();
  const body = { switchId: 'sw_roundtrip' };
  const canonical = canonicalizeClient('POST', '/release/confirm', ts, pub, body);
  const sig  = bytesToHex(p256.sign(sha256(new TextEncoder().encode(canonical)), priv).toCompactRawBytes());
  const hash = sha256(new TextEncoder().encode(canonical));
  const ok   = p256.verify(hexToBytes(sig), hash, hexToBytes(pub));
  if (!ok) throw new Error('firma generata con canonicalize client non verificata dal server');
});

// ── Universo globale per i test 11+ ──────────────────────────────────────────
// Inserito direttamente nel DB per evitare dipendenze da rotte di setup.
const G_PRIV   = p256.utils.randomPrivateKey();
const G_PUB    = bytesToHex(p256.getPublicKey(G_PRIV, true));
const G_ID     = 'usr_auth_g';
db.prepare('INSERT INTO users (id, public_key, created_at) VALUES (?,?,?)').run(G_ID, G_PUB, Date.now());

const GC_PRIV  = p256.utils.randomPrivateKey();
const GC_PUB   = bytesToHex(p256.getPublicKey(GC_PRIV, true));
const GC_ID    = 'c_auth_g';
db.prepare('INSERT INTO contacts (id, owner_id, public_key, push_token, to_hash, created_at) VALUES (?,?,?,?,?,?)')
  .run(GC_ID, G_ID, GC_PUB, 'push_g', 'hash_g', Date.now());

// Switch DISARMED (per arm test)
const G_DISARMED = 'sw_g_dis';
db.prepare('INSERT INTO switches (id, owner_id, state, interval_sec, grace_sec) VALUES (?,?,?,?,?)')
  .run(G_DISARMED, G_ID, 'DISARMED', 86400, 3600);

// Switch ACTIVE con 2 contenuti (per add/remove-content, checkin)
const G_ACTIVE = 'sw_g_act';
const G_NOW    = Date.now();
db.prepare('INSERT INTO switches (id, owner_id, state, interval_sec, grace_sec, last_checkin, next_check_at, armed_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(G_ACTIVE, G_ID, 'ACTIVE', 86400, 3600, G_NOW, G_NOW + 86400_000, G_NOW);
const G_C1 = 'sc_g_c1';
const G_C2 = 'sc_g_c2';
db.prepare('INSERT INTO switch_contents (id, switch_id, drive_pointer, content_iv, label, created_at) VALUES (?,?,?,?,?,?)')
  .run(G_C1, G_ACTIVE, 'ptr://1', 'iv1', 'label1', G_NOW);
db.prepare('INSERT INTO switch_contents (id, switch_id, drive_pointer, content_iv, label, created_at) VALUES (?,?,?,?,?,?)')
  .run(G_C2, G_ACTIVE, 'ptr://2', 'iv2', 'label2', G_NOW + 1);

// Switch ACTIVE separato per il test disarm (evita di rovinare gli altri)
const G_DISARM = 'sw_g_dis2';
db.prepare('INSERT INTO switches (id, owner_id, state, interval_sec, grace_sec, last_checkin, next_check_at, armed_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(G_DISARM, G_ID, 'ACTIVE', 86400, 3600, G_NOW, G_NOW + 86400_000, G_NOW);

// Switch APPROVAL_PENDING (per approval/submit)
const G_PEND = 'sw_g_pend';
db.prepare('INSERT INTO switches (id, owner_id, state, interval_sec, grace_sec) VALUES (?,?,?,?,?)')
  .run(G_PEND, G_ID, 'APPROVAL_PENDING', 86400, 3600);

// Recovery per il contatto globale
const G_REC = 'rec_auth_g';
const G_NEW_PUB = bytesToHex(p256.getPublicKey(p256.utils.randomPrivateKey(), true));
db.prepare('INSERT INTO recoveries (id, owner_id, new_public_key, unlock_at, created_at) VALUES (?,?,?,?,?)')
  .run(G_REC, G_ID, G_NEW_PUB, G_NOW + 7 * 24 * 3600_000, G_NOW);

// ── Tests 11–12: /invite (owner) ───────────────────────────────────────────────
console.log('\nAuth tests — rotte protette Fase 2\n');

await test('11) /invite — nessun auth → 401', async () => {
  const r = await app.inject({ method: 'POST', url: '/invite', payload: {} });
  if (r.statusCode !== 401) throw new Error(`atteso 401, ricevuto ${r.statusCode}`);
});

await test('12) /invite — owner auth valida → 200 con token', async () => {
  const r = await app.inject({ method: 'POST', url: '/invite', payload: signed(G_PRIV, G_PUB, 'POST', '/invite', {}) });
  if (r.statusCode !== 200) throw new Error(`atteso 200, ricevuto ${r.statusCode}: ${r.payload}`);
  const body = JSON.parse(r.payload);
  if (!body.token) throw new Error('nessun token nel payload');
});

// ── Tests 13–14: /switch/create (owner) ───────────────────────────────────────
await test('13) /switch/create — nessun auth → 401', async () => {
  const r = await app.inject({ method: 'POST', url: '/switch/create', payload: { intervalSec: 86400, graceSec: 3600 } });
  if (r.statusCode !== 401) throw new Error(`atteso 401, ricevuto ${r.statusCode}`);
});

await test('14) /switch/create — owner auth valida → 200 con switchId', async () => {
  const r = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: signed(G_PRIV, G_PUB, 'POST', '/switch/create', { intervalSec: 86400, graceSec: 3600 }),
  });
  if (r.statusCode !== 200) throw new Error(`atteso 200, ricevuto ${r.statusCode}: ${r.payload}`);
  const body = JSON.parse(r.payload);
  if (!body.switchId) throw new Error('nessun switchId nel payload');
});

// ── Tests 15–16: /switch/arm (owner-of-switch) ────────────────────────────────
await test('15) /switch/arm — nessun auth → 401', async () => {
  const r = await app.inject({
    method: 'POST', url: '/switch/arm',
    payload: { switchId: G_DISARMED, drivePointer: 'ptr://x', contentIv: 'iv0', shares: [{ blob: 'aa' }] },
  });
  if (r.statusCode !== 401) throw new Error(`atteso 401, ricevuto ${r.statusCode}`);
});

await test('16) /switch/arm — owner-of-switch auth valida → 200', async () => {
  const body = { switchId: G_DISARMED, drivePointer: 'ptr://x', contentIv: 'iv0', shares: [{ blob: 'aa' }, { blob: 'bb' }] };
  const r = await app.inject({ method: 'POST', url: '/switch/arm', payload: signed(G_PRIV, G_PUB, 'POST', '/switch/arm', body) });
  if (r.statusCode !== 200) throw new Error(`atteso 200, ricevuto ${r.statusCode}: ${r.payload}`);
});

// ── Tests 17–18: /switch/add-content (owner-of-switch) ───────────────────────
await test('17) /switch/add-content — nessun auth → 401', async () => {
  const r = await app.inject({
    method: 'POST', url: '/switch/add-content',
    payload: { switchId: G_ACTIVE, drivePointer: 'ptr://y', contentIv: 'ivy' },
  });
  if (r.statusCode !== 401) throw new Error(`atteso 401, ricevuto ${r.statusCode}`);
});

await test('18) /switch/add-content — owner-of-switch auth valida → 200', async () => {
  const body = { switchId: G_ACTIVE, drivePointer: 'ptr://y', contentIv: 'ivy' };
  const r = await app.inject({ method: 'POST', url: '/switch/add-content', payload: signed(G_PRIV, G_PUB, 'POST', '/switch/add-content', body) });
  if (r.statusCode !== 200) throw new Error(`atteso 200, ricevuto ${r.statusCode}: ${r.payload}`);
});

// ── Tests 19–20: /switch/remove-content (owner-of-switch) ────────────────────
await test('19) /switch/remove-content — nessun auth → 401', async () => {
  const r = await app.inject({
    method: 'POST', url: '/switch/remove-content',
    payload: { switchId: G_ACTIVE, contentId: G_C1 },
  });
  if (r.statusCode !== 401) throw new Error(`atteso 401, ricevuto ${r.statusCode}`);
});

await test('20) /switch/remove-content — owner-of-switch auth valida → 200', async () => {
  const body = { switchId: G_ACTIVE, contentId: G_C1 };
  const r = await app.inject({ method: 'POST', url: '/switch/remove-content', payload: signed(G_PRIV, G_PUB, 'POST', '/switch/remove-content', body) });
  if (r.statusCode !== 200) throw new Error(`atteso 200, ricevuto ${r.statusCode}: ${r.payload}`);
});

// ── Tests 21–22: /switch/disarm (owner-of-switch) ────────────────────────────
await test('21) /switch/disarm — nessun auth → 401', async () => {
  const r = await app.inject({ method: 'POST', url: '/switch/disarm', payload: { switchId: G_DISARM } });
  if (r.statusCode !== 401) throw new Error(`atteso 401, ricevuto ${r.statusCode}`);
});

await test('22) /switch/disarm — owner-of-switch auth valida → 200', async () => {
  const body = { switchId: G_DISARM };
  const r = await app.inject({ method: 'POST', url: '/switch/disarm', payload: signed(G_PRIV, G_PUB, 'POST', '/switch/disarm', body) });
  if (r.statusCode !== 200) throw new Error(`atteso 200, ricevuto ${r.statusCode}: ${r.payload}`);
});

// ── Tests 23–24: /checkin/respond (owner-of-switch) ──────────────────────────
await test('23) /checkin/respond — nessun auth → 401', async () => {
  const r = await app.inject({ method: 'POST', url: '/checkin/respond', payload: { switchId: G_ACTIVE } });
  if (r.statusCode !== 401) throw new Error(`atteso 401, ricevuto ${r.statusCode}`);
});

await test('24) /checkin/respond — owner-of-switch auth valida → 200', async () => {
  const body = { switchId: G_ACTIVE };
  const r = await app.inject({ method: 'POST', url: '/checkin/respond', payload: signed(G_PRIV, G_PUB, 'POST', '/checkin/respond', body) });
  if (r.statusCode !== 200) throw new Error(`atteso 200, ricevuto ${r.statusCode}: ${r.payload}`);
});

// ── Tests 25–26: /approval/submit (contact-of-switch) ────────────────────────
await test('25) /approval/submit — nessun auth → 401', async () => {
  const r = await app.inject({
    method: 'POST', url: '/approval/submit',
    payload: { switchId: G_PEND, share: { x: 1, y: 'AA' } },
  });
  if (r.statusCode !== 401) throw new Error(`atteso 401, ricevuto ${r.statusCode}`);
});

await test('26) /approval/submit — contact-of-switch auth valida → non 401', async () => {
  const body = { switchId: G_PEND, share: { x: 1, y: 'AA' } };
  const r = await app.inject({ method: 'POST', url: '/approval/submit', payload: signed(GC_PRIV, GC_PUB, 'POST', '/approval/submit', body) });
  if (r.statusCode === 401) throw new Error(`inatteso 401: ${r.payload}`);
});

// ── Tests 27–28: /recovery/approve (contact) ─────────────────────────────────
await test('27) /recovery/approve — nessun auth → 401', async () => {
  const r = await app.inject({ method: 'POST', url: '/recovery/approve', payload: { recoveryId: G_REC } });
  if (r.statusCode !== 401) throw new Error(`atteso 401, ricevuto ${r.statusCode}`);
});

await test('28) /recovery/approve — contact auth valida → 200', async () => {
  const body = { recoveryId: G_REC };
  const r = await app.inject({ method: 'POST', url: '/recovery/approve', payload: signed(GC_PRIV, GC_PUB, 'POST', '/recovery/approve', body) });
  if (r.statusCode !== 200) throw new Error(`atteso 200, ricevuto ${r.statusCode}: ${r.payload}`);
});

// ── Tests 29–30: /push/register (owner o contact) ────────────────────────────
await test('29) /push/register — nessun auth → 401', async () => {
  const r = await app.inject({
    method: 'POST', url: '/push/register',
    payload: { role: 'owner', id: G_ID, pushToken: 'tok_test' },
  });
  if (r.statusCode !== 401) throw new Error(`atteso 401, ricevuto ${r.statusCode}`);
});

await test('30) /push/register — owner auth valida → 200', async () => {
  const body = { role: 'owner', id: G_ID, pushToken: 'tok_test_valid' };
  const r = await app.inject({ method: 'POST', url: '/push/register', payload: signed(G_PRIV, G_PUB, 'POST', '/push/register', body) });
  if (r.statusCode !== 200) throw new Error(`atteso 200, ricevuto ${r.statusCode}: ${r.payload}`);
});

// ── Test 31: share overwrite → 409; re-invio identico → idempotente ──────────
await test('31) /approval/submit — re-invio identico → 200 collected; stesso x con y diversa → 409', async () => {
  // Inserisci una share affinché il primo submit riesca
  db.prepare('INSERT INTO shares (id, switch_id, x, blob) VALUES (?,?,?,?)').run('sh_t1', G_PEND, 99, 'blob_test');
  const body = { switchId: G_PEND, share: { x: 99, y: 'XXXX' } };
  const p1 = signed(GC_PRIV, GC_PUB, 'POST', '/approval/submit', body);
  const r1 = await app.inject({ method: 'POST', url: '/approval/submit', payload: p1 });
  if (r1.statusCode !== 200) throw new Error(`primo submit: atteso 200, ricevuto ${r1.statusCode}: ${r1.payload}`);
  // Re-invio IDENTICO (stessa x, stessa y): idempotente, restituisce le raccolte
  // (serve al contatto che riapre dopo il RELEASED per ricombinare la DEK).
  const p2 = signed(GC_PRIV, GC_PUB, 'POST', '/approval/submit', body);
  const r2 = await app.inject({ method: 'POST', url: '/approval/submit', payload: p2 });
  if (r2.statusCode !== 200) throw new Error(`re-invio identico: atteso 200, ricevuto ${r2.statusCode}: ${r2.payload}`);
  const b2 = JSON.parse(r2.payload);
  if (!Array.isArray(b2.collected) || !b2.collected.some((s: any) => s.x === 99 && s.y === 'XXXX'))
    throw new Error(`re-invio identico: collected deve contenere la quota (${r2.payload})`);
  // Stesso x ma y DIVERSA: overwrite negato → 409
  const body3 = { switchId: G_PEND, share: { x: 99, y: 'YYYY' } };
  const p3 = signed(GC_PRIV, GC_PUB, 'POST', '/approval/submit', body3);
  const r3 = await app.inject({ method: 'POST', url: '/approval/submit', payload: p3 });
  if (r3.statusCode !== 409) throw new Error(`overwrite: atteso 409, ricevuto ${r3.statusCode}: ${r3.payload}`);
  const b3 = JSON.parse(r3.payload);
  if (b3.error !== 'share_gia_sottomessa') throw new Error(`atteso share_gia_sottomessa, ricevuto ${b3.error}`);
});

// ── Test 32-33: rotte audit su firma per-richiesta (A3, niente più token) ─────
await test('32) /audit/backup-viewed — senza firma → 401; firmato → 200, evento in catena FIRMATO', async () => {
  const r0 = await app.inject({ method: 'POST', url: '/audit/backup-viewed', payload: {} });
  if (r0.statusCode !== 401) throw new Error(`senza firma: atteso 401, ricevuto ${r0.statusCode}`);
  const p = signed(G_PRIV, G_PUB, 'POST', '/audit/backup-viewed', {});
  const r1 = await app.inject({ method: 'POST', url: '/audit/backup-viewed', payload: p });
  if (r1.statusCode !== 200) throw new Error(`firmato: atteso 200, ricevuto ${r1.statusCode}: ${r1.payload}`);
  const row = db.prepare(
    "SELECT signature FROM audit_chain WHERE event_type='BACKUP_VIEWED' ORDER BY id DESC LIMIT 1"
  ).get() as { signature: string | null } | undefined;
  if (!row) throw new Error('evento BACKUP_VIEWED non trovato in catena');
  if (!row.signature) throw new Error('evento BACKUP_VIEWED in catena con signature null: deve essere firmato');
});

await test('33) /audit/seed-restore-ack — non-owner → 401; owner dello switch → 200, evento FIRMATO', async () => {
  const body = { switchId: G_PEND };
  // Il contatto NON è l'owner dello switch: firma valida ma ruolo sbagliato → 401
  const pBad = signed(GC_PRIV, GC_PUB, 'POST', '/audit/seed-restore-ack', body);
  const rBad = await app.inject({ method: 'POST', url: '/audit/seed-restore-ack', payload: pBad });
  if (rBad.statusCode !== 401) throw new Error(`non-owner: atteso 401, ricevuto ${rBad.statusCode}`);
  const p = signed(G_PRIV, G_PUB, 'POST', '/audit/seed-restore-ack', body);
  const r = await app.inject({ method: 'POST', url: '/audit/seed-restore-ack', payload: p });
  if (r.statusCode !== 200) throw new Error(`owner: atteso 200, ricevuto ${r.statusCode}: ${r.payload}`);
  const row = db.prepare(
    "SELECT signature FROM audit_chain WHERE event_type='RECOVERED_DURING_PENDING' ORDER BY id DESC LIMIT 1"
  ).get() as { signature: string | null } | undefined;
  if (!row) throw new Error('evento RECOVERED_DURING_PENDING non trovato in catena');
  if (!row.signature) throw new Error('evento RECOVERED_DURING_PENDING con signature null: deve essere firmato');
});

// ── Riepilogo ──────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} test — ${passed} ok, ${failed} falliti\n`);
if (failed > 0) process.exit(1);
