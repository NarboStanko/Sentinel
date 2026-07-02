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

`storageProvider: 'devblob'` in `extra` (app.json) è per i test: attiva
`DevBlobProvider` anche nelle build release. In produzione rimuoverlo o
impostare `'none'` e attivare GoogleDrive via OAuth.

Se la chiave è assente, il default è `'devblob'` in `__DEV__` e `'none'` altrove
(vedi `app/_layout.tsx`).

## Limiti tempi abbassati per test (compose.tsx)

I minimi di intervallo e grazia in release sono abbassati a 60 s (invece dei
`PROD_LIMITS` di 1 ora) e l'unità «Sec» è visibile anche in release, per
permettere test rapidi del ciclo check-in→grace→approval con la build APK.
Il server dev (`NODE_ENV !== 'production'`) accetta questi valori; un server
in produzione rifiuterebbe sotto 1 ora. **Prima del deploy reale: ripristinare
`PROD_LIMITS` puri e l'unità Sec solo in `__DEV__`** in `app/compose.tsx`.
