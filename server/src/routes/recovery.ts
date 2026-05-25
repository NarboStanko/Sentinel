import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { db, audit } from '../db.js';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes } from '@noble/hashes/utils';

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
      const delay = Math.max(0, req.body.delaySec ?? 24 * 3600); // default 24h
      const id = 'rec_' + nanoid(12);
      db.prepare('INSERT INTO recoveries (id, owner_id, new_public_key, unlock_at, created_at) VALUES (?,?,?,?,?)')
        .run(id, ownerId, newPublicKey, Date.now() + delay * 1000, Date.now());
      audit(null, 'RECOVERY_INITIATED');
      // TODO: push ai contatti + al vecchio push token del proprietario (rilevazione attacco)
      return { recoveryId: id, unlockAt: Date.now() + delay * 1000 };
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
      audit(null, 'RECOVERY_APPROVED');
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
    // ROTAZIONE: cambia solo la chiave pubblica di controllo. Quote e contenuti intatti.
    db.prepare('UPDATE users SET public_key = ? WHERE id = ?').run(rec.new_public_key, rec.owner_id);
    db.prepare('UPDATE recoveries SET finalized = 1 WHERE id = ?').run(req.body.recoveryId);
    audit(null, 'RECOVERY_FINALIZED');
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
    audit(null, 'RECOVERY_CANCELLED');
    return { ok: true };
  });
}
