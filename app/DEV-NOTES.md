# Note di sviluppo — Sentinella

## Cleartext HTTP (Android)

Il cleartext HTTP è permesso SOLO verso `192.168.0.210` (server dev) via
`network-security-config.xml`, collegato alla build tramite il plugin
`plugins/withNetworkSecurityConfig.js`.

**Prima del deploy in produzione con HTTPS:** rimuovere `network-security-config.xml`
e il plugin `"./plugins/withNetworkSecurityConfig"` da `app.json`.

Se l'IP del server di sviluppo cambia, aggiornare sia `app.json`
(`extra.serverUrl`) sia `network-security-config.xml`.

NON usare `usesCleartextTraffic: true` globale — aprirebbe il cleartext verso
qualsiasi host, violando i requisiti di sicurezza del progetto.

## Storage provider (extra.storageProvider)

Regole di selezione (vedi `app/_layout.tsx`):
- `'devblob'` → DevBlobProvider (override esplicito di sviluppo/test).
- `'auto'` o assente → Google Drive se connesso (login google-signin),
  altrimenti nessun provider: l'armo è bloccato con invito a connettere
  Drive (guardia in `compose.tsx`).

Per test locale rapido con DevBlob, rimettere `storageProvider: 'devblob'`;
in produzione lasciare `'auto'`.

## Limiti tempi abbassati per test (compose.tsx)

I minimi di intervallo e grazia in release sono abbassati a 60 s (invece dei
`PROD_LIMITS` di 1 ora) e l'unità «Sec» è visibile anche in release, per
permettere test rapidi del ciclo check-in→grace→approval con la build APK.
Il server dev (`NODE_ENV !== 'production'`) accetta questi valori; un server
in produzione rifiuterebbe sotto 1 ora. **Prima del deploy reale: ripristinare
`PROD_LIMITS` puri e l'unità Sec solo in `__DEV__`** in `app/compose.tsx`.
