import type { FastifyInstance } from 'fastify';
import { audit } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { appendToChain } from '../services/auditChain.js';

// Eventi audit dell'owner. Auth: firma per-richiesta (stesso modello di tutte
// le mutazioni, es. /switch/disarm) — nessun token di sessione. Gli eventi
// entrano in catena FIRMATI (signature = firma della richiesta), coerenti con
// gli altri eventi utente.
export async function auditRoutes(app: FastifyInstance) {
  app.post<{ Body: { pub: string; ts: number; sig: string } }>(
    '/audit/backup-viewed',
    { preHandler: [requireAuth('owner')] },
    async (req) => {
      const ownerId = req.actor!.id;
      audit(null, 'BACKUP_VIEWED');
      try { appendToChain({ chain_owner_id: ownerId, event_type: 'BACKUP_VIEWED', actor_id: ownerId, payload: {}, signature: req.body.sig }); } catch (e) { console.error('auditChain BACKUP_VIEWED', e); }
      return { ok: true };
    }
  );

  app.post<{ Body: { switchId: string; pub: string; ts: number; sig: string } }>(
    '/audit/seed-restore-ack',
    { preHandler: [requireAuth('owner-of-switch')] },
    async (req) => {
      const ownerId = req.actor!.id;
      audit(req.body.switchId, 'RECOVERED_DURING_PENDING');
      try { appendToChain({ chain_owner_id: ownerId, event_type: 'RECOVERED_DURING_PENDING', actor_id: ownerId, payload: { switchId: req.body.switchId }, signature: req.body.sig }); } catch (e) { console.error('auditChain RECOVERED_DURING_PENDING', e); }
      return { ok: true };
    }
  );
}
