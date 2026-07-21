import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';

// Il server espone solo cio' che gli e' lecito vedere. MAI il contenuto.
export async function vaultRoutes(app: FastifyInstance) {
  // Cosa vede il server (per debug/trasparenza). Niente plaintext, niente DEK.
  app.get<{ Querystring: { switchId: string } }>('/vault/view', async (req) => {
    const sw = db.prepare(
      'SELECT id, state, interval_sec, grace_sec FROM switches WHERE id = ?'
    ).get(req.query.switchId) as any;
    const shares = db.prepare('SELECT substr(blob,1,24) AS blob FROM shares WHERE switch_id = ?')
      .all(req.query.switchId);
    return { server_sees: { ...sw, shares, note: 'blob opachi: reali + esche, indistinguibili' } };
  });
}
