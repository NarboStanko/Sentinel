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
