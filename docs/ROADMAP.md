# \# Sentinella — Roadmap

# 

# Stato del progetto e prossimi passi. Aggiornare man mano.

# 

# \## Fatto

# 

# \- Funzionalità core completa e testata end-to-end (su dispositivi fisici).

# \- Audit interno completo: critici, alti e medi chiusi o valutati (vedi `docs/FINDINGS\_TRIAGE.md`).

# &#x20; - Critici: C2, C3 risolti; C1 (KDF PIN) rimandato all'audit professionale (serve modulo nativo).

# &#x20; - Alti: A1, A2, A3 risolti e verificati.

# &#x20; - Medi: M1 risolto; M2/M3 chiariti (M3 falso allarme); M4 allineato; M5/M6 valutati e documentati.

# \- Recovery: modello analizzato e documentato; Parte A, quorum dinamico, UX.

# \- Backup su GitHub privato (`NarboStanko/Sentinel`).

# \- Repo ripulito: README reale, riferimenti agli strumenti rimossi, path locali rimossi, dipendenza spuria rimossa.

# \- \*\*Fase 1 completata\*\*: storia Git ripulita (`google-services.json`/chiave rimossi da tutti i commit via filter-repo, force-push, tag preservati); licenza \*\*AGPL-3.0\*\* aggiunta (copyright NarboStanko); ROADMAP nel repo.

# \- Design del sottosistema attuatori documentato (`docs/ACTUATOR\_DESIGN.md`): modello di sicurezza, UX a due livelli, firmware relè, stato di salute, modello di pagamento (licenza firmata bearer, pagamento esterno, durate 1/2/3/5 anni).

# \- README bilingue (EN primario + IT affiancato).

# \- Tutti i documenti tradotti in inglese (primario) con italiano affiancato (`.it.md`), inclusi `THREAT\_MODEL` e `CRYPTO\_INVENTORY`.

# \- Pulizia pre-pubblicazione: `package-lock` senza path locali, `serverUrl` in `app.json` sostituito con placeholder `DEV\_SERVER\_IP` (istruzioni in `app/DEV-NOTES.md`), riferimenti a file inesistenti rimossi.

# \- `SECURITY.md` con policy di disclosure responsabile; Private Vulnerability Reporting abilitato su GitHub.

# \- \*\*REPO RESO PUBBLICO\*\* (2026-09-28). Sentinella è open source (AGPL-3.0).

# \- Dependabot attivo. Vulnerabilità: 111 -> 0 aperte. Override mirati su transitive (61 -> 49 in `npm audit`), poi upgrade Fastify 4 -> 5 (5.12.5, `@fastify/cors` 10.1.0): chiude validation bypass Content-Type/schema, find-my-way HTTP2 DoS, X-Forwarded spoofing. 266 test invariati, nessuna validazione allentata. Alert residui dismissati con motivo (tooling di build non raggiungibile a runtime / fix pianificato con Expo 57).

# 

# \## Prossimo: pubblicazione open source

# 

# \- \[ ] \*\*Traduzione docs in inglese\*\* (Lavoro B). Fatto: README. Restano: THREAT\_MODEL, CRYPTO\_INVENTORY, FINDINGS\_TRIAGE, REVIEWER\_README, poi gli altri. Inglese primario, italiano affiancato. Necessario prima di pubblicare e candidarsi all'audit.

# \- \[ ] \*\*Rendere pubblico il repo\*\* (irreversibile; a mente fresca dopo la traduzione dei doc core). Storia già pulita, licenza presente.

# 

# \## Audit professionale (percorso ATTIVO, non passivo)

# 

# L'audit serio NON capita spontaneamente perché il repo è pubblico. Si OTTIENE candidandosi.

# \- \[ ] \*\*Candidatura\*\* a OTF (Security Lab) e/o NLnet (europeo). Il dossier (`docs/`, `REVIEWER\_README.md`) è già pronto e rende la candidatura forte.

# \- \[ ] La visibilità del progetto (uso, stelle, community) RAFFORZA la candidatura, ma tramite la domanda, non al posto di essa.

# \- \[ ] Se accettato, l'organizzazione finanzia/organizza l'audit con società specializzate (Cure53, Trail of Bits, Radically Open Security...).

# 

# \## Deploy produzione

# 

# \- \[ ] Server con HTTPS (VPS Hetzner + Caddy). Necessario prima dello store.

# \- Costi stimati: \*\*\~70-100 €/anno\*\* per partire (VPS piccolo \~50-60 €/anno + dominio \~10-15 €/anno). HTTPS gratis, push FCM gratis, storage blob sul Drive dell'utente (costo zero). Il costo vero è il tempo di gestione, non le bollette.

# \- \[ ] \*\*PRIMA del deploy\*\*: ripulire `tsc --noEmit` del server. 39 errori pre-esistenti, tutti nei test: 38 in `ratelimit.test.ts` (top-level await senza import, assertion functions senza tipo), 1 errore rootDir perché i test importano `app/lib/canonicalize.ts` da fuori `server/src`. Non legati a Fastify. `npm run build` probabilmente fallisce già per questo.

# \- \[ ] Test E2E sul server Fastify 5 con dispositivi fisici (login, pairing, check-in, un ciclo di rilascio). I test automatici non coprono il dialogo app<->server reale. Ricordare: rimettere l'IP dev in `app.json` in locale SENZA committarlo.

# 

# \## Expo 57 (progetto a sé)

# 

# \- \[ ] Upgrade Expo SDK 51 -> 57. Chiude \~40 alert di tooling (tar critical, xmldom, cacache, postcss, cli-\*) più image-size e turbo-stream (i fix richiedono metro/expo-router nuovi). Richiede aggiornamento di 26+ moduli Expo, nuova build EAS nativa, test su telefoni. Rischio reale attuale BASSO (tooling di build, non raggiungibile a runtime), ma restare su SDK 51 è debito crescente. Da fare a codice stabile (post-audit), possibilmente insieme all'i18n.

# 

# \## App multilingua / i18n (Lavoro A)

# 

# \- \[ ] L'app oggi è \*\*monolingua italiana\*\* (stringhe hardcoded, nessun sistema i18n).

# \- \[ ] Refactoring: installare i18n, estrarre le stringhe in file di traduzione, sostituire con chiavi.

# \- \[ ] Priorità DOPO l'audit (il codice si stabilizza; evita di rifare l'estrazione due volte). Serve per utenti internazionali → verso lo store.

# \- \[ ] Cura speciale su stringhe critiche (duress, avvisi di sicurezza).

# 

# \## Store

# 

# \- \[ ] Account developer (Google $25 una-tantum, Apple $99/anno).

# \- \[ ] Privacy policy + conformità GDPR (UE, dati sensibili).

# \- \[ ] Build di produzione; registrazione SHA + restrizione chiave Firebase.

# 

# \## Sostenibilità

# 

# \- \[ ] Feature premium (attuatori) come servizio, via \*\*licenza firmata bearer\*\*, pagamento esterno all'app (Monero/voucher/mail), durate 1/2/3/5 anni. Vedi `docs/ACTUATOR\_DESIGN.md` §8-9.

# \- \[ ] Donazioni: Open Collective / GitHub Sponsors. Grant: NLnet, Prototype Fund, OTF.

# \- Principio: core sempre gratis/self-hostable; il pagamento non è mai single-point-of-failure (switch armato resta protetto a licenza scaduta).

# \- Costi vivi bassi (\~100 €/anno) → nessuna pressione a monetizzare aggressivamente.

# 

# \## Attuatori (dopo l'audit)

# 

# \- \[ ] Implementare come da `docs/ACTUATOR\_DESIGN.md`, a fasi. Rivedere il design con l'auditor prima (specie il modello di sicurezza del blob di attivazione).

# \- \[ ] Punti aperti: gateway IP↔Meshtastic, modello multi-relè, stato di salute, schema dati server, revoca licenza.

# 

# \## Trovamenti tecnici aperti (non urgenti)

# 

# \- \[ ] C1 — KDF dei PIN con Argon2id (modulo nativo). Con l'audit. Vedi `docs/C1\_ESITO.md`.

# \- \[ ] Note produzione: cache-facciata token al bootstrap (cosmetico); migrazione `shares.x` nullable.

# 

# \## Housekeeping

# 

# \- \[ ] Override `fast-uri@^2` nel `package.json` radice ormai inerte (Fastify 5 usa fast-uri 4.x): rimuovere quando capita.

# \- \[ ] Valutare: leggere `serverUrl` da `.env` gitignorato invece di editare `app.json` a mano ad ogni sessione dev.

# \- \[ ] Eliminare i backup locali con la vecchia storia (`sentinella-BACKUP-prima-di-filter-repo.git`, `sentinella-git-backup.zip`) quando si è sicuri che tutto funziona.

# 

# \## Ordine consigliato

# 

# Traduci docs core (EN) → repo pubblico → candidatura audit → deploy HTTPS → (audit) → i18n app + store + attuatori + sostenibilità.se 2). Poi deploy (3), store (4), sostenibilità (5) in parallelo dove possibile.

# \- \[ ] \*\*Candidatura all'audit professionale\*\* (OTF Security Lab / NLnet). Il repo è ora pubblico, in inglese, con `SECURITY.md`, Dependabot pulito e dossier `docs/` completo. Tutte le precondizioni sono soddisfatte.

