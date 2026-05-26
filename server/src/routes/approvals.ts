import type { FastifyInstance } from 'fastify';
import { db, audit } from '../db.js';

// SOGLIA + OCCULTAMENTO (k nascosto al server)
// Il server NON conosce k. Custodisce blob opachi (reali + esche), raccoglie le
// quote decifrate reinviate dai contatti, e le restituisce. E' il CLIENT che,
// provando a ricombinare e decifrare il contenuto, scopre se la soglia e' stata
// raggiunta, e solo allora conferma il rilascio (/release/confirm).
export async function approvalRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { switchId: string } }>('/approval/request', async (req) => {
    const sw = db.prepare(
      'SELECT state, drive_pointer, content_iv FROM switches WHERE id = ?'
    ).get(req.query.switchId) as any;
    if (!sw || (sw.state !== 'APPROVAL_PENDING' && sw.state !== 'RELEASED')) return { pending: false };
    const submitted = db.prepare(
      'SELECT COUNT(*) AS n FROM shares WHERE switch_id = ? AND submitted_share IS NOT NULL'
    ).get(req.query.switchId) as { n: number };
    // drivePointer viene esposto SOLO dopo il rilascio confermato (RELEASED).
    // Prima di quel momento i contatti hanno le quote ma non il blob:
    // la sicurezza è nella cifratura, questo gate aggiunge una barriera intenzionale.
    const released = sw.state === 'RELEASED';
    return {
      pending:      sw.state === 'APPROVAL_PENDING',
      released,
      approvedCount: submitted.n,
      drivePointer: released ? sw.drive_pointer : undefined,
      contentIv:    released ? sw.content_iv    : undefined,
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

  // Il contatto reinvia la quota decifrata (anonimo: solo l'indice x). Il server
  // restituisce TUTTE le quote raccolte finora; sara' il client a tentare la
  // ricombinazione (cosi' il server non sa quante ne servano).
  app.post<{ Body: { switchId: string; share: { x: number; y: string } } }>(
    '/approval/submit',
    async (req) => {
      const { switchId, share } = req.body;
      db.prepare('UPDATE shares SET submitted_share = ? WHERE switch_id = ? AND x = ?')
        .run(JSON.stringify(share), switchId, share.x);
      audit(switchId, 'SHARE_SUBMITTED');
      const submitted = db.prepare(
        'SELECT submitted_share FROM shares WHERE switch_id = ? AND submitted_share IS NOT NULL'
      ).all(switchId) as { submitted_share: string }[];
      return { collected: submitted.map((s) => JSON.parse(s.submitted_share)) };
    }
  );

  // Un client che e' riuscito a ricombinare+decifrare conferma il rilascio.
  app.post<{ Body: { switchId: string } }>('/release/confirm', async (req) => {
    db.prepare("UPDATE switches SET state='RELEASED' WHERE id=? AND state='APPROVAL_PENDING'")
      .run(req.body.switchId);
    audit(req.body.switchId, 'RELEASED');
    return { ok: true };
  });
}
