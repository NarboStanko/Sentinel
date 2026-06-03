import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { createHash } from 'node:crypto';
import { p256 } from '@noble/curves/p256';
import { bytesToHex } from '@noble/hashes/utils';
import { db } from '../db.js';

// ─────────────────────────────────────────────────────────────────────────────
// ROTTE DI DEBUG — completamente disabilitate in produzione (NODE_ENV check).
// Non toccare il flusso di pairing reale. Non usare in produzione.
// ─────────────────────────────────────────────────────────────────────────────
//
// POST /debug/expire/:switchId   → forza next_check_at nel passato
// POST /debug/seed-contacts      → crea 2 contatti fittizi per test armo/push
//
export async function debugRoutes(app: FastifyInstance) {
  const env = process.env['NODE_ENV'];
  if (env === 'production') {
    app.log.info('[debug] NODE_ENV=production — rotte di debug disabilitate');
    return;
  }
  // Conferma visibile nei log all'avvio: se questa riga non appare, le rotte non sono montate.
  app.log.warn(`[debug] rotte di sviluppo attive (NODE_ENV="${env ?? 'undefined'}") — /debug/expire + /debug/seed-contacts + /debug/cleanup-orphan-contacts`);

  app.post<{ Params: { switchId: string } }>(
    '/debug/expire/:switchId',
    async (req, reply) => {
      const { switchId } = req.params;
      const sw = db
        .prepare("SELECT state FROM switches WHERE id = ?")
        .get(switchId) as { state: string } | undefined;

      if (!sw) {
        return reply.code(404).send({ error: 'switch_non_trovato', message: 'Switch non trovato.' });
      }
      if (!['ACTIVE', 'GRACE'].includes(sw.state)) {
        return reply.code(400).send({
          error: 'stato_non_scadibile',
          message: `Lo switch è in stato ${sw.state}; può essere scaduto solo se ACTIVE o GRACE.`,
        });
      }

      const expiredAt = Date.now() - 1;
      db.prepare("UPDATE switches SET next_check_at = ? WHERE id = ?").run(expiredAt, switchId);
      req.log.warn({ switchId, state: sw.state }, '[debug] next_check_at forzato nel passato');
      return { ok: true, switchId, fromState: sw.state, expiredAt };
    }
  );

  // ── POST /debug/seed-contacts ─────────────────────────────────────────────
  // SOLO SVILUPPO. Crea 2 contatti fittizi associati all'owner dato, con chiavi
  // P-256 generate al volo. Restituisce anche le chiavi così l'app può salvarle
  // come "verificate" lato client e superare il controllo k≥2 in compose.
  //
  // ATTENZIONE: questi contatti NON sono verificati di persona. Le quote cifrate
  // verso di loro non saranno mai decifrabili (nessuno ha la loro chiave privata).
  // Servono SOLO per testare il ciclo armo → scheduler → push check-in all'owner.
  // Il push token 'DEVTEST_NO_PUSH' li identifica come contatti fittizi nel DB.
  app.post<{ Body: { ownerId: string } }>(
    '/debug/seed-contacts',
    async (req, reply) => {
      const { ownerId } = req.body;
      const owner = db.prepare('SELECT id FROM users WHERE id = ?').get(ownerId) as { id: string } | undefined;
      if (!owner) {
        return reply.code(404).send({ error: 'owner_non_trovato', message: 'Owner non trovato.' });
      }

      const seeded: { contactId: string; publicKey: string }[] = [];
      for (let i = 0; i < 2; i++) {
        // Genera una coppia P-256 usa-e-getta. La chiave privata viene scartata:
        // nessuno potrà mai decifrare le quote destinate a questi contatti.
        const privKey = p256.utils.randomPrivateKey();
        const pubKeyHex = bytesToHex(p256.getPublicKey(privKey, true));
        const contactId = 'c_dev_' + nanoid(8);
        const toHash = createHash('sha256').update('salt::' + contactId).digest('base64').slice(0, 16);
        db.prepare(
          'INSERT INTO contacts (id, owner_id, public_key, push_token, to_hash, created_at) VALUES (?,?,?,?,?,?)'
        ).run(contactId, ownerId, pubKeyHex, 'DEVTEST_NO_PUSH', toHash, Date.now());
        seeded.push({ contactId, publicKey: pubKeyHex });
      }

      req.log.warn(
        { ownerId, ids: seeded.map(c => c.contactId) },
        '[debug] contatti fittizi creati — NON verificati di persona, solo sviluppo'
      );
      return { contacts: seeded };
    }
  );

  // ── POST /debug/cleanup-orphan-contacts ───────────────────────────────────────
  // Cancella tutti i contatti con push_token='DEVTEST_NO_PUSH' e le loro quote orfane
  // da switch DISARMED/RELEASED. Usato nei test per ripristinare lo stato pulito.
  app.post('/debug/cleanup-orphan-contacts', async (req) => {
    const orphanOwnerIds = (db.prepare(
      "SELECT DISTINCT owner_id FROM contacts WHERE push_token = 'DEVTEST_NO_PUSH'"
    ).all() as { owner_id: string }[]).map(r => r.owner_id);

    const deleted = db.prepare("DELETE FROM contacts WHERE push_token = 'DEVTEST_NO_PUSH'").run();

    let sharesCleaned = 0;
    if (orphanOwnerIds.length > 0) {
      const dormantIds = (db.prepare(
        `SELECT id FROM switches WHERE owner_id IN (${orphanOwnerIds.map(() => '?').join(',')}) AND state IN ('DISARMED','RELEASED')`
      ).all(...orphanOwnerIds) as { id: string }[]).map(s => s.id);
      if (dormantIds.length > 0) {
        const r = db.prepare(
          `DELETE FROM shares WHERE switch_id IN (${dormantIds.map(() => '?').join(',')})`
        ).run(...dormantIds);
        sharesCleaned = r.changes;
      }
    }

    req.log.warn({ contactsDeleted: deleted.changes, sharesCleaned }, '[debug] cleanup-orphan-contacts');
    return { ok: true, contactsDeleted: deleted.changes, sharesCleaned };
  });
}
