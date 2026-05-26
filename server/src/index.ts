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
import { startScheduler } from './services/scheduler.js';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

// Logga sempre lo stack server-side; espone solo un messaggio sicuro al client.
// Le route devono usare reply.code(4xx).send({error,message}) per errori di input,
// non throw — questo handler è per bug inattesi.
app.setErrorHandler((err, _req, reply) => {
  app.log.error(err);
  reply.code(500).send({ error: 'internal_error', message: 'Errore interno del server.' });
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
await app.register(devBlobRoutes); // dev only

// IL BATTITO sta qui, non sul telefono.
startScheduler(app.log);

const port = Number(process.env.PORT ?? 4000);
app.listen({ port, host: '0.0.0.0' })
  .then(() => app.log.info(`Sentinella server on :${port}`))
  .catch((e) => { app.log.error(e); process.exit(1); });
