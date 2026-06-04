// Test contatti: duplicate push_token, DELETE, PUT (rotate key), reject, GET preview.
// Totale chiamate ok(): 33
export {}; // marca il file come modulo ES per tsc

// DEVE stare prima di qualunque import dinamico: db.ts legge DB_PATH al primo import.
process.env['DB_PATH'] = ':memory:';

const { default: Fastify } = await import('fastify');
const { pairingRoutes } = await import('./pairing.js');
const { switchRoutes } = await import('./switch.js');
const { db } = await import('../db.js');
const { p256 } = await import('@noble/curves/p256');
const { sha256 } = await import('@noble/hashes/sha256');
const { bytesToHex } = await import('@noble/hashes/utils');
const { signBody } = await import('../testUtils/authHelpers.js');

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => {
  if (c) { pass++; console.log('  ✓', m); }
  else   { fail++; console.log('  ✗ FAIL:', m); }
};

function signMsg(priv: Uint8Array, msg: string): string {
  const hash = sha256(new TextEncoder().encode(msg));
  return bytesToHex(p256.sign(hash, priv).toCompactRawBytes());
}

async function buildApp() {
  const app = Fastify({ logger: false });
  app.setErrorHandler((_err, _req, reply) => {
    reply.code(500).send({ error: 'internal_error', message: 'Errore interno.' });
  });
  await app.register(pairingRoutes);
  await app.register(switchRoutes);
  return app;
}

const app = await buildApp();

// Helper: crea un owner con una vera chiave P-256 e restituisce { ownerId, priv, pub }.
async function mkOwner(name: string) {
  const priv = p256.utils.randomPrivateKey();
  const pub = bytesToHex(p256.getPublicKey(priv, true));
  const res = await app.inject({ method: 'POST', url: '/owner/register', payload: { publicKey: pub, displayName: name } });
  const { ownerId } = JSON.parse(res.payload);
  return { ownerId, priv, pub };
}

// Helper: crea un invito per un owner e accoppia un contatto con pushToken dato.
// Restituisce { contactId, token }.
async function mkContact(
  owner: { ownerId: string; priv: Uint8Array; pub: string },
  pushToken: string,
  contactPublicKey?: string,
) {
  const invRes = await app.inject({
    method: 'POST',
    url: '/invite',
    payload: signBody(owner.priv, owner.pub, 'POST', '/invite', {}),
  });
  const { token } = JSON.parse(invRes.payload) as { token: string };
  const pubKey = contactPublicKey ?? bytesToHex(p256.getPublicKey(p256.utils.randomPrivateKey(), true));
  const pairRes = await app.inject({
    method: 'POST', url: '/pair',
    payload: { token, contactPublicKey: pubKey, pushToken },
  });
  const { contactId } = JSON.parse(pairRes.payload) as { contactId: string };
  return { contactId, token };
}

// ── 1) POST /pair con push_token duplicato → 409, invite NON consumato ────────
console.log('1) /pair — push_token duplicato → 409, invito non consumato');
{
  const { ownerId, priv, pub } = await mkOwner('Owner1');

  // Primo pairing con pushToken='push_abc'
  const { contactId: firstContactId } = await mkContact({ ownerId, priv, pub }, 'push_abc');

  // Secondo invito dallo stesso owner, ma stesso pushToken
  const inv2Res = await app.inject({
    method: 'POST',
    url: '/invite',
    payload: signBody(priv, pub, 'POST', '/invite', {}),
  });
  const { token: token2 } = JSON.parse(inv2Res.payload) as { token: string };
  const newPub = bytesToHex(p256.getPublicKey(p256.utils.randomPrivateKey(), true));
  const res = await app.inject({
    method: 'POST', url: '/pair',
    payload: { token: token2, contactPublicKey: newPub, pushToken: 'push_abc' },
  });
  const body = JSON.parse(res.payload) as any;
  ok(res.statusCode === 409, `status 409 (ricevuto: ${res.statusCode})`);
  ok(body.error === 'push_token_duplicato', `error=push_token_duplicato (${body.error})`);
  ok(body.existing === firstContactId, `body.existing === primo contactId (${body.existing})`);
  ok(typeof body.existing_public_key === 'string', `existing_public_key presente (${body.existing_public_key})`);

  // Verifica: il secondo invito NON è stato consumato (used=0)
  const inv2Row = db.prepare('SELECT used FROM invites WHERE token=?').get(token2) as { used: number } | undefined;
  ok(inv2Row?.used === 0, `secondo invito non consumato (used=${inv2Row?.used})`);
}

// ── 2) DELETE /contacts/:contactId — owner rimuove contatto (no switch) → 200 ─
console.log('2) DELETE /contacts/:contactId — owner rimuove contatto → 200, riga eliminata');
{
  const { ownerId, priv, pub } = await mkOwner('Owner2');
  const { contactId } = await mkContact({ ownerId, priv, pub }, 'push_del_2');

  const ts = Date.now();
  const sig = signMsg(priv, `sentinella:remove-contact:${contactId}:${ts}`);
  const res = await app.inject({
    method: 'DELETE', url: `/contacts/${contactId}`,
    payload: { ownerPub: pub, ts, sig },
  });
  const body = JSON.parse(res.payload) as any;
  ok(res.statusCode === 200, `status 200 (ricevuto: ${res.statusCode})`);
  ok(body.ok === true, 'body.ok === true');

  const row = db.prepare('SELECT id FROM contacts WHERE id=?').get(contactId);
  ok(row === undefined, 'riga contatto eliminata dal DB');

  const auditRow = db.prepare("SELECT event FROM audit WHERE event='CONTACT_REMOVED' ORDER BY id DESC LIMIT 1").get() as { event: string } | undefined;
  ok(auditRow?.event === 'CONTACT_REMOVED', 'audit event CONTACT_REMOVED presente');
}

// ── 3) DELETE /contacts/:contactId — switch ACTIVE, no force → 409 ────────────
console.log('3) DELETE /contacts/:contactId — switch ACTIVE, no force → 409');
{
  process.env['NODE_ENV'] = 'test';
  const { ownerId, priv, pub } = await mkOwner('Owner3');
  const { contactId } = await mkContact({ ownerId, priv, pub }, 'push_del_3');

  // Crea uno switch e portalo ad ACTIVE
  const swRes = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: signBody(priv, pub, 'POST', '/switch/create', { intervalSec: 30, graceSec: 10 }),
  });
  const { switchId } = JSON.parse(swRes.payload) as { switchId: string };
  const now = Date.now();
  db.prepare("UPDATE switches SET state='ACTIVE', next_check_at=?, armed_at=? WHERE id=?")
    .run(now + 30_000, now, switchId);

  const ts = Date.now();
  const sig = signMsg(priv, `sentinella:remove-contact:${contactId}:${ts}`);
  const res = await app.inject({
    method: 'DELETE', url: `/contacts/${contactId}`,
    payload: { ownerPub: pub, ts, sig },
  });
  const body = JSON.parse(res.payload) as any;
  ok(res.statusCode === 409, `status 409 (ricevuto: ${res.statusCode})`);
  ok(body.error === 'quote_attive', `error=quote_attive (${body.error})`);

  const row = db.prepare('SELECT id FROM contacts WHERE id=?').get(contactId);
  ok(row !== undefined, 'riga contatto ancora presente nel DB');
}

// ── 4) DELETE /contacts/:contactId — force:true con switch ACTIVE → 200 ────────
console.log('4) DELETE /contacts/:contactId — force:true con switch ACTIVE → 200, audit CONTACT_FORCE_REMOVED');
{
  process.env['NODE_ENV'] = 'test';
  const { ownerId, priv, pub } = await mkOwner('Owner4');
  const { contactId } = await mkContact({ ownerId, priv, pub }, 'push_del_4');

  const swRes = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: signBody(priv, pub, 'POST', '/switch/create', { intervalSec: 30, graceSec: 10 }),
  });
  const { switchId } = JSON.parse(swRes.payload) as { switchId: string };
  const now = Date.now();
  db.prepare("UPDATE switches SET state='ACTIVE', next_check_at=?, armed_at=? WHERE id=?")
    .run(now + 30_000, now, switchId);

  const ts = Date.now();
  const sig = signMsg(priv, `sentinella:remove-contact:${contactId}:${ts}`);
  const res = await app.inject({
    method: 'DELETE', url: `/contacts/${contactId}`,
    payload: { ownerPub: pub, ts, sig, force: true },
  });
  const body = JSON.parse(res.payload) as any;
  ok(res.statusCode === 200, `status 200 (ricevuto: ${res.statusCode})`);

  const row = db.prepare('SELECT id FROM contacts WHERE id=?').get(contactId);
  ok(row === undefined, 'riga contatto eliminata dal DB');

  const auditRow = db.prepare("SELECT event FROM audit WHERE event='CONTACT_FORCE_REMOVED' ORDER BY id DESC LIMIT 1").get() as { event: string } | undefined;
  ok(auditRow?.event === 'CONTACT_FORCE_REMOVED', 'audit event CONTACT_FORCE_REMOVED presente');
}

// ── 5) DELETE /contacts/:contactId — owner sbagliato → 401 o 404 ──────────────
console.log('5) DELETE /contacts/:contactId — owner sbagliato (chiave diversa) → 401 o 404');
{
  const { ownerId, priv: privA, pub: pubA } = await mkOwner('OwnerA');
  const { contactId } = await mkContact({ ownerId, priv: privA, pub: pubA }, 'push_del_5a');

  // Owner B con chiave diversa
  const { priv: privB, pub: pubB } = await mkOwner('OwnerB');

  const ts = Date.now();
  const sig = signMsg(privB, `sentinella:remove-contact:${contactId}:${ts}`);
  const res = await app.inject({
    method: 'DELETE', url: `/contacts/${contactId}`,
    payload: { ownerPub: pubB, ts, sig },
  });
  ok(res.statusCode === 401 || res.statusCode === 404, `status 401 o 404 (ricevuto: ${res.statusCode})`);
}

// ── 6) PUT /contacts/:contactId — rotazione chiave, no switch → 200 ───────────
console.log('6) PUT /contacts/:contactId — rotazione chiave, no switch → 200, chiave aggiornata nel DB');
{
  const { ownerId, priv, pub } = await mkOwner('Owner6');
  const { contactId } = await mkContact({ ownerId, priv, pub }, 'push_rot_6');

  const newPriv = p256.utils.randomPrivateKey();
  const newPub = bytesToHex(p256.getPublicKey(newPriv, true));
  const ts = Date.now();
  const sig = signMsg(priv, `sentinella:rotate-contact-key:${contactId}:${newPub}:${ts}`);
  const res = await app.inject({
    method: 'PUT', url: `/contacts/${contactId}`,
    payload: { ownerPub: pub, ts, sig, newPublicKey: newPub },
  });
  const body = JSON.parse(res.payload) as any;
  ok(res.statusCode === 200, `status 200 (ricevuto: ${res.statusCode})`);
  ok(body.ok === true, 'body.ok === true');

  const row = db.prepare('SELECT public_key FROM contacts WHERE id=?').get(contactId) as { public_key: string } | undefined;
  ok(row?.public_key === newPub, `public_key aggiornata nel DB (${row?.public_key?.slice(0, 12)}…)`);

  const auditRow = db.prepare("SELECT event FROM audit WHERE event='CONTACT_KEY_ROTATED' ORDER BY id DESC LIMIT 1").get() as { event: string } | undefined;
  ok(auditRow?.event === 'CONTACT_KEY_ROTATED', 'audit event CONTACT_KEY_ROTATED presente');
}

// ── 7) PUT /contacts/:contactId — switch ACTIVE → 409 ─────────────────────────
console.log('7) PUT /contacts/:contactId — switch ACTIVE → 409, chiave invariata');
{
  process.env['NODE_ENV'] = 'test';
  const { ownerId, priv, pub } = await mkOwner('Owner7');
  const contactPriv = p256.utils.randomPrivateKey();
  const contactPubOrig = bytesToHex(p256.getPublicKey(contactPriv, true));
  const { contactId } = await mkContact({ ownerId, priv, pub }, 'push_rot_7', contactPubOrig);

  const swRes = await app.inject({
    method: 'POST', url: '/switch/create',
    payload: signBody(priv, pub, 'POST', '/switch/create', { intervalSec: 30, graceSec: 10 }),
  });
  const { switchId } = JSON.parse(swRes.payload) as { switchId: string };
  const now = Date.now();
  db.prepare("UPDATE switches SET state='ACTIVE', next_check_at=?, armed_at=? WHERE id=?")
    .run(now + 30_000, now, switchId);

  const newPub = bytesToHex(p256.getPublicKey(p256.utils.randomPrivateKey(), true));
  const ts = Date.now();
  const sig = signMsg(priv, `sentinella:rotate-contact-key:${contactId}:${newPub}:${ts}`);
  const res = await app.inject({
    method: 'PUT', url: `/contacts/${contactId}`,
    payload: { ownerPub: pub, ts, sig, newPublicKey: newPub },
  });
  const body = JSON.parse(res.payload) as any;
  ok(res.statusCode === 409, `status 409 (ricevuto: ${res.statusCode})`);
  ok(body.error === 'switch_attivo', `error=switch_attivo (${body.error})`);

  const row = db.prepare('SELECT public_key FROM contacts WHERE id=?').get(contactId) as { public_key: string } | undefined;
  ok(row?.public_key === contactPubOrig, 'public_key invariata nel DB');
}

// ── 8) DELETE /contacts/:contactId/reject — contatto rifiuta il pairing → 200 ──
console.log('8) DELETE /contacts/:contactId/reject — contatto rifiuta il pairing → 200, riga eliminata');
{
  const { ownerId, priv, pub } = await mkOwner('Owner8');
  const contactPriv = p256.utils.randomPrivateKey();
  const contactPub = bytesToHex(p256.getPublicKey(contactPriv, true));
  const { contactId } = await mkContact({ ownerId, priv, pub }, 'push_rej_8', contactPub);

  const ts = Date.now();
  const sig = signMsg(contactPriv, `sentinella:reject-pairing:${contactId}:${ts}`);
  const res = await app.inject({
    method: 'DELETE', url: `/contacts/${contactId}/reject`,
    payload: { contactPub, ts, sig },
  });
  const body = JSON.parse(res.payload) as any;
  ok(res.statusCode === 200, `status 200 (ricevuto: ${res.statusCode})`);
  ok(body.ok === true, 'body.ok === true');

  const row = db.prepare('SELECT id FROM contacts WHERE id=?').get(contactId);
  ok(row === undefined, 'riga contatto eliminata dal DB');

  const auditRow = db.prepare("SELECT event FROM audit WHERE event='CONTACT_REJECTED' ORDER BY id DESC LIMIT 1").get() as { event: string } | undefined;
  ok(auditRow?.event === 'CONTACT_REJECTED', 'audit event CONTACT_REJECTED presente');
}

// ── 9) DELETE /contacts/:contactId/reject — chiave sbagliata → 401 ─────────────
console.log('9) DELETE /contacts/:contactId/reject — chiave sbagliata → 401');
{
  const { ownerId, priv, pub } = await mkOwner('Owner9');
  const contactPrivX = p256.utils.randomPrivateKey();
  const contactPubX = bytesToHex(p256.getPublicKey(contactPrivX, true));
  const { contactId } = await mkContact({ ownerId, priv, pub }, 'push_rej_9', contactPubX);

  // Firma con una chiave Y diversa
  const privY = p256.utils.randomPrivateKey();
  const pubY = bytesToHex(p256.getPublicKey(privY, true));
  const ts = Date.now();
  const sig = signMsg(privY, `sentinella:reject-pairing:${contactId}:${ts}`);
  const res = await app.inject({
    method: 'DELETE', url: `/contacts/${contactId}/reject`,
    payload: { contactPub: pubY, ts, sig },
  });
  ok(res.statusCode === 401, `status 401 (ricevuto: ${res.statusCode})`);
}

// ── 10) GET /contacts — restituisce push_token_preview e created_at ───────────
console.log('10) GET /contacts — push_token_preview mascherato e created_at presente');
{
  const { ownerId, priv, pub } = await mkOwner('Owner10');
  await mkContact({ ownerId, priv, pub }, 'ExPushToken12345XYZ');

  const res = await app.inject({ method: 'GET', url: `/contacts?ownerId=${ownerId}` });
  const body = JSON.parse(res.payload) as any;
  ok(res.statusCode === 200, `status 200 (ricevuto: ${res.statusCode})`);
  const c = body.contacts?.[0];
  ok(c?.push_token_preview != null, `push_token_preview non null (${c?.push_token_preview})`);
  ok(typeof c?.push_token_preview === 'string' && c.push_token_preview.startsWith('ExPushTo'),
    `push_token_preview inizia con 'ExPushTo' (${c?.push_token_preview})`);
  ok(typeof c?.push_token_preview === 'string' && c.push_token_preview.endsWith('5XYZ'),
    `push_token_preview finisce con '5XYZ' (${c?.push_token_preview})`);
  ok(typeof c?.created_at === 'number', `created_at è un numero (${c?.created_at})`);
}

console.log(`\nRisultato: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
