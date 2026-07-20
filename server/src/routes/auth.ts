import type { FastifyInstance } from 'fastify';
import { validateBody, authChallengeSchema, authVerifySchema } from '../middleware/validate.js';
import { nanoid } from 'nanoid';
import { db } from '../db.js';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes } from '@noble/hashes/utils';

// AUTENTICAZIONE PASSWORDLESS (challenge-response)
// Il server conosce solo la chiave PUBBLICA. Per dimostrare di essere il
// proprietario da un nuovo device/browser, il client firma un nonce con la
// chiave privata derivata dalla seed phrase. Niente password, niente segreti
// lato server. E' anche il percorso di recovery: "perso il telefono -> entro
// da browser inserendo la seed".
const challenges = new Map<string, { nonce: string; exp: number }>();
const sessions = new Map<string, { ownerId: string; exp: number }>();

export function verifySession(token?: string): string | null {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s || s.exp < Date.now()) return null;
  return s.ownerId;
}

export async function authRoutes(app: FastifyInstance) {
  // 1) il client chiede una sfida per la propria chiave pubblica
  app.post<{ Body: { publicKey: string } }>(
    '/auth/challenge',
    { preHandler: [validateBody(authChallengeSchema)] },
    async (req) => {
    const nonce = 'sentinella:' + nanoid(24);
    challenges.set(req.body.publicKey, { nonce, exp: Date.now() + 2 * 60_000 });
    return { nonce }; // restituito sempre, per non rivelare se l'utente esiste
  });

  // 2) il client invia la firma del nonce; il server verifica e apre la sessione
  app.post<{ Body: { publicKey: string; nonce: string; sig: string } }>(
    '/auth/verify',
    { preHandler: [validateBody(authVerifySchema)] },
    async (req) => {
      const { publicKey, nonce, sig } = req.body;
      const ch = challenges.get(publicKey);
      if (!ch || ch.nonce !== nonce || ch.exp < Date.now())
        return { ok: false, reason: 'challenge non valida' };

      const msgHash = sha256(new TextEncoder().encode(nonce));
      const valid = p256.verify(hexToBytes(sig), msgHash, hexToBytes(publicKey));
      if (!valid) return { ok: false, reason: 'firma non valida' };

      const user = db.prepare('SELECT id FROM users WHERE public_key = ?').get(publicKey) as
        | { id: string } | undefined;
      if (!user) return { ok: false, reason: 'nessun proprietario per questa chiave' };
      challenges.delete(publicKey);

      const token = nanoid(32);
      sessions.set(token, { ownerId: user.id, exp: Date.now() + 30 * 60_000 });
      const switches = db.prepare(
        'SELECT id, state, interval_sec, grace_sec, next_check_at FROM switches WHERE owner_id = ?'
      ).all(user.id);
      return { ok: true, token, ownerId: user.id, switches };
    }
  );
}
