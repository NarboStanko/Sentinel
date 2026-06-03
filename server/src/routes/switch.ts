import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { db, audit } from '../db.js';
import { withJitter } from './checkin.js';

const HOUR = 3600;
const DAY  = 86400;

function getLimits(isDev: boolean) {
  return isDev
    ? { intervalMin: 30,   intervalMax: 31 * DAY, graceMin: 10   }
    : { intervalMin: HOUR, intervalMax: 31 * DAY, graceMin: HOUR };
}

export async function switchRoutes(app: FastifyInstance) {
  app.post<{ Body: { ownerId: string; intervalSec: number; graceSec: number } }>(
    '/switch/create',
    async (req, reply) => {
      const { ownerId, intervalSec, graceSec } = req.body;
      const limits = getLimits(process.env['NODE_ENV'] !== 'production');

      if (intervalSec < limits.intervalMin || intervalSec > limits.intervalMax) {
        return reply.code(400).send({
          error: 'intervallo_non_valido',
          message: `Intervallo non valido: min ${limits.intervalMin}s, max ${limits.intervalMax}s.`,
        });
      }
      if (graceSec < limits.graceMin) {
        return reply.code(400).send({
          error: 'grazia_non_valida',
          message: `Periodo di grazia non valido: min ${limits.graceMin}s.`,
        });
      }

      // NB: la soglia k NON viene inviata al server. Resta solo sul client.
      const id = 'sw_' + nanoid(10);
      db.prepare(
        `INSERT INTO switches (id, owner_id, state, interval_sec, grace_sec)
         VALUES (?,?, 'DISARMED', ?, ?)`
      ).run(id, ownerId, intervalSec, graceSec);
      return { switchId: id };
    }
  );

  // Arma: inserisce il primo contenuto cifrato in switch_contents e attiva lo switch.
  // Le quote Shamir sono opache (reali + esche mescolate dal client).
  // Restituisce contentId per permettere al client di tenere la mappa contentId→pointer.
  app.post<{
    Body: {
      switchId: string;
      drivePointer: string;
      contentIv: string;
      label?: string;
      shares: { x: number; blob: string }[];
      recoveryK?: number;
    };
  }>('/switch/arm', async (req, reply) => {
    const { switchId, drivePointer, contentIv, label, shares, recoveryK } = req.body;
    const now = Date.now();
    const sw = db.prepare('SELECT interval_sec FROM switches WHERE id = ?').get(switchId) as
      | { interval_sec: number } | undefined;
    if (!sw) return reply.code(404).send({ error: 'switch_non_trovato', message: 'Switch non trovato.' });

    db.prepare('DELETE FROM shares WHERE switch_id = ?').run(switchId);
    db.prepare('DELETE FROM switch_contents WHERE switch_id = ?').run(switchId);

    const ins = db.prepare('INSERT INTO shares (id, switch_id, x, blob) VALUES (?,?,?,?)');
    for (const sh of shares) ins.run('sh_' + nanoid(8), switchId, sh.x, sh.blob);

    const contentId = 'sc_' + nanoid(10);
    db.prepare(
      'INSERT INTO switch_contents (id, switch_id, drive_pointer, content_iv, label, created_at) VALUES (?,?,?,?,?,?)'
    ).run(contentId, switchId, drivePointer, contentIv, label ?? '', now);

    db.prepare(
      `UPDATE switches SET state='ACTIVE', last_checkin=?, next_check_at=?, armed_at=? WHERE id=?`
    ).run(now, now + withJitter(sw.interval_sec) * 1000, now, switchId);
    audit(switchId, 'ARMED');

    if (typeof recoveryK === 'number' && recoveryK >= 1) {
      const owner = db.prepare('SELECT owner_id FROM switches WHERE id = ?').get(switchId) as { owner_id: string } | undefined;
      if (owner) db.prepare('UPDATE users SET recovery_k = ? WHERE id = ?').run(recoveryK, owner.owner_id);
    }

    return { ok: true, contentId };
  });

  // Aggiunge un nuovo contenuto cifrato a uno switch ACTIVE (append, non sovrascrittura).
  // Stessa DEK → le quote Shamir esistenti rimangono valide, nessuna ridistribuzione.
  // Conta come check-in: resetta next_check_at.
  app.post<{ Body: { switchId: string; drivePointer: string; contentIv: string; label?: string } }>(
    '/switch/add-content',
    async (req, reply) => {
      const { switchId, drivePointer, contentIv, label } = req.body;
      const sw = db.prepare('SELECT state, interval_sec FROM switches WHERE id = ?').get(switchId) as
        | { state: string; interval_sec: number } | undefined;
      if (!sw) return reply.code(404).send({ error: 'switch_non_trovato', message: 'Switch non trovato.' });
      if (sw.state !== 'ACTIVE') return reply.code(409).send({
        error: 'switch_non_attivo',
        message: 'Il contenuto può essere aggiunto solo quando lo switch è ACTIVE.',
      });
      const now = Date.now();
      const nextCheckAt = now + withJitter(sw.interval_sec) * 1000;
      const contentId = 'sc_' + nanoid(10);
      db.prepare(
        'INSERT INTO switch_contents (id, switch_id, drive_pointer, content_iv, label, created_at) VALUES (?,?,?,?,?,?)'
      ).run(contentId, switchId, drivePointer, contentIv, label ?? '', now);
      db.prepare(
        'UPDATE switches SET last_checkin=?, next_check_at=? WHERE id=?'
      ).run(now, nextCheckAt, switchId);
      audit(switchId, 'CONTENT_ADDED');
      return { ok: true, contentId, nextCheckAt };
    }
  );

  // Rimuove un singolo contenuto da uno switch ACTIVE.
  // Blocca se è l'ultimo contenuto (un pacchetto armato deve avere almeno un contenuto).
  // Il client deve cancellare il blob dallo storage PRIMA di chiamare questo endpoint.
  // Conta come check-in: resetta next_check_at.
  app.post<{ Body: { switchId: string; contentId: string } }>(
    '/switch/remove-content',
    async (req, reply) => {
      const { switchId, contentId } = req.body;
      const sw = db.prepare('SELECT state, interval_sec FROM switches WHERE id = ?').get(switchId) as
        | { state: string; interval_sec: number } | undefined;
      if (!sw) return reply.code(404).send({ error: 'switch_non_trovato', message: 'Switch non trovato.' });
      if (sw.state !== 'ACTIVE') return reply.code(409).send({
        error: 'switch_non_attivo',
        message: 'I contenuti possono essere rimossi solo quando lo switch è ACTIVE.',
      });
      const count = db.prepare('SELECT COUNT(*) AS n FROM switch_contents WHERE switch_id = ?')
        .get(switchId) as { n: number };
      if (count.n <= 1) return reply.code(409).send({
        error: 'contenuto_minimo',
        message: 'Un pacchetto armato deve contenere almeno un contenuto.',
      });
      const info = db.prepare('DELETE FROM switch_contents WHERE id = ? AND switch_id = ?')
        .run(contentId, switchId);
      if (info.changes === 0) return reply.code(404).send({ error: 'contenuto_non_trovato', message: 'Contenuto non trovato.' });
      const now = Date.now();
      const nextCheckAt = now + withJitter(sw.interval_sec) * 1000;
      db.prepare('UPDATE switches SET last_checkin=?, next_check_at=? WHERE id=?')
        .run(now, nextCheckAt, switchId);
      audit(switchId, 'CONTENT_REMOVED');
      return { ok: true, nextCheckAt };
    }
  );

  // Lista dei contenuti di uno switch (label + id, senza puntatori — mai esposti prima di RELEASED).
  app.get<{ Querystring: { switchId: string } }>('/switch/contents', async (req, reply) => {
    const sw = db.prepare('SELECT state FROM switches WHERE id = ?').get(req.query.switchId) as any;
    if (!sw) return reply.code(404).send({ error: 'switch_non_trovato', message: 'Switch non trovato.' });
    const rows = db.prepare(
      'SELECT id, label, created_at FROM switch_contents WHERE switch_id = ? ORDER BY created_at'
    ).all(req.query.switchId) as { id: string; label: string; created_at: number }[];
    return { contents: rows };
  });

  app.post<{ Body: { switchId: string } }>('/switch/disarm', async (req) => {
    db.prepare("UPDATE switches SET state='DISARMED', next_check_at=NULL WHERE id=?")
      .run(req.body.switchId);
    db.prepare('DELETE FROM shares WHERE switch_id = ?').run(req.body.switchId);
    db.prepare('DELETE FROM switch_contents WHERE switch_id = ?').run(req.body.switchId);
    audit(req.body.switchId, 'DISARMED');
    return { ok: true };
  });

  app.get<{ Querystring: { switchId: string } }>('/switch', async (req) => {
    const sw = db.prepare('SELECT * FROM switches WHERE id = ?').get(req.query.switchId);
    return { switch: sw };
  });
}
