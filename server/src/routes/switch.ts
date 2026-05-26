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

      // NB: la soglia k NON viene inviata al server. Resta solo sul client
      // (serve a splitSecret); il server non deve conoscerla -> occultamento.
      const id = 'sw_' + nanoid(10);
      db.prepare(
        `INSERT INTO switches (id, owner_id, state, interval_sec, grace_sec)
         VALUES (?,?, 'DISARMED', ?, ?)`
      ).run(id, ownerId, intervalSec, graceSec);
      return { switchId: id };
    }
  );

  // Arma: salva puntatore al drive (contenuto CIFRATO altrove) + le quote cifrate.
  app.post<{
    Body: {
      switchId: string;
      drivePointer: string;
      contentIv: string;
      shares: { x: number; blob: string }[]; // opache: reali + esche, mescolate dal client
    };
  }>('/switch/arm', async (req, reply) => {
    const { switchId, drivePointer, contentIv, shares } = req.body;
    const now = Date.now();
    const sw = db.prepare('SELECT interval_sec FROM switches WHERE id = ?').get(switchId) as
      | { interval_sec: number } | undefined;
    if (!sw) return reply.code(404).send({ error: 'switch_non_trovato', message: 'Switch non trovato.' });

    db.prepare('DELETE FROM shares WHERE switch_id = ?').run(switchId);
    const ins = db.prepare('INSERT INTO shares (id, switch_id, x, blob) VALUES (?,?,?,?)');
    for (const sh of shares) ins.run('sh_' + nanoid(8), switchId, sh.x, sh.blob);

    db.prepare(
      `UPDATE switches SET state='ACTIVE', drive_pointer=?, content_iv=?,
       last_checkin=?, next_check_at=?, armed_at=? WHERE id=?`
    ).run(drivePointer, contentIv, now, now + withJitter(sw.interval_sec) * 1000, now, switchId);
    audit(switchId, 'ARMED');
    return { ok: true };
  });

  app.post<{ Body: { switchId: string } }>('/switch/disarm', async (req) => {
    db.prepare("UPDATE switches SET state='DISARMED', next_check_at=NULL WHERE id=?")
      .run(req.body.switchId);
    db.prepare('DELETE FROM shares WHERE switch_id = ?').run(req.body.switchId);
    audit(req.body.switchId, 'DISARMED');
    return { ok: true };
  });

  app.get<{ Querystring: { switchId: string } }>('/switch', async (req) => {
    const sw = db.prepare('SELECT * FROM switches WHERE id = ?').get(req.query.switchId);
    return { switch: sw };
  });
}
