import type { FastifyInstance } from 'fastify';
import { db, audit } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { appendToChain } from '../services/auditChain.js';
import { validateBody, checkinSchema } from '../middleware/validate.js';

// +/- 15% di jitter sull'intervallo: rende meno leggibile il ritmo dei check-in.
export function withJitter(sec: number) { return Math.round(sec * (0.85 + Math.random() * 0.30)); }

// L'app risponde «tutto ok» a una push o all'apertura. Resetta il battito.
// requireAuth('owner-of-switch'): solo l'owner dello switch può fare check-in.
export async function checkinRoutes(app: FastifyInstance) {
  app.post<{ Body: { switchId: string; pub: string; ts: number; sig: string } }>(
    '/checkin/respond',
    { preHandler: [requireAuth('owner-of-switch'), validateBody(checkinSchema)] },
    async (req, reply) => {
      const sw = db.prepare('SELECT interval_sec, state FROM switches WHERE id = ?')
        .get(req.body.switchId) as { interval_sec: number; state: string } | undefined;
      if (!sw) return reply.code(404).send({ error: 'switch_non_trovato', message: 'Switch non trovato.' });
      if (sw.state === 'RELEASED') return { ok: false, reason: 'gia rilasciato' };
      const now = Date.now();
      const next = now + withJitter(sw.interval_sec) * 1000;
      db.prepare("UPDATE switches SET state='ACTIVE', last_checkin=?, next_check_at=? WHERE id=?")
        .run(now, next, req.body.switchId);
      audit(req.body.switchId, 'CHECKIN_OK');
      try { appendToChain({ chain_owner_id: req.actor!.id, event_type: 'CHECKIN_OK', actor_id: req.actor!.id, payload: { switchId: req.body.switchId }, signature: req.body.sig }); } catch (e) { console.error('auditChain CHECKIN_OK', e); }
      return { ok: true, nextCheckAt: next };
    }
  );
}
