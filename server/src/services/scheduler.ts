import { db, audit } from '../db.js';
import { sendPush, checkinPush, approvalPush } from './pushSender.js';

// IL BATTITO. Gira sul server, non sul telefono (i timer in background mobile
// non sono affidabili). Ogni tick controlla gli switch armati:
//  - scaduto l'intervallo  -> push «tutto ok?» + entra in GRACE
//  - scaduta anche la grazia -> APPROVAL_PENDING + push ai contatti
// Il rilascio vero avviene solo quando >= k contatti approvano (vedi approvals).
export function startScheduler(log: { info: Function; warn: Function }) {
  const TICK_MS = 2000;
  setInterval(() => {
    const now = Date.now();
    const active = db.prepare(
      "SELECT * FROM switches WHERE state IN ('ACTIVE','GRACE')"
    ).all() as any[];

    for (const sw of active) {
      if (sw.state === 'ACTIVE' && now >= sw.next_check_at) {
        // Manda la richiesta di check-in all'owner ed entra in grazia
        db.prepare("UPDATE switches SET state='GRACE', next_check_at=? WHERE id=?")
          .run(now + sw.grace_sec * 1000, sw.id);
        const owner = db.prepare('SELECT push_token FROM users WHERE id=?').get(sw.owner_id) as any;
        if (owner?.push_token) sendPush([checkinPush(owner.push_token)], log);
        audit(sw.id, 'CHECK_PENDING');
        log.info({ sw: sw.id }, 'GRACE: richiesta check-in inviata');
      } else if (sw.state === 'GRACE' && now >= sw.next_check_at) {
        // Nessuna risposta: chiedi l'approvazione ai contatti
        db.prepare("UPDATE switches SET state='APPROVAL_PENDING' WHERE id=?").run(sw.id);
        const owner = db.prepare('SELECT display_name FROM users WHERE id=?').get(sw.owner_id) as any;
        const contacts = db.prepare('SELECT push_token FROM contacts WHERE owner_id=?')
          .all(sw.owner_id) as any[];
        const msgs = contacts
          .filter((c) => c.push_token)
          .map((c) => approvalPush(c.push_token, owner?.display_name ?? 'Questa persona'));
        if (msgs.length) sendPush(msgs, log);
        audit(sw.id, 'APPROVAL_REQUESTED');
        log.warn({ sw: sw.id }, 'APPROVAL_PENDING: richieste inviate ai contatti');
      }
    }
  }, TICK_MS);
}
