import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';

// ⚠️ SOLO SVILUPPO. Conserva il ciphertext in memoria per testare il flusso e2e.
// In produzione: disabilitato. Il server NON deve mai possedere il contenuto
// cifrato; riceve solo il puntatore restituito dal provider reale (Google Drive…).
const blobs = new Map<string, string>();

export async function devBlobRoutes(app: FastifyInstance) {
  if (process.env['NODE_ENV'] === 'production') {
    app.log.info('[devblob] NODE_ENV=production — /dev/blob disabilitato');
    return;
  }
  app.log.warn('[devblob] /dev/blob attivo (solo sviluppo) — non usare in produzione');

  app.post<{ Body: { data: string } }>('/dev/blob', async (req) => {
    const pointer = 'drive://dev/' + nanoid(10);
    blobs.set(pointer, req.body.data);
    return { pointer };
  });

  app.get<{ Querystring: { pointer: string } }>('/dev/blob', async (req) => {
    return { data: blobs.get(req.query.pointer) ?? null };
  });
}
