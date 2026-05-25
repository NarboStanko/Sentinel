import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes } from '@noble/hashes/utils';

// GET /pending — lista switch in APPROVAL_PENDING per il contatto autenticato.
//
// Auth one-shot: il contatto firma sha256("sentinella:pending:" + ts) con la sua
// chiave P-256. Il server verifica la firma e controlla che |ts - now| < 5 min.
// Non serve sessione server-side: è una lettura idempotente.
//
// Invariante: non rivela il switchId nel payload push. L'app lo recupera qui,
// DOPO il tap, su TLS.
export async function pendingRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { pub: string; ts: string; sig: string };
  }>('/pending', async (req, reply) => {
    const { pub, ts, sig } = req.query;

    // 1) timestamp fresco (±5 minuti)
    const tsNum = parseInt(ts, 10);
    if (!tsNum || Math.abs(Date.now() - tsNum) > 5 * 60_000) {
      return reply.code(401).send({ error: 'timestamp scaduto o mancante' });
    }

    // 2) firma valida — il messaggio firmato include sia pub che ts, così
    //    una firma intercettata non è riutilizzabile con una chiave diversa
    //    e il binding tra identità e richiesta è crittograficamente esplicito.
    let verified = false;
    try {
      const challenge = 'sentinella:pending:' + pub + ':' + ts;
      const msgHash = sha256(new TextEncoder().encode(challenge));
      verified = p256.verify(hexToBytes(sig), msgHash, hexToBytes(pub));
    } catch {
      return reply.code(401).send({ error: 'firma non valida' });
    }
    if (!verified) return reply.code(401).send({ error: 'firma non valida' });

    // 3) trova il contatto per chiave pubblica.
    //    Se la chiave non è in contacts, restituisce [] — una chiave sconosciuta
    //    non può enumerare lo stato di nessun owner.
    const contact = db
      .prepare('SELECT id, owner_id FROM contacts WHERE public_key = ?')
      .get(pub) as { id: string; owner_id: string } | undefined;

    if (!contact) return { switches: [] };

    // 4) restituisce gli switch del suo owner in APPROVAL_PENDING.
    //    Lo scope è owner_id di QUESTO contatto: non restituisce mai
    //    switch di altri owner anche se sono APPROVAL_PENDING.
    const rows = db
      .prepare(
        `SELECT s.id AS switchId, u.display_name AS ownerName
         FROM switches s
         JOIN users u ON u.id = s.owner_id
         WHERE s.owner_id = ? AND s.state = 'APPROVAL_PENDING'`
      )
      .all(contact.owner_id) as { switchId: string; ownerName: string | null }[];

    return {
      switches: rows.map((r) => ({
        switchId: r.switchId,
        ownerName: r.ownerName ?? 'Questa persona',
      })),
    };
  });
}
