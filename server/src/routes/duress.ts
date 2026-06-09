import type { FastifyInstance } from 'fastify';
import { db, audit } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { appendToChain } from '../services/auditChain.js';
import { sendPush, approvalPush } from '../services/pushSender.js';

// Rate-limit: massimo 3 trigger al giorno per owner.
// Usa la tabella rate_limits esistente con chiave "duress:{ownerId}".
function checkDuressRateLimit(ownerId: string): { allowed: boolean; resetAt: number } {
  const windowMs = 24 * 3_600_000;
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const resetAt = windowStart + windowMs;
  const key = `duress:${ownerId}`;

  const row = db.prepare('SELECT count, window_start FROM rate_limits WHERE key = ?')
    .get(key) as { count: number; window_start: number } | undefined;

  if (!row || row.window_start < windowStart) {
    db.prepare('INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)')
      .run(key, windowStart);
    return { allowed: true, resetAt };
  }
  if (row.count >= 3) {
    return { allowed: false, resetAt };
  }
  db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').run(key);
  return { allowed: true, resetAt };
}

export async function duressRoutes(app: FastifyInstance) {
  // POST /duress/trigger
  // Owner-only: muove tutti gli switch ACTIVE/GRACE in APPROVAL_PENDING
  // e invia push ai contatti — identico a ciò che fa lo scheduler allo scadere
  // della grace, ma attivato deliberatamente dall'owner sotto coercizione.
  app.post<{
    Body: { pub: string; ts: number; sig: string };
  }>(
    '/duress/trigger',
    { preHandler: [requireAuth('owner')] },
    async (req, reply) => {
      const ownerId = req.actor!.id;

      const { allowed, resetAt } = checkDuressRateLimit(ownerId);
      if (!allowed) {
        return reply.code(429).send({
          error: 'rate_limit',
          message: 'Limite giornaliero raggiunto (3 trigger al giorno).',
          resetAt,
        });
      }

      const switches = db.prepare(
        "SELECT id FROM switches WHERE owner_id = ? AND state IN ('ACTIVE','GRACE')"
      ).all(ownerId) as { id: string }[];

      const owner = db.prepare('SELECT display_name FROM users WHERE id = ?')
        .get(ownerId) as { display_name: string | null } | undefined;

      // Tutti gli UPDATE sono atomici: o passano tutti o nessuno.
      // DURESS_TRIGGERED_INITIATED è dentro la transazione per coerenza con gli UPDATE.
      // Le push sono fuori: I/O di rete non è rollbackabile e bloccherebbe il commit.
      const updateAll = db.transaction(() => {
        try {
          appendToChain({
            chain_owner_id: ownerId,
            event_type:     'DURESS_TRIGGERED_INITIATED',
            actor_id:       ownerId,
            payload:        {},
            signature:      req.body.sig,
          });
        } catch (e) { console.error('auditChain DURESS_TRIGGERED_INITIATED', e); }

        for (const sw of switches) {
          db.prepare("UPDATE switches SET state='APPROVAL_PENDING' WHERE id=?").run(sw.id);
          audit(sw.id, 'DURESS_TRIGGERED');

          try {
            appendToChain({
              chain_owner_id: ownerId,
              event_type:     'DURESS_TRIGGERED',
              actor_id:       ownerId,
              payload:        { switchId: sw.id },
              signature:      req.body.sig,
            });
          } catch (e) { console.error('auditChain DURESS_TRIGGERED', e); }
        }
      });
      updateAll();

      // Push fuori dalla transazione: rete non è rollbackabile.
      if (switches.length > 0) {
        const contacts = db.prepare('SELECT push_token FROM contacts WHERE owner_id = ?')
          .all(ownerId) as { push_token: string | null }[];
        const msgs = contacts
          .filter(c => c.push_token)
          .map(c => approvalPush(c.push_token!, owner?.display_name ?? 'Questa persona'));
        if (msgs.length) {
          sendPush(msgs, app.log as any).catch(() => {});
        }
      }

      return { ok: true, switchesTriggered: switches.length };
    }
  );
}
