import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { db, audit } from '../db.js';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes } from '@noble/hashes/utils';
import { sendPush, recoveryPush } from '../services/pushSender.js';

// RECOVERY SOCIALE — FAIL-SAFE
// NON disarma e NON rilascia: ruota soltanto la chiave pubblica del proprietario
// (nuova seed su nuovo device) sotto QUORUM di contatti + RITARDO obbligatorio.
// Lo switch continua a girare; le quote (sigillate ai contatti) restano intatte.
// Freni: bloccato se uno switch e' in GRACE/APPROVAL_PENDING; annullabile da chi
// possiede ancora la chiave attuale.
export async function recoveryRoutes(app: FastifyInstance) {
  // Avviato dal proprietario da una NUOVA identita' (nuova seed su device nuovo)
  app.post<{ Body: { ownerId: string; newPublicKey: string; delaySec?: number } }>(
    '/recovery/initiate',
    async (req) => {
      const { ownerId, newPublicKey } = req.body;
      // Default 7 giorni (604800s). Non scendere sotto 0.
      const delay = Math.max(0, req.body.delaySec ?? 7 * 24 * 3600);

      // Blocca se uno switch e' in GRACE o APPROVAL_PENDING: non si puo' ruotare
      // l'identita' mentre un rilascio e' in corso.
      const inFlight = db.prepare(
        "SELECT 1 FROM switches WHERE owner_id = ? AND state IN ('GRACE','APPROVAL_PENDING')"
      ).get(ownerId);
      if (inFlight) {
        return { ok: false, reason: 'rilascio in corso: recovery bloccato' };
      }

      const id = 'rec_' + nanoid(12);
      const unlockAt = Date.now() + delay * 1000;
      db.prepare('INSERT INTO recoveries (id, owner_id, new_public_key, unlock_at, created_at) VALUES (?,?,?,?,?)')
        .run(id, ownerId, newPublicKey, unlockAt, Date.now());
      audit(null, 'ROTATION_REQUESTED');

      // Invia push ai contatti fidati (senza segreti: solo «apri l'app»)
      const owner = db.prepare('SELECT display_name FROM users WHERE id = ?').get(ownerId) as
        | { display_name: string | null } | undefined;
      const ownerName = owner?.display_name ?? '';
      const contacts = db.prepare('SELECT push_token FROM contacts WHERE owner_id = ?').all(ownerId) as
        { push_token: string | null }[];
      const msgs = contacts
        .filter((c) => c.push_token)
        .map((c) => recoveryPush(c.push_token!, ownerName));
      if (msgs.length > 0) sendPush(msgs, app.log).catch(() => {});

      return { ok: true, recoveryId: id, unlockAt };
    }
  );

  // Un contatto approva firmando il recoveryId con la PROPRIA chiave privata.
  app.post<{ Body: { recoveryId: string; contactPublicKey: string; sig: string } }>(
    '/recovery/approve',
    async (req) => {
      const { recoveryId, contactPublicKey, sig } = req.body;
      const rec = db.prepare('SELECT owner_id, finalized, cancelled FROM recoveries WHERE id = ?')
        .get(recoveryId) as any;
      if (!rec || rec.finalized || rec.cancelled) return { ok: false, reason: 'recovery non attivo' };
      // il firmatario deve essere un contatto fidato di questo proprietario
      const isContact = db.prepare('SELECT 1 FROM contacts WHERE owner_id = ? AND public_key = ?')
        .get(rec.owner_id, contactPublicKey);
      if (!isContact) return { ok: false, reason: 'non sei un contatto fidato' };
      const ok = p256.verify(hexToBytes(sig), sha256(new TextEncoder().encode(recoveryId)), hexToBytes(contactPublicKey));
      if (!ok) return { ok: false, reason: 'firma non valida' };
      db.prepare('INSERT OR IGNORE INTO recovery_approvals (recovery_id, contact_public_key, created_at) VALUES (?,?,?)')
        .run(recoveryId, contactPublicKey, Date.now());
      audit(null, 'ROTATION_APPROVED');
      const n = db.prepare('SELECT COUNT(*) AS n FROM recovery_approvals WHERE recovery_id = ?').get(recoveryId) as { n: number };
      return { ok: true, approvals: n.n };
    }
  );

  // Finalizza la rotazione. Guardie: ritardo trascorso + quorum + nessuno switch
  // in rilascio in corso.
  app.post<{ Body: { recoveryId: string } }>('/recovery/finalize', async (req) => {
    const rec = db.prepare('SELECT * FROM recoveries WHERE id = ?').get(req.body.recoveryId) as any;
    if (!rec || rec.finalized || rec.cancelled) return { ok: false, reason: 'non finalizzabile' };
    if (Date.now() < rec.unlock_at) return { ok: false, reason: 'ritardo non ancora trascorso' };
    const k = (db.prepare('SELECT recovery_k FROM users WHERE id = ?').get(rec.owner_id) as any)?.recovery_k ?? 2;
    const n = (db.prepare('SELECT COUNT(*) AS n FROM recovery_approvals WHERE recovery_id = ?').get(req.body.recoveryId) as any).n;
    if (n < k) return { ok: false, reason: `servono ${k} approvazioni (${n})` };
    const inFlight = db.prepare(
      "SELECT 1 FROM switches WHERE owner_id = ? AND state IN ('GRACE','APPROVAL_PENDING')"
    ).get(rec.owner_id);
    if (inFlight) return { ok: false, reason: 'rilascio in corso: recovery bloccato' };
    // INVARIANTE: ruota SOLO la chiave pubblica. Non tocca DEK, quote, switch state.
    db.prepare('UPDATE users SET public_key = ? WHERE id = ?').run(rec.new_public_key, rec.owner_id);
    db.prepare('UPDATE recoveries SET finalized = 1 WHERE id = ?').run(req.body.recoveryId);
    audit(null, 'ROTATION_COMPLETED');
    return { ok: true };
  });

  // Annullamento: chi possiede ancora la chiave ATTUALE puo' fermare un recovery
  // sospetto, firmando il recoveryId con la chiave attuale del proprietario.
  app.post<{ Body: { recoveryId: string; sig: string } }>('/recovery/cancel', async (req) => {
    const rec = db.prepare('SELECT owner_id, finalized FROM recoveries WHERE id = ?').get(req.body.recoveryId) as any;
    if (!rec || rec.finalized) return { ok: false, reason: 'non annullabile' };
    const owner = db.prepare('SELECT public_key FROM users WHERE id = ?').get(rec.owner_id) as any;
    const ok = p256.verify(hexToBytes(req.body.sig), sha256(new TextEncoder().encode(req.body.recoveryId)), hexToBytes(owner.public_key));
    if (!ok) return { ok: false, reason: 'firma non valida' };
    db.prepare('UPDATE recoveries SET cancelled = 1 WHERE id = ?').run(req.body.recoveryId);
    audit(null, 'ROTATION_CANCELLED');
    return { ok: true };
  });

  // Lista dei recovery pendenti per un contatto (stessa auth one-shot usata da /pending).
  // Il contatto firma sha256("sentinella:recovery-pending:" + pub + ":" + ts) con la sua chiave P-256.
  app.get<{
    Querystring: { pub: string; ts: string; sig: string };
  }>('/recovery/pending-for-contact', async (req, reply) => {
    const { pub, ts, sig } = req.query;

    // 1) timestamp fresco (±5 minuti)
    const tsNum = parseInt(ts, 10);
    if (!tsNum || Math.abs(Date.now() - tsNum) > 5 * 60_000) {
      return reply.code(401).send({ error: 'timestamp scaduto o mancante' });
    }

    // 2) firma valida — lega identita' e timestamp, non riutilizzabile
    let verified = false;
    try {
      const challenge = 'sentinella:recovery-pending:' + pub + ':' + ts;
      const msgHash = sha256(new TextEncoder().encode(challenge));
      verified = p256.verify(hexToBytes(sig), msgHash, hexToBytes(pub));
    } catch {
      return reply.code(401).send({ error: 'firma non valida' });
    }
    if (!verified) return reply.code(401).send({ error: 'firma non valida' });

    // 3) trova il contatto per chiave pubblica
    const contact = db
      .prepare('SELECT id, owner_id FROM contacts WHERE public_key = ?')
      .get(pub) as { id: string; owner_id: string } | undefined;
    if (!contact) return { recoveries: [] };

    // 4) restituisce i recovery aperti per l'owner di questo contatto
    const rows = db.prepare(
      `SELECT r.id AS recoveryId, u.display_name AS ownerName, r.unlock_at AS unlockAt,
              (SELECT COUNT(*) FROM recovery_approvals ra WHERE ra.recovery_id = r.id) AS approvalCount,
              (SELECT COUNT(*) FROM recovery_approvals ra2 WHERE ra2.recovery_id = r.id AND ra2.contact_public_key = ?) AS alreadyApproved
       FROM recoveries r
       JOIN users u ON u.id = r.owner_id
       WHERE r.owner_id = ? AND r.finalized = 0 AND r.cancelled = 0`
    ).all(pub, contact.owner_id) as {
      recoveryId: string;
      ownerName: string | null;
      unlockAt: number;
      approvalCount: number;
      alreadyApproved: number;
    }[];

    return {
      recoveries: rows.map((r) => ({
        recoveryId: r.recoveryId,
        ownerName: r.ownerName ?? 'Questa persona',
        unlockAt: r.unlockAt,
        approvalCount: r.approvalCount,
        alreadyApproved: r.alreadyApproved > 0,
      })),
    };
  });
}
