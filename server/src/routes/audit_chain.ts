import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes } from '@noble/hashes/utils';
import { canonicalize } from '../middleware/auth.js';
import { appendToChain } from '../services/auditChain.js';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { z } from 'zod';

const GENESIS = '0'.repeat(64);
const MAX_EVENTS_PER_REQUEST = 100;

function verifyQuerySig(pub: string, urlPath: string, ts: number, sig: string): boolean {
  try {
    const canonical = canonicalize('GET', urlPath, ts, pub, {});
    const hash = sha256(new TextEncoder().encode(canonical));
    return p256.verify(hexToBytes(sig), hash, hexToBytes(pub));
  } catch {
    return false;
  }
}

function parseOwnerFromPub(pub: string, ownerId: string): boolean {
  const row = db.prepare('SELECT id FROM users WHERE public_key = ? AND id = ?').get(pub, ownerId) as
    { id: string } | undefined;
  return !!row;
}

export async function auditChainRoutes(app: FastifyInstance) {
  // GET /audit/anchor?ownerId=&pub=&ts=&sig=
  // Restituisce l'ultimo evento della catena: { ownerId, chainIndex, hash, timestamp_ms }
  // Se la catena è vuota: { chainIndex: -1, hash: genesis, timestamp_ms: null }
  // Auth: il pub deve corrispondere all'owner di ownerId; firma su canonicalize('GET', '/audit/anchor', ts, pub, {})
  app.get<{
    Querystring: { ownerId: string; pub: string; ts: string; sig: string };
  }>('/audit/anchor', async (req, reply) => {
    const { ownerId, pub, ts, sig } = req.query;
    if (!ownerId || !pub || !ts || !sig) {
      return reply.code(400).send({ error: 'parametri_mancanti', message: 'ownerId, pub, ts e sig sono obbligatori.' });
    }
    const tsNum = parseInt(ts, 10);
    if (!tsNum || Math.abs(Date.now() - tsNum) > 5 * 60_000) {
      return reply.code(401).send({ error: 'timestamp scaduto', message: 'Il timestamp è scaduto o mancante.' });
    }
    if (!verifyQuerySig(pub, '/audit/anchor', tsNum, sig)) {
      return reply.code(401).send({ error: 'firma_non_valida', message: 'Firma non valida.' });
    }
    if (!parseOwnerFromPub(pub, ownerId)) {
      return reply.code(403).send({ error: 'accesso_negato', message: 'La chiave pubblica non corrisponde a questo ownerId.' });
    }

    const last = db.prepare(
      'SELECT chain_index, hash, timestamp_ms FROM audit_chain WHERE chain_owner_id=? ORDER BY chain_index DESC LIMIT 1'
    ).get(ownerId) as { chain_index: number; hash: string; timestamp_ms: number } | undefined;

    if (!last) {
      return { ownerId, chainIndex: -1, hash: GENESIS, timestamp_ms: null };
    }
    return { ownerId, chainIndex: last.chain_index, hash: last.hash, timestamp_ms: last.timestamp_ms };
  });

  // GET /audit/events?ownerId=&fromIndex=&toIndex=&pub=&ts=&sig=
  // Restituisce un array di eventi nell'intervallo [fromIndex, toIndex] (inclusi).
  // toIndex default: fromIndex + 99 (max 100 eventi per richiesta).
  // Auth: stessa verifica di /audit/anchor (pub → ownerId)
  app.get<{
    Querystring: { ownerId: string; fromIndex: string; toIndex?: string; pub: string; ts: string; sig: string };
  }>('/audit/events', async (req, reply) => {
    const { ownerId, fromIndex, toIndex, pub, ts, sig } = req.query;
    if (!ownerId || !pub || !ts || !sig || fromIndex === undefined) {
      return reply.code(400).send({ error: 'parametri_mancanti', message: 'ownerId, fromIndex, pub, ts e sig sono obbligatori.' });
    }
    const tsNum = parseInt(ts, 10);
    if (!tsNum || Math.abs(Date.now() - tsNum) > 5 * 60_000) {
      return reply.code(401).send({ error: 'timestamp scaduto', message: 'Il timestamp è scaduto o mancante.' });
    }
    if (!verifyQuerySig(pub, '/audit/events', tsNum, sig)) {
      return reply.code(401).send({ error: 'firma_non_valida', message: 'Firma non valida.' });
    }
    if (!parseOwnerFromPub(pub, ownerId)) {
      return reply.code(403).send({ error: 'accesso_negato', message: 'La chiave pubblica non corrisponde a questo ownerId.' });
    }

    const from = parseInt(fromIndex, 10);
    if (isNaN(from) || from < 0) {
      return reply.code(400).send({ error: 'indice_non_valido', message: 'fromIndex deve essere >= 0.' });
    }
    const to = toIndex !== undefined ? parseInt(toIndex, 10) : from + MAX_EVENTS_PER_REQUEST - 1;
    const cappedTo = Math.min(to, from + MAX_EVENTS_PER_REQUEST - 1);

    const rows = db.prepare(
      `SELECT chain_index, event_type, actor_id, payload, timestamp_ms, signature, prev_hash, hash
       FROM audit_chain WHERE chain_owner_id=? AND chain_index >= ? AND chain_index <= ?
       ORDER BY chain_index ASC`
    ).all(ownerId, from, cappedTo) as Array<{
      chain_index: number;
      event_type: string;
      actor_id: string | null;
      payload: string;
      timestamp_ms: number;
      signature: string | null;
      prev_hash: string;
      hash: string;
    }>;

    return {
      events: rows.map((r) => ({
        chain_index:  r.chain_index,
        event_type:   r.event_type,
        actor_id:     r.actor_id,
        payload:      JSON.parse(r.payload),
        timestamp_ms: r.timestamp_ms,
        signature:    r.signature,
        prev_hash:    r.prev_hash,
        hash:         r.hash,
      })),
    };
  });

  // POST /audit/anchor-event — registra ANCHOR_SAVED o VERIFICATION_FAILED nella catena.
  // Auth: requireAuth('owner')
  const anchorEventSchema = z.object({
    eventType: z.enum(['ANCHOR_SAVED', 'VERIFICATION_FAILED', 'RECOVERY_CONFIRMED_AFTER_VERIFICATION_FAIL']),
    metadata:  z.record(z.unknown()).optional(),
    pub: z.string().length(66),
    ts:  z.number().int().positive(),
    sig: z.string().length(128),
  }).strict();

  app.post<{
    Body: { eventType: 'ANCHOR_SAVED' | 'VERIFICATION_FAILED' | 'RECOVERY_CONFIRMED_AFTER_VERIFICATION_FAIL'; metadata?: Record<string, unknown>; pub: string; ts: number; sig: string };
  }>(
    '/audit/anchor-event',
    { preHandler: [requireAuth('owner'), validateBody(anchorEventSchema)] },
    async (req) => {
      const ownerId = req.actor!.id;
      appendToChain({
        chain_owner_id: ownerId,
        event_type:     req.body.eventType,
        actor_id:       ownerId,
        payload:        req.body.metadata ?? {},
        signature:      req.body.sig,
      });
      return { ok: true };
    }
  );
}
