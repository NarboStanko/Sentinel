import type { FastifyInstance } from 'fastify';
import { audit } from '../db.js';
import { verifySession } from './auth.js';
import { appendToChain } from '../services/auditChain.js';

export async function auditRoutes(app: FastifyInstance) {
  app.post<{ Body: { token: string } }>('/audit/backup-viewed', async (req, reply) => {
    const ownerId = verifySession(req.body.token);
    if (!ownerId) return reply.code(401).send({ error: 'sessione_non_valida' });
    audit(null, 'BACKUP_VIEWED');
    try { appendToChain({ chain_owner_id: ownerId, event_type: 'BACKUP_VIEWED', actor_id: ownerId, payload: {}, signature: null }); } catch (e) { console.error('auditChain BACKUP_VIEWED', e); }
    return { ok: true };
  });

  app.post<{ Body: { token: string; switchId: string } }>('/audit/seed-restore-ack', async (req, reply) => {
    const ownerId = verifySession(req.body.token);
    if (!ownerId) return reply.code(401).send({ error: 'sessione_non_valida' });
    audit(req.body.switchId, 'RECOVERED_DURING_PENDING');
    try { appendToChain({ chain_owner_id: ownerId, event_type: 'RECOVERED_DURING_PENDING', actor_id: ownerId, payload: { switchId: req.body.switchId }, signature: null }); } catch (e) { console.error('auditChain RECOVERED_DURING_PENDING', e); }
    return { ok: true };
  });
}
