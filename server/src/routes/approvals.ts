import type { FastifyInstance } from 'fastify';
import { db, audit } from '../db.js';
import {
  checkSuspiciousLockout,
  checkSubmitLimit,
  trackCumulativeSubmit,
  clearCumulativeOnRelease,
} from '../services/rateLimiter.js';
import { getLimits } from '../config/limits.js';
import { requireAuth } from '../middleware/auth.js';
import { validateBody, approvalSubmitSchema, releaseConfirmSchema } from '../middleware/validate.js';

// SOGLIA + OCCULTAMENTO (k nascosto al server)
// Il server NON conosce k. Custodisce blob opachi (reali + esche), raccoglie le
// quote decifrate reinviate dai contatti, e le restituisce. E' il CLIENT che,
// provando a ricombinare e decifrare il contenuto, scopre se la soglia e' stata
// raggiunta, e solo allora conferma il rilascio (/release/confirm).
export async function approvalRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { switchId: string } }>('/approval/request', async (req) => {
    const sw = db.prepare('SELECT state FROM switches WHERE id = ?').get(req.query.switchId) as any;
    if (!sw || (sw.state !== 'APPROVAL_PENDING' && sw.state !== 'RELEASED')) return { pending: false };
    const submitted = db.prepare(
      'SELECT COUNT(*) AS n FROM shares WHERE switch_id = ? AND submitted_share IS NOT NULL'
    ).get(req.query.switchId) as { n: number };
    // I puntatori vengono esposti SOLO dopo il rilascio confermato (RELEASED).
    // Gate intenzionale: i contatti hanno le quote ma non i blob finché non è RELEASED.
    const released = sw.state === 'RELEASED';
    const contents = released
      ? (db.prepare(
          'SELECT drive_pointer, content_iv, label FROM switch_contents WHERE switch_id = ? ORDER BY created_at'
        ).all(req.query.switchId) as any[]).map(r => ({
          drivePointer: r.drive_pointer,
          contentIv:    r.content_iv,
          label:        r.label,
        }))
      : undefined;
    return {
      pending:      sw.state === 'APPROVAL_PENDING',
      released,
      approvedCount: submitted.n,
      contents,
    };
  });

  // Tutti i blob opachi (reali + esche) per la trial decryption. Solo durante l'attesa.
  app.get<{ Querystring: { switchId: string } }>('/shares', async (req) => {
    const sw = db.prepare('SELECT state FROM switches WHERE id = ?').get(req.query.switchId) as any;
    if (!sw || (sw.state !== 'APPROVAL_PENDING' && sw.state !== 'RELEASED')) return { blobs: [] };
    const rows = db.prepare('SELECT blob FROM shares WHERE switch_id = ?').all(req.query.switchId) as
      { blob: string }[];
    return { blobs: rows.map((r) => r.blob) };
  });

  // Il contatto reinvia la quota decifrata. L'identità è verificata via firma P-256 (requireAuth).
  // Il server restituisce TUTTE le quote raccolte finora; il client tenta la ricombinazione.
  // Rate-limit keyed per contact_id (non per IP) per evitare che diversi contatti si blocchino.
  app.post<{ Body: { switchId: string; share: { x: number; y: string }; pub: string; ts: number; sig: string } }>(
    '/approval/submit',
    { preHandler: [requireAuth('contact-of-switch'), validateBody(approvalSubmitSchema)] },
    async (req, reply) => {
      const { switchId, share } = req.body;
      const actorId = req.actor!.id;   // contact_id verificato dal middleware
      const limits = getLimits();

      // 1. Check lockout da pattern sospetto (prevale sul limite normale)
      const lockout = checkSuspiciousLockout(actorId, switchId);
      if (lockout.locked) {
        const resetAt = lockout.resetAt ?? Date.now() + 3_600_000;
        return reply
          .header('X-RateLimit-Limit', String(limits.LOCKOUT_LIMIT_PER_HOUR))
          .header('X-RateLimit-Remaining', '0')
          .header('X-RateLimit-Reset', String(Math.floor(resetAt / 1000)))
          .header('Retry-After', String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))))
          .code(429)
          .send({ error: 'rate_limit_exceeded', message: 'Limite approvazioni raggiunto.' });
      }

      // 2. Se non in periodo di lockout, applica il limite orario normale
      if (!lockout.isActiveLockout) {
        const submitResult = checkSubmitLimit(actorId, switchId);
        if (!submitResult.allowed) {
          return reply
            .header('X-RateLimit-Limit', String(limits.SUBMIT_PER_HOUR))
            .header('X-RateLimit-Remaining', '0')
            .header('X-RateLimit-Reset', String(Math.floor(submitResult.resetAt / 1000)))
            .header('Retry-After', String(Math.max(1, Math.ceil((submitResult.resetAt - Date.now()) / 1000))))
            .code(429)
            .send({ error: 'rate_limit_exceeded', message: 'Limite approvazioni raggiunto.' });
        }
      }

      // 3. Traccia il contatore cumulativo (può attivare lockout per le prossime richieste)
      trackCumulativeSubmit(actorId, switchId);

      // 4. Overwrite protection: AND submitted_share IS NULL
      const info = db.prepare(
        'UPDATE shares SET submitted_share = ? WHERE switch_id = ? AND x = ? AND submitted_share IS NULL'
      ).run(JSON.stringify(share), switchId, share.x);
      if (info.changes === 0) {
        audit(switchId, 'SHARE_OVERWRITE_ATTEMPTED');
        return reply.code(409).send({ error: 'share_gia_sottomessa', message: 'Quota già inviata per questo indice.' });
      }
      audit(switchId, 'SHARE_SUBMITTED');
      const submitted = db.prepare(
        'SELECT submitted_share FROM shares WHERE switch_id = ? AND submitted_share IS NOT NULL'
      ).all(switchId) as { submitted_share: string }[];
      return { collected: submitted.map((s) => JSON.parse(s.submitted_share)) };
    }
  );

  // Un client che e' riuscito a ricombinare+decifrare conferma il rilascio.
  app.post<{ Body: { switchId: string; pub: string; ts: number; sig: string } }>(
    '/release/confirm',
    { preHandler: [requireAuth('contact-of-switch'), validateBody(releaseConfirmSchema)] },
    async (req) => {
      db.prepare("UPDATE switches SET state='RELEASED' WHERE id=? AND state='APPROVAL_PENDING'")
        .run(req.body.switchId);
      audit(req.body.switchId, 'RELEASED');
      clearCumulativeOnRelease(req.body.switchId);
      return { ok: true };
    }
  );
}
