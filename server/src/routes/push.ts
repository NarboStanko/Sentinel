import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';

// Registrazione del push token (Expo/FCM/APNs). Legato a user o contatto.
export async function pushRoutes(app: FastifyInstance) {
  app.post<{ Body: { role: 'owner' | 'contact'; id: string; pushToken: string } }>(
    '/push/register',
    async (req) => {
      const { role, id, pushToken } = req.body;
      const table = role === 'owner' ? 'users' : 'contacts';
      db.prepare(`UPDATE ${table} SET push_token = ? WHERE id = ?`).run(pushToken, id);
      return { ok: true };
    }
  );
}
