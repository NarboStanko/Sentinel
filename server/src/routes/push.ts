import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';

// Registrazione del push token (Expo/FCM/APNs). Legato a user o contatto.
export async function pushRoutes(app: FastifyInstance) {
  app.post<{ Body: { role: 'owner' | 'contact'; id: string; pushToken: string } }>(
    '/push/register',
    async (req, reply) => {
      const { role, id, pushToken } = req.body;
      const table = role === 'owner' ? 'users' : 'contacts';
      const result = db.prepare(`UPDATE ${table} SET push_token = ? WHERE id = ?`).run(pushToken, id);
      if (result.changes === 0) {
        return reply.code(404).send({ error: 'utente_non_trovato', message: 'Nessun utente trovato con questo ID.' });
      }
      // Log solo il prefisso del token: non è un segreto ma è un identificatore di device.
      req.log.info({ role, id, tokenPrefix: pushToken.slice(0, 35) }, '[push] token registrato');
      return { ok: true };
    }
  );
}
