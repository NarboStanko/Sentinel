import type { FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db.js';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes } from '@noble/curves/abstract/utils';
import { sortDeep } from '../lib/canonical.js';

export type ActorType = 'owner' | 'contact' | 'owner-of-switch' | 'contact-of-switch';
export interface Actor { type: ActorType; id: string; pub: string; }

declare module 'fastify' {
  interface FastifyRequest { actor?: Actor; }
}

// Replay-protection cache: key = "${pub}:${ts}:${sig}", value = insertion timestamp
const seenNonces = new Map<string, number>();
const NONCE_TTL = 6 * 60_000;

function cleanupNonces(): void {
  const cutoff = Date.now() - NONCE_TTL;
  for (const [k, t] of seenNonces) {
    if (t < cutoff) seenNonces.delete(k);
  }
}

function checkAndRegisterNonce(pub: string, ts: number, sig: string): boolean {
  cleanupNonces();
  const key = `${pub}:${ts}:${sig}`;
  if (seenNonces.has(key)) return false;
  seenNonces.set(key, Date.now());
  return true;
}

export function clearNonceCache(): void {
  seenNonces.clear();
}

// DEVE essere identica a app/lib/canonicalize.ts canonicalize().
// Modificare entrambe insieme. Test in server/src/routes/auth.test.ts verifica l'equivalenza.
export function canonicalize(
  method: string,
  urlPath: string,
  ts: number,
  pub: string,
  body: Record<string, unknown>,
): string {
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k !== 'pub' && k !== 'ts' && k !== 'sig') filtered[k] = v;
  }
  return `${method}|${urlPath}|${ts}|${pub}|${JSON.stringify(sortDeep(filtered))}`;
}

function verifySig(pub: string, canonical: string, sig: string): boolean {
  try {
    const hash = sha256(new TextEncoder().encode(canonical));
    return p256.verify(hexToBytes(sig), hash, hexToBytes(pub));
  } catch {
    return false;
  }
}

function lookupActor(actorType: ActorType, pub: string, body: Record<string, unknown>): Actor | null {
  switch (actorType) {
    case 'owner': {
      const row = db.prepare('SELECT id FROM users WHERE public_key = ?').get(pub) as { id: string } | undefined;
      if (!row) return null;
      return { type: 'owner', id: row.id, pub };
    }
    case 'contact': {
      const row = db.prepare('SELECT id FROM contacts WHERE public_key = ?').get(pub) as { id: string } | undefined;
      if (!row) return null;
      return { type: 'contact', id: row.id, pub };
    }
    case 'owner-of-switch': {
      const switchId = body['switchId'] as string | undefined;
      if (!switchId) return null;
      const row = db.prepare(
        'SELECT u.id FROM users u JOIN switches s ON s.owner_id = u.id WHERE u.public_key = ? AND s.id = ?'
      ).get(pub, switchId) as { id: string } | undefined;
      if (!row) return null;
      return { type: 'owner-of-switch', id: row.id, pub };
    }
    case 'contact-of-switch': {
      const switchId = body['switchId'] as string | undefined;
      if (!switchId) return null;
      // Contact must belong to the owner of the switch
      const row = db.prepare(`
        SELECT c.id FROM contacts c
        JOIN switches s ON s.owner_id = c.owner_id
        WHERE c.public_key = ? AND s.id = ?
      `).get(pub, switchId) as { id: string } | undefined;
      if (!row) return null;
      return { type: 'contact-of-switch', id: row.id, pub };
    }
  }
}

const AUTH_FAILED = { error: 'auth_failed' } as const;

export function requireAuth(actorType: ActorType) {
  return async function preHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body) { reply.code(401).send(AUTH_FAILED); return; }

    const pub = body['pub'];
    const ts  = body['ts'];
    const sig = body['sig'];

    if (typeof pub !== 'string' || typeof ts !== 'number' || typeof sig !== 'string') {
      reply.code(401).send(AUTH_FAILED);
      return;
    }

    // Timestamp window ±5 min
    if (Math.abs(Date.now() - ts) > 5 * 60_000) {
      reply.code(401).send(AUTH_FAILED);
      return;
    }

    const canonical = canonicalize(req.method, (req.routeOptions as any)?.url ?? req.url, ts, pub, body);

    if (!verifySig(pub, canonical, sig)) {
      reply.code(401).send(AUTH_FAILED);
      return;
    }

    if (!checkAndRegisterNonce(pub, ts, sig)) {
      reply.code(401).send(AUTH_FAILED);
      return;
    }

    const actor = lookupActor(actorType, pub, body);
    if (!actor) {
      reply.code(401).send(AUTH_FAILED);
      return;
    }

    req.actor = actor;
  };
}
