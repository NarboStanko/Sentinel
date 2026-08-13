# Sentinella — Roadmap

Stato del progetto e prossimi passi. Aggiornare man mano.

## Fatto

- Funzionalità core completa e testata end-to-end (su dispositivi fisici).
- Audit interno completo: critici, alti e medi chiusi o valutati (vedi `docs/FINDINGS_TRIAGE.md`).
  - Critici: C2, C3 risolti; C1 (KDF PIN) rimandato all'audit professionale (serve modulo nativo).
  - Alti: A1, A2, A3 risolti e verificati.
  - Medi: M1 risolto; M2/M3 chiariti (M3 falso allarme); M4 allineato; M5/M6 valutati e documentati come scelte/trade-off.
- Recovery: modello analizzato e documentato (`docs/RECOVERY_MODEL.md`); Parte A (initiate), quorum dinamico, UX. La "Parte C" si è rivelata non necessaria.
- Backup su GitHub privato (`NarboStanko/Sentinel`).
- Repo ripulito: README allo stato reale, riferimenti agli strumenti rimossi, path locali rimossi, dipendenza spuria in package.json rimossa.
- Fase 1 avviata: storia Git controllata; `google-services.json` (chiave Firebase client) tolto dal tracking e messo in gitignore.

## Fase 1 — Rendere il codice pubblicabile (IN CORSO)

- [ ] **Licenza**: scegliere e aggiungere il file. Orientamento: AGPL-3.0 sul core (copyleft forte; copyright detenuto dall'autore → compatibile con feature premium separate / servizio gestito).
- [ ] **Riscrittura storia Git**: rimuovere `google-services.json` dai commit passati (`git filter-repo`). IRREVERSIBILE: fare backup del repo prima, poi force-push. Da fare solo quando si è pronti a pubblicare.
- [x] Livello C (chiave Firebase): verificato rischio basso (solo FCM gratuito). Restrizione SHA rimandata alla build di produzione.

## Fase 2 — Audit professionale

- [ ] Candidare a OTF Security Lab / NLnet / Reset.tech. Dossier già pronto (`docs/`). Idealmente PRIMA dello store. Passo esterno a più alto valore.

## Fase 3 — Deploy produzione

- [ ] Server con HTTPS (VPS Hetzner + Caddy). Necessario prima dello store (l'app non può puntare al PC in LAN).

## Fase 4 — Store

- [ ] Account developer (Google $25 una-tantum, Apple $99/anno).
- [ ] Privacy policy + conformità GDPR (UE, dati sensibili di persone a rischio).
- [ ] Build di produzione; registrazione SHA + restrizione chiave Firebase.

## Fase 5 — Sostenibilità

- [ ] Donazioni: Open Collective / GitHub Sponsors.
- [ ] Grant: NLnet (europeo), Prototype Fund, OTF. Alcuni richiedibili prima, per finanziare il completamento.

## Trovamenti tecnici aperti (non urgenti)

- [ ] C1 — KDF dei PIN con Argon2id (modulo nativo). Decisione informata da prendere con l'audit. Vedi `docs/C1_ESITO.md`.
- [ ] Nota produzione: cache-facciata token al bootstrap (cosmetico).
- [ ] Nota produzione: migrazione `shares.x` nullable.

## Ordine consigliato

Completare Fase 1 (licenza + storia pulita) → rendere pubblico il repo → candidarsi all'audit (Fase 2). Poi deploy (3), store (4), sostenibilità (5) in parallelo dove possibile.
