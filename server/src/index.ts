import Fastify from 'fastify';
import cors from '@fastify/cors';
import { pairingRoutes } from './routes/pairing.js';
import { switchRoutes } from './routes/switch.js';
import { checkinRoutes } from './routes/checkin.js';
import { vaultRoutes } from './routes/vault.js';
import { approvalRoutes } from './routes/approvals.js';
import { authRoutes } from './routes/auth.js';
import { recoveryRoutes } from './routes/recovery.js';
import { pushRoutes } from './routes/push.js';
import { pendingRoutes } from './routes/pending.js';
import { devBlobRoutes } from './routes/devblob.js';
import { debugRoutes } from './routes/debug.js';
import { auditRoutes } from './routes/audit.js';
import { auditChainRoutes } from './routes/audit_chain.js';
import { startScheduler } from './services/scheduler.js';
import { registerIpRateLimitHook, cleanupExpiredEntries } from './services/rateLimiter.js';

// bodyLimit allineato al tetto allegati. DevBlobProvider trasmette hex (2 byte per byte),
// quindi max singolo allegato = 25 MB * 2 = 50 MB wire. 200 MB lascia ampio margine.
const BODY_LIMIT = 200 * 1024 * 1024;
// trustProxy: true per leggere l'IP reale del client da X-Forwarded-For (necessario
// quando il server è dietro un reverse proxy come nginx/caddy).
const app = Fastify({ logger: true, bodyLimit: BODY_LIMIT, trustProxy: true });
await app.register(cors, { origin: true });
registerIpRateLimitHook(app);

// Codici HTTP 4xx: errori di input client — passano al chiamante con error+message.
// Qualsiasi altro status (inclusi i 5xx inattesi): logga lo stack server-side,
// espone solo { error:'internal_error' } senza dettagli.
// FST_ERR_CTP_BODY_TOO_LARGE (413) ha un messaggio leggibile dedicato.
const CLIENT_STATUS = new Set([400, 401, 403, 404, 405, 409, 413, 415, 422, 429]);

app.setErrorHandler((err, req, reply) => {
  const status = (err as any).statusCode ?? 500;
  if (status === 413) {
    return reply.code(413).send({
      error: 'payload_too_large',
      message: `Payload troppo grande. Limite server: ${BODY_LIMIT / 1024 / 1024} MB.`,
    });
  }
  if (CLIENT_STATUS.has(status)) {
    return reply.code(status).send({
      error: (err as any).code ?? 'request_error',
      message: err.message,
    });
  }
  req.log.error(err);
  reply.code(500).send({ error: 'internal_error', message: 'Errore interno del server.' });
});

// Header di sicurezza su ogni risposta. HSTS solo su HTTPS.
app.addHook('onSend', async (req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Content-Security-Policy', "default-src 'self'");
  if (req.protocol === 'https') {
    reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
});

app.get('/health', async () => ({ ok: true, service: 'sentinella', ts: Date.now() }));

await app.register(authRoutes);
await app.register(recoveryRoutes);
await app.register(pairingRoutes);
await app.register(switchRoutes);
await app.register(checkinRoutes);
await app.register(vaultRoutes);
await app.register(approvalRoutes);
await app.register(pushRoutes);
await app.register(pendingRoutes);
await app.register(auditRoutes);
await app.register(auditChainRoutes);
await app.register(devBlobRoutes); // dev only
await app.register(debugRoutes);  // dev only (no-op in production)

// IL BATTITO sta qui, non sul telefono.
startScheduler(app.log);
cleanupExpiredEntries();

const port = Number(process.env.PORT ?? 4000);
app.listen({ port, host: '0.0.0.0' })
  .then(() => app.log.info(`Sentinella server on :${port}`))
  .catch((e) => { app.log.error(e); process.exit(1); });
