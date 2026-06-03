import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { db, audit } from '../db.js';
import { createHash } from 'node:crypto';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes } from '@noble/hashes/utils';

// Verifica firma timestampata (window 5 min, previene replay).
// challenge deve includere ts come parte del messaggio firmato dall'app via signChallenge.
function verifyTimedSig(publicKey: string, challenge: string, ts: number, sig: string): boolean {
  if (Math.abs(Date.now() - ts) > 5 * 60_000) return false;
  try {
    const hash = sha256(new TextEncoder().encode(challenge));
    return p256.verify(hexToBytes(sig), hash, hexToBytes(publicKey));
  } catch { return false; }
}

function maskToken(token: string | null): string | null {
  if (!token) return null;
  if (token.length <= 12) return token.slice(0, 4) + '…';
  return token.slice(0, 8) + '…' + token.slice(-4);
}

// PAIRING DI PERSONA
// 1) L'owner crea un invito; l'app mostra un QR con { token, ownerPublicKey }.
// 2) Il contatto, di persona, scansiona il QR (verifica out-of-band della chiave).
// 3) Il contatto invia al server la propria chiave pubblica + push token, legati al token.
//    Il server NON fa da tramite per le chiavi: le ha già viste i due, faccia a faccia.
export async function pairingRoutes(app: FastifyInstance) {
  // ── Registrazione owner ──────────────────────────────────────────────────────
  app.post<{ Body: { displayName?: string; publicKey: string } }>(
    '/owner/register',
    async (req) => {
      const id = 'usr_' + nanoid(10);
      db.prepare('INSERT INTO users (id, display_name, public_key, created_at) VALUES (?,?,?,?)')
        .run(id, req.body.displayName ?? null, req.body.publicKey, Date.now());
      return { ownerId: id };
    }
  );

  // ── Invito monouso ────────────────────────────────────────────────────────────
  app.post<{ Body: { ownerId: string } }>('/invite', async (req, reply) => {
    const owner = db.prepare('SELECT public_key FROM users WHERE id = ?').get(req.body.ownerId) as
      | { public_key: string } | undefined;
    if (!owner) return reply.code(404).send({ error: 'owner_non_trovato', message: 'Owner non trovato.' });
    const token = nanoid(16);
    db.prepare('INSERT INTO invites (token, owner_id, owner_public_key, created_at) VALUES (?,?,?,?)')
      .run(token, req.body.ownerId, owner.public_key, Date.now());
    // Questo oggetto è ciò che finisce nel QR mostrato di persona.
    return { token, ownerPublicKey: owner.public_key };
  });

  // ── Completamento pairing ─────────────────────────────────────────────────────
  app.post<{ Body: { token: string; contactPublicKey: string; pushToken?: string } }>(
    '/pair',
    async (req, reply) => {
      const inv = db.prepare('SELECT * FROM invites WHERE token = ? AND used = 0').get(req.body.token) as
        | { owner_id: string } | undefined;
      if (!inv) return reply.code(404).send({ error: 'invito_non_valido', message: 'Invito non valido o già usato.' });

      // Rileva re-pairing dello stesso dispositivo: stesso push token già in lista owner.
      // L'invito NON viene consumato: il contatto può riprovare dopo la risoluzione.
      if (req.body.pushToken) {
        const dup = db.prepare('SELECT id, public_key FROM contacts WHERE owner_id = ? AND push_token = ?')
          .get(inv.owner_id, req.body.pushToken) as { id: string; public_key: string } | undefined;
        if (dup) {
          return reply.code(409).send({
            error: 'push_token_duplicato',
            message: 'Questo dispositivo è già registrato come contatto.',
            existing: dup.id,
            existing_public_key: dup.public_key,
          });
        }
      }

      const contactId = 'c_' + nanoid(10);
      const toHash = createHash('sha256').update('salt::' + contactId).digest('base64').slice(0, 16);
      db.prepare(
        'INSERT INTO contacts (id, owner_id, public_key, push_token, to_hash, created_at) VALUES (?,?,?,?,?,?)'
      ).run(contactId, inv.owner_id, req.body.contactPublicKey, req.body.pushToken ?? null, toHash, Date.now());
      db.prepare('UPDATE invites SET used = 1 WHERE token = ?').run(req.body.token);
      audit(null, 'CONTACT_PAIRED');
      // Il contatto ha già la chiave dell'owner (dal QR). Ora l'owner ha quella del contatto.
      return { contactId };
    }
  );

  // ── Lista contatti dell'owner (metadati minimi + push token mascherato) ────────
  app.get<{ Querystring: { ownerId: string } }>('/contacts', async (req) => {
    const rows = db.prepare(
      'SELECT id, public_key, to_hash, push_token, created_at FROM contacts WHERE owner_id = ?'
    ).all(req.query.ownerId) as {
      id: string; public_key: string; to_hash: string;
      push_token: string | null; created_at: number;
    }[];
    return {
      contacts: rows.map(r => ({
        id: r.id,
        public_key: r.public_key,
        to_hash: r.to_hash,
        push_token_preview: maskToken(r.push_token),
        created_at: r.created_at,
      })),
    };
  });

  // ── Rifiuto pairing (lato CONTATTO) ──────────────────────────────────────────
  // DEVE essere registrata prima di DELETE /contacts/:contactId per Fastify.
  // Il contatto dimostra di essere il legittimo titolare mostrando una firma valida
  // con la chiave memorizzata sul server per quel contactId.
  // sig = signChallenge(contactPriv, "sentinella:reject-pairing:" + contactId + ":" + ts)
  app.delete<{
    Params: { contactId: string };
    Body: { contactPub: string; ts: number; sig: string };
  }>('/contacts/:contactId/reject', async (req, reply) => {
    const { contactId } = req.params;
    const { contactPub, ts, sig } = req.body ?? {} as any;
    if (!contactPub || !ts || !sig) {
      return reply.code(400).send({ error: 'parametri_mancanti', message: 'contactPub, ts e sig sono obbligatori.' });
    }

    // Cerca prima il contatto per id, poi verifica che la chiave fornita corrisponda
    const contact = db.prepare('SELECT id, public_key FROM contacts WHERE id = ?')
      .get(contactId) as { id: string; public_key: string } | undefined;
    if (!contact) return reply.code(404).send({ error: 'contatto_non_trovato', message: 'Contatto non trovato.' });

    // La chiave fornita deve corrispondere a quella memorizzata; altrimenti è una chiave sbagliata
    if (contact.public_key !== contactPub) {
      return reply.code(401).send({ error: 'chiave_non_corrispondente', message: 'La chiave fornita non corrisponde al contatto.' });
    }

    if (!verifyTimedSig(contactPub, `sentinella:reject-pairing:${contactId}:${ts}`, ts, sig)) {
      return reply.code(401).send({ error: 'firma_non_valida', message: 'Firma non valida o scaduta.' });
    }

    db.prepare('DELETE FROM contacts WHERE id = ?').run(contactId);
    audit(null, 'CONTACT_REJECTED');
    return { ok: true };
  });

  // ── Rimozione contatto (lato OWNER) ──────────────────────────────────────────
  // sig = signChallenge(ownerPriv, "sentinella:remove-contact:" + contactId + ":" + ts)
  // force: bypassa il blocco sugli switch attivi; audit separato CONTACT_FORCE_REMOVED.
  app.delete<{
    Params: { contactId: string };
    Body: { ownerPub: string; ts: number; sig: string; force?: boolean };
  }>('/contacts/:contactId', async (req, reply) => {
    const { contactId } = req.params;
    const { ownerPub, ts, sig, force } = req.body ?? {} as any;
    if (!ownerPub || !ts || !sig) {
      return reply.code(400).send({ error: 'parametri_mancanti', message: 'ownerPub, ts e sig sono obbligatori.' });
    }
    if (!verifyTimedSig(ownerPub, `sentinella:remove-contact:${contactId}:${ts}`, ts, sig)) {
      return reply.code(401).send({ error: 'firma_non_valida', message: 'Firma non valida o scaduta.' });
    }

    // Verifica appartenenza: il contatto deve essere di questo owner
    const contact = db.prepare(
      'SELECT c.id, c.owner_id FROM contacts c INNER JOIN users u ON c.owner_id = u.id WHERE c.id = ? AND u.public_key = ?'
    ).get(contactId, ownerPub) as { id: string; owner_id: string } | undefined;
    if (!contact) return reply.code(404).send({ error: 'contatto_non_trovato', message: 'Contatto non trovato.' });

    // Blocca se esistono switch attivi: le quote Shamir diventerebbero irraggiungibili
    const activeSwitch = db.prepare(
      "SELECT id FROM switches WHERE owner_id = ? AND state IN ('ACTIVE','GRACE','APPROVAL_PENDING') LIMIT 1"
    ).get(contact.owner_id) as { id: string } | undefined;

    if (activeSwitch && !force) {
      return reply.code(409).send({
        error: 'quote_attive',
        message: 'Il contatto ha quote attive su uno switch armato; disarma prima di rimuoverlo.',
        switchId: activeSwitch.id,
      });
    }

    // Elimina il contatto. Le quote Shamir non hanno contact_id (invariante di anonimità):
    // non è possibile eliminarle per contatto. Puliamo le quote delle switch DISARMED/RELEASED
    // dello stesso owner (dati morti che non servono più a nessuno).
    db.prepare('DELETE FROM contacts WHERE id = ?').run(contactId);
    const dormantIds = (db.prepare(
      "SELECT id FROM switches WHERE owner_id = ? AND state IN ('DISARMED','RELEASED')"
    ).all(contact.owner_id) as { id: string }[]).map(s => s.id);
    if (dormantIds.length > 0) {
      db.prepare(`DELETE FROM shares WHERE switch_id IN (${dormantIds.map(() => '?').join(',')})`)
        .run(...dormantIds);
    }

    audit(null, force ? 'CONTACT_FORCE_REMOVED' : 'CONTACT_REMOVED');
    return { ok: true };
  });

  // ── Rotazione chiave contatto (lato OWNER) ───────────────────────────────────
  // Aggiorna la public_key di un contatto esistente senza cambiare contactId né push_token.
  // BLOCCO: se esistono switch attivi, le quote cifrate per la vecchia chiave diventerebbero inutilizzabili.
  // sig = signChallenge(ownerPriv, "sentinella:rotate-contact-key:" + contactId + ":" + newPublicKey + ":" + ts)
  app.put<{
    Params: { contactId: string };
    Body: { ownerPub: string; ts: number; sig: string; newPublicKey: string };
  }>('/contacts/:contactId', async (req, reply) => {
    const { contactId } = req.params;
    const { ownerPub, ts, sig, newPublicKey } = req.body ?? {} as any;
    if (!ownerPub || !ts || !sig || !newPublicKey) {
      return reply.code(400).send({ error: 'parametri_mancanti', message: 'ownerPub, ts, sig e newPublicKey sono obbligatori.' });
    }
    const message = `sentinella:rotate-contact-key:${contactId}:${newPublicKey}:${ts}`;
    if (!verifyTimedSig(ownerPub, message, ts, sig)) {
      return reply.code(401).send({ error: 'firma_non_valida', message: 'Firma non valida o scaduta.' });
    }

    const contact = db.prepare(
      'SELECT c.id, c.owner_id FROM contacts c INNER JOIN users u ON c.owner_id = u.id WHERE c.id = ? AND u.public_key = ?'
    ).get(contactId, ownerPub) as { id: string; owner_id: string } | undefined;
    if (!contact) return reply.code(404).send({ error: 'contatto_non_trovato', message: 'Contatto non trovato.' });

    // Le quote Shamir sono cifrate per la chiave vecchia: ruotare la chiave le rende inutilizzabili
    const activeSwitch = db.prepare(
      "SELECT id FROM switches WHERE owner_id = ? AND state IN ('ACTIVE','GRACE','APPROVAL_PENDING') LIMIT 1"
    ).get(contact.owner_id) as { id: string } | undefined;
    if (activeSwitch) {
      return reply.code(409).send({
        error: 'switch_attivo',
        message: 'Disarma lo switch prima di aggiornare la chiave: le quote cifrate per la chiave precedente diventerebbero inutilizzabili.',
        switchId: activeSwitch.id,
      });
    }

    db.prepare('UPDATE contacts SET public_key = ? WHERE id = ?').run(newPublicKey, contactId);
    audit(null, 'CONTACT_KEY_ROTATED');
    return { ok: true };
  });
}
