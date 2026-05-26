import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { db, audit } from '../db.js';
import { createHash } from 'node:crypto';

// PAIRING DI PERSONA
// 1) L'owner crea un invito; l'app mostra un QR con { token, ownerPublicKey }.
// 2) Il contatto, di persona, scansiona il QR (verifica out-of-band della chiave).
// 3) Il contatto invia al server la propria chiave pubblica + push token, legati al token.
//    Il server NON fa da tramite per le chiavi: le ha gia' viste i due, faccia a faccia.
export async function pairingRoutes(app: FastifyInstance) {
  // Registrazione owner (chiave pubblica derivata da seed sul device)
  app.post<{ Body: { displayName?: string; publicKey: string } }>(
    '/owner/register',
    async (req) => {
      const id = 'usr_' + nanoid(10);
      db.prepare('INSERT INTO users (id, display_name, public_key, created_at) VALUES (?,?,?,?)')
        .run(id, req.body.displayName ?? null, req.body.publicKey, Date.now());
      return { ownerId: id };
    }
  );

  // L'owner genera un invito monouso
  app.post<{ Body: { ownerId: string } }>('/invite', async (req, reply) => {
    const owner = db.prepare('SELECT public_key FROM users WHERE id = ?').get(req.body.ownerId) as
      | { public_key: string } | undefined;
    if (!owner) return reply.code(404).send({ error: 'owner_non_trovato', message: 'Owner non trovato.' });
    const token = nanoid(16);
    db.prepare('INSERT INTO invites (token, owner_id, owner_public_key, created_at) VALUES (?,?,?,?)')
      .run(token, req.body.ownerId, owner.public_key, Date.now());
    // Questo oggetto e' cio' che finisce nel QR mostrato di persona.
    return { token, ownerPublicKey: owner.public_key };
  });

  // Il contatto completa l'accoppiamento dopo aver scansionato il QR
  app.post<{ Body: { token: string; contactPublicKey: string; pushToken?: string } }>(
    '/pair',
    async (req, reply) => {
      const inv = db.prepare('SELECT * FROM invites WHERE token = ? AND used = 0').get(req.body.token) as
        | { owner_id: string } | undefined;
      if (!inv) return reply.code(404).send({ error: 'invito_non_valido', message: 'Invito non valido o già usato.' });
      const contactId = 'c_' + nanoid(10);
      const toHash = createHash('sha256').update('salt::' + contactId).digest('base64').slice(0, 16);
      db.prepare(
        'INSERT INTO contacts (id, owner_id, public_key, push_token, to_hash, created_at) VALUES (?,?,?,?,?,?)'
      ).run(contactId, inv.owner_id, req.body.contactPublicKey, req.body.pushToken ?? null, toHash, Date.now());
      db.prepare('UPDATE invites SET used = 1 WHERE token = ?').run(req.body.token);
      audit(null, 'CONTACT_PAIRED');
      // Il contatto ha gia' la chiave dell'owner (dal QR). Ora l'owner ha quella del contatto.
      return { contactId };
    }
  );

  // L'owner elenca i propri contatti (solo metadati minimi)
  app.get<{ Querystring: { ownerId: string } }>('/contacts', async (req) => {
    const rows = db.prepare('SELECT id, public_key, to_hash, created_at FROM contacts WHERE owner_id = ?')
      .all(req.query.ownerId);
    return { contacts: rows };
  });
}
