import type { FastifyInstance } from 'fastify';
import { db, audit } from '../db.js';
import { getLimits } from '../config/limits.js';

function currentWindow(windowMs: number): number {
  return Math.floor(Date.now() / windowMs) * windowMs;
}

export interface WindowResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
}

function checkWindow(key: string, windowMs: number, limit: number): WindowResult {
  const windowStart = currentWindow(windowMs);
  const resetAt = windowStart + windowMs;
  const row = db.prepare('SELECT count, window_start FROM rate_limits WHERE key = ?').get(key) as
    { count: number; window_start: number } | undefined;

  if (!row || row.window_start < windowStart) {
    db.prepare('INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)')
      .run(key, windowStart);
    return { allowed: true, remaining: limit - 1, resetAt, limit };
  }
  if (row.count >= limit) {
    return { allowed: false, remaining: 0, resetAt, limit };
  }
  db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').run(key);
  return { allowed: true, remaining: limit - row.count - 1, resetAt, limit };
}

export function checkIpLimit(ip: string): WindowResult {
  return checkWindow(`ip:${ip}`, 60_000, getLimits().IP_PER_MINUTE);
}

export function checkSubmitLimit(actorId: string, switchId: string): WindowResult {
  return checkWindow(`submit:${switchId}:${actorId}`, 3_600_000, getLimits().SUBMIT_PER_HOUR);
}

export interface LockoutResult {
  locked: boolean;
  isActiveLockout: boolean;
  resetAt?: number;
}

export function checkSuspiciousLockout(actorId: string, switchId: string): LockoutResult {
  const lockoutKey = `lockout:${switchId}:${actorId}`;
  const lockoutRow = db.prepare('SELECT window_start FROM rate_limits WHERE key = ?').get(lockoutKey) as
    { window_start: number } | undefined;

  if (!lockoutRow) return { locked: false, isActiveLockout: false };

  const { LOCKOUT_DURATION_MS, LOCKOUT_LIMIT_PER_HOUR } = getLimits();
  const lockoutEnd = lockoutRow.window_start + LOCKOUT_DURATION_MS;

  if (Date.now() >= lockoutEnd) {
    db.prepare('DELETE FROM rate_limits WHERE key = ?').run(lockoutKey);
    db.prepare('DELETE FROM rate_limits WHERE key = ?').run(`lockout_window:${switchId}:${actorId}`);
    return { locked: false, isActiveLockout: false };
  }

  // Lockout active — enforce 1/hr sub-window
  const windowKey = `lockout_window:${switchId}:${actorId}`;
  const windowMs = 3_600_000;
  const windowStart = currentWindow(windowMs);
  const resetAt = windowStart + windowMs;
  const wRow = db.prepare('SELECT count, window_start FROM rate_limits WHERE key = ?').get(windowKey) as
    { count: number; window_start: number } | undefined;

  if (!wRow || wRow.window_start < windowStart) {
    db.prepare('INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)')
      .run(windowKey, windowStart);
    return { locked: false, isActiveLockout: true };
  }
  if (wRow.count >= LOCKOUT_LIMIT_PER_HOUR) {
    return { locked: true, isActiveLockout: true, resetAt };
  }
  db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').run(windowKey);
  return { locked: false, isActiveLockout: true };
}

export function trackCumulativeSubmit(actorId: string, switchId: string): void {
  const key = `cumul:${switchId}:${actorId}`;
  const row = db.prepare('SELECT count FROM rate_limits WHERE key = ?').get(key) as
    { count: number } | undefined;
  const newCount = (row?.count ?? 0) + 1;

  if (!row) {
    db.prepare('INSERT INTO rate_limits (key, count, window_start) VALUES (?, ?, ?)')
      .run(key, 1, Date.now());
  } else {
    db.prepare('UPDATE rate_limits SET count = ? WHERE key = ?').run(newCount, key);
  }

  if (newCount === getLimits().SUSPICIOUS_THRESHOLD) {
    const lockoutKey = `lockout:${switchId}:${actorId}`;
    db.prepare('INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?, 0, ?)')
      .run(lockoutKey, Date.now());
    // Pre-consume this hour's allowance so the very next request is blocked
    const windowKey = `lockout_window:${switchId}:${actorId}`;
    db.prepare('INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)')
      .run(windowKey, currentWindow(3_600_000));
    audit(switchId, 'SUSPICIOUS_SUBMIT_PATTERN');
  }
}

export function clearCumulativeOnRelease(switchId: string): void {
  for (const prefix of ['cumul', 'lockout', 'lockout_window', 'submit']) {
    db.prepare('DELETE FROM rate_limits WHERE key LIKE ?').run(`${prefix}:${switchId}:%`);
  }
}

export function cleanupExpiredEntries(): void {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  db.prepare(
    "DELETE FROM rate_limits WHERE window_start < ? AND key NOT LIKE 'cumul:%' AND key NOT LIKE 'lockout:%'"
  ).run(cutoff);
}

export function registerIpRateLimitHook(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return;
    const result = checkIpLimit(req.ip);
    if (!result.allowed) {
      const now = Date.now();
      reply
        .header('X-RateLimit-Limit', String(result.limit))
        .header('X-RateLimit-Remaining', '0')
        .header('X-RateLimit-Reset', String(Math.floor(result.resetAt / 1000)))
        .header('Retry-After', String(Math.max(1, Math.ceil((result.resetAt - now) / 1000))));
      return reply.code(429).send({ error: 'rate_limit_exceeded', message: 'Troppe richieste. Riprova più tardi.' });
    }
  });
}
