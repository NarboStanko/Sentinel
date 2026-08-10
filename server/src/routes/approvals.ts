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
import { appendToChain } from '../services/auditChain.js';
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
      const switchOwner = db.prepare('SELECT owner_id FROM switches WHERE id = ?').get(switchId) as { owner_id: string } | undefined;

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

      // 4. Overwrite protection. Il server non conosce gli x delle quote armate
      //    (solo blob opachi): il dedup confronta l'x della quota in arrivo con
      //    le quote GIÀ SOTTOMESSE, e la nuova viene agganciata a uno slot libero.
      //    Re-invio IDENTICO (stessa x e stessa y) → idempotente: restituisce le
      //    quote raccolte senza modificare nulla. Serve al contatto che aveva già
      //    approvato in una sessione precedente e riapre dopo il RELEASED: possiede
      //    già la quota che invia, quindi non ottiene nulla che non abbia dimostrato
      //    di avere. Una y DIVERSA con x già usata resta un overwrite negato (409).
      const rows = db.prepare(
        'SELECT id, submitted_share FROM shares WHERE switch_id = ?'
      ).all(switchId) as { id: string; submitted_share: string | null }[];
      const identical = rows.some((r) => {
        if (r.submitted_share === null) return false;
        const s = JSON.parse(r.submitted_share) as { x: number; y: string };
        return s.x === share.x && s.y === share.y;
      });
      if (identical) {
        const already = db.prepare(
          'SELECT submitted_share FROM shares WHERE switch_id = ? AND submitted_share IS NOT NULL'
        ).all(switchId) as { submitted_share: string }[];
        return { collected: already.map((s) => JSON.parse(s.submitted_share)) };
      }
      const duplicate = rows.some(
        (r) => r.submitted_share !== null && (JSON.parse(r.submitted_share) as { x: number }).x === share.x
      );
      const freeSlot = rows.find((r) => r.submitted_share === null);
      if (duplicate || !freeSlot) {
        audit(switchId, 'SHARE_OVERWRITE_ATTEMPTED');
        if (switchOwner) try { appendToChain({ chain_owner_id: switchOwner.owner_id, event_type: 'SHARE_OVERWRITE_ATTEMPTED', actor_id: actorId, payload: { switchId, x: share.x }, signature: req.body.sig }); } catch (e) { console.error('auditChain SHARE_OVERWRITE_ATTEMPTED', e); }
        return reply.code(409).send({ error: 'share_gia_sottomessa', message: 'Quota già inviata per questo indice.' });
      }
      db.prepare('UPDATE shares SET submitted_share = ? WHERE id = ? AND submitted_share IS NULL')
        .run(JSON.stringify(share), freeSlot.id);
      audit(switchId, 'SHARE_SUBMITTED');
      if (switchOwner) try { appendToChain({ chain_owner_id: switchOwner.owner_id, event_type: 'SHARE_SUBMITTED', actor_id: actorId, payload: { switchId, x: share.x }, signature: req.body.sig }); } catch (e) { console.error('auditChain SHARE_SUBMITTED', e); }
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
      const releaseSwitchOwner = db.prepare('SELECT owner_id FROM switches WHERE id = ?').get(req.body.switchId) as { owner_id: string } | undefined;
      db.prepare("UPDATE switches SET state='RELEASED' WHERE id=? AND state='APPROVAL_PENDING'")
        .run(req.body.switchId);
      audit(req.body.switchId, 'RELEASED');
      if (releaseSwitchOwner) try { appendToChain({ chain_owner_id: releaseSwitchOwner.owner_id, event_type: 'RELEASED', actor_id: req.actor!.id, payload: { switchId: req.body.switchId }, signature: req.body.sig }); } catch (e) { console.error('auditChain RELEASED', e); }
      clearCumulativeOnRelease(req.body.switchId);
      return { ok: true };
    }
  );
}
