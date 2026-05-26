// Verifica: errori di input client → 4xx, errori inattesi → 500 senza stack.
// I test 1–2 FALLISCONO prima del fix (pairing.ts usa throw → Fastify restituisce 500).
// Il test 3 verifica il global error handler aggiunto in index.ts (task #15).
export {}; // marca il file come modulo ES per tsc (evita conflitti di scope)

// DEVE stare prima di qualunque import dinamico: db.ts legge DB_PATH al primo import.
process.env['DB_PATH'] = ':memory:';

const { default: Fastify } = await import('fastify');
const { pairingRoutes } = await import('./pairing.js');

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => {
  if (c) { pass++; console.log('  ✓', m); }
  else   { fail++; console.log('  ✗ FAIL:', m); }
};

async function buildApp() {
  const app = Fastify({ logger: false });

  // Global error handler: logga lo stack, espone solo un messaggio sicuro.
  // Questo è lo stesso handler che verrà aggiunto in index.ts (task #15).
  app.setErrorHandler((err, _req, reply) => {
    app.log.error(err);
    reply.code(500).send({ error: 'internal_error', message: 'Errore interno del server.' });
  });

  await app.register(pairingRoutes);

  // Rotta solo per test: simula un bug inatteso nel codice server.
  app.get('/test-unexpected-error', async () => {
    throw new Error('crash_segreto: dati_sensibili_qui');
  });

  return app;
}

const app = await buildApp();

// ── 1) /pair con token inesistente → 404 ──────────────────────────────────
console.log('1) /pair — token inesistente → 404');
{
  const res = await app.inject({
    method: 'POST',
    url: '/pair',
    payload: { token: 'TOKEN_CHE_NON_ESISTE', contactPublicKey: '04abcd1234' },
  });
  const body = JSON.parse(res.payload) as Record<string, unknown>;
  ok(res.statusCode === 404, `status 404 (ricevuto: ${res.statusCode})`);
  ok(typeof body['error'] === 'string', `body.error presente (${JSON.stringify(body)})`);
  ok(body['error'] !== 'Internal Server Error', 'body.error non è "Internal Server Error"');
  ok(!res.payload.includes('stack'), 'nessuno stack trace nel payload');
  ok(!res.payload.includes('crash'), 'nessun leak di messaggi interni');
}

// ── 2) /pair con token già usato → 404 al secondo tentativo ───────────────
console.log('2) /pair — token già usato → 404');
{
  const ownerRes = await app.inject({
    method: 'POST',
    url: '/owner/register',
    payload: { publicKey: '04testowner0001', displayName: 'TestOwner' },
  });
  const { ownerId } = JSON.parse(ownerRes.payload) as { ownerId: string };

  const inviteRes = await app.inject({
    method: 'POST',
    url: '/invite',
    payload: { ownerId },
  });
  const { token } = JSON.parse(inviteRes.payload) as { token: string };

  // Primo uso: deve riuscire (200)
  const first = await app.inject({
    method: 'POST',
    url: '/pair',
    payload: { token, contactPublicKey: '04contact_key_01' },
  });
  ok(first.statusCode === 200, `primo /pair: 200 (ricevuto: ${first.statusCode})`);

  // Secondo uso: token consumato → 404
  const second = await app.inject({
    method: 'POST',
    url: '/pair',
    payload: { token, contactPublicKey: '04contact_key_02' },
  });
  const body = JSON.parse(second.payload) as Record<string, unknown>;
  ok(second.statusCode === 404, `secondo /pair: 404 (ricevuto: ${second.statusCode})`);
  ok(typeof body['error'] === 'string', `body.error presente (${JSON.stringify(body)})`);
  ok(!second.payload.includes('stack'), 'nessuno stack trace nel payload');
}

// ── 3) Errore inatteso nel server → 500 senza leak ────────────────────────
console.log('3) Errore inatteso → 500 senza leak');
{
  const res = await app.inject({ method: 'GET', url: '/test-unexpected-error' });
  const body = JSON.parse(res.payload) as Record<string, unknown>;
  ok(res.statusCode === 500, `status 500 (ricevuto: ${res.statusCode})`);
  ok(body['error'] === 'internal_error', `body.error === "internal_error" (ricevuto: ${JSON.stringify(body)})`);
  ok(!res.payload.includes('crash_segreto'), 'messaggio interno non esposto');
  ok(!res.payload.includes('dati_sensibili'), 'dati sensibili non esposti');
  ok(!res.payload.includes('stack'), 'nessuno stack trace');
}

console.log(`\nRisultato: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
