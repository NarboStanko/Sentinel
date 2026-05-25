import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';

// ⚠️ SOLO SVILUPPO. Conserva il ciphertext per testare il flusso end-to-end.
// VA SOSTITUITO dal drive esterno reale: in produzione il server NON deve
// possedere il contenuto cifrato, solo il puntatore.
const blobs = new Map<string, string>();

export async function devBlobRoutes(app: FastifyInstance) {
  app.post<{ Body: { data: string } }>('/dev/blob', async (req) => {
    const pointer = 'drive://dev/' + nanoid(10);
    blobs.set(pointer, req.body.data);
    return { pointer };
  });
  app.get<{ Querystring: { pointer: string } }>('/dev/blob', async (req) => {
    return { data: blobs.get(req.query.pointer) ?? null };
  });
}
