import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { validateBody, pushRegisterSchema } from '../middleware/validate.js';

// Verifica dinamica: owner o contact, in base al campo role nel body.
// Dopo la verifica generica, controlla che body.id === actor.id per prevenire
// che un utente aggiorni il push token di un altro.
async function requirePushAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = req.body as { role?: unknown; id?: unknown };
  const { role } = body;
  if (role === 'owner') {
    await requireAuth('owner')(req, reply);
  } else if (role === 'contact') {
    await requireAuth('contact')(req, reply);
  } else {
    return reply.code(401).send({ error: 'auth_failed' });
  }
  if (reply.sent) return;
  if (req.actor?.id !== body.id) {
    return reply.code(401).send({ error: 'auth_failed' });
  }
}

// Registrazione del push token (Expo/FCM/APNs). Legato a user o contatto.
export async function pushRoutes(app: FastifyInstance) {
  app.post<{ Body: { role: 'owner' | 'contact'; id: string; pushToken: string; pub: string; ts: number; sig: string } }>(
    '/push/register',
    { preHandler: [requirePushAuth, validateBody(pushRegisterSchema)] },
    async (req, reply) => {
      const { role, id, pushToken } = req.body;
      const table = role === 'owner' ? 'users' : 'contacts';
      const result = db.prepare(`UPDATE ${table} SET push_token = ? WHERE id = ?`).run(pushToken, id);
      if (result.changes === 0) {
        return reply.code(404).send({ error: 'utente_non_trovato', message: 'Nessun utente trovato con questo ID.' });
      }
      req.log.info({ role, id, tokenPrefix: pushToken.slice(0, 35) }, '[push] token registrato');
      return { ok: true };
    }
  );
}
