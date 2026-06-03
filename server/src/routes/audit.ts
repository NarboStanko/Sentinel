import type { FastifyInstance } from 'fastify';
import { audit } from '../db.js';
import { verifySession } from './auth.js';

export async function auditRoutes(app: FastifyInstance) {
  app.post<{ Body: { token: string } }>('/audit/backup-viewed', async (req, reply) => {
    if (!verifySession(req.body.token)) return reply.code(401).send({ error: 'sessione_non_valida' });
    audit(null, 'BACKUP_VIEWED');
    return { ok: true };
  });

  app.post<{ Body: { token: string; switchId: string } }>('/audit/seed-restore-ack', async (req, reply) => {
    if (!verifySession(req.body.token)) return reply.code(401).send({ error: 'sessione_non_valida' });
    audit(req.body.switchId, 'RECOVERED_DURING_PENDING');
    return { ok: true };
  });
}
