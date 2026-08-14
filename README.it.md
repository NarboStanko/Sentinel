# Sentinella
> [🇬🇧 English](README.md) · 🇮🇹 Italiano

Un *dead man's switch* civico, cifrato end-to-end. A intervalli regolari la Sentinella chiede «tutto ok?». Se l'utente smette di rispondere (arresto, sparizione, incapacità), parte una richiesta di rilascio verso i suoi contatti fidati: quando almeno **k** di loro approvano, la documentazione preparata a freddo viene decifrata e consegnata.

Pensato per giornalisti, attivisti e chiunque debba garantire che informazioni sensibili emergano se gli accade qualcosa — senza affidare quelle informazioni a nessun intermediario in chiaro.

---

## ⚠️ Stato del progetto — leggere prima di usare

**Sentinella NON è ancora stato sottoposto a un audit di sicurezza indipendente e NON deve essere usato per proteggere persone in situazioni di rischio reale finché non lo sarà.**

Il sistema è funzionante end-to-end ed è stato sottoposto a un audit interno approfondito (vedi `docs/`), ma un audit interno non sostituisce la revisione di esperti esterni. Finché non c'è quella revisione e un deploy di produzione con HTTPS, considerare questo software un **prototipo avanzato**, non uno strumento di protezione affidabile.

Stato sintetico:
- Funzionalità core: **completa e testata end-to-end** (su dispositivi fisici).
- Audit interno: **critici e alti risolti**, medi risolti o chiariti (vedi `docs/FINDINGS_TRIAGE.md`).
- Audit professionale esterno: **non ancora fatto** (previsto).
- Deploy di produzione (HTTPS/VPS): **non ancora fatto** (oggi gira su HTTP in LAN per sviluppo).

---

## Modello di sicurezza (in breve)

- **End-to-end**: il contenuto è cifrato sul dispositivo dell'utente. Il server custodisce solo blob opachi e non può leggerli.
- **Il server non conosce la soglia `k`**: la soglia di quorum per il rilascio è privata al client. Il server raccoglie quote opache (reali + esche indistinguibili) e non sa quante ne servano.
- **Segretezza condivisa (Shamir)**: la chiave di decifratura è divisa in quote distribuite ai contatti; servono almeno `k` quote per ricostruirla.
- **Verifica di persona (safety number)**: il pairing tra utente e contatto è confermato di persona (parole BIP39), a difesa da attacchi man-in-the-middle. La verifica è locale al dispositivo e non si trasferisce a un dispositivo nuovo (proprietà voluta).
- **Duress PIN**: un PIN di emergenza attiva una facciata o un trigger silenzioso, indistinguibile dall'esterno.
- **Recupero dell'identità**: restore da seed phrase (se conservata) oppure social recovery (rotazione della chiave sotto quorum di contatti + ritardo obbligatorio + possibilità di annullamento).

Dettagli completi nei documenti di `docs/` (vedi sotto).

---

## Architettura

- **App** (`app/`): React Native / Expo. Crittografia con `@noble` (curves, ciphers, hashes), storage sicuro via SecureStore/Keystore.
- **Server** (`server/`): Node.js / Fastify + SQLite. Autenticazione passwordless a firma per-richiesta (challenge-response P-256). Custodisce blob opachi e coordina il flusso, senza accesso ai contenuti né alla soglia.

Flusso: check-in → (mancata risposta) → grace → APPROVAL_PENDING → raccolta quote dai contatti → RELEASED → i contatti che hanno contribuito decifrano e conservano il contenuto.

---

## Documentazione (`docs/`)

- `THREAT_MODEL.md` — attori, minacce coperte e non coperte, scelte di design.
- `DESIGN_DECISIONS.md` — decisioni architetturali con motivazioni.
- `CRYPTO_INVENTORY.md` — primitive crittografiche in uso.
- `FINDINGS_TRIAGE.md` — trovamenti dell'audit interno e stato.
- `RECOVERY_MODEL.md` — modello di recupero dell'identità (restore vs social recovery), analisi e decisioni.
- `C1_ESITO.md` / `PIANO_C1.md` — indagine sulla KDF dei PIN (richiede modulo nativo; rimandato all'audit).
- `AUDIT_PROMPTS.md` — prompt avversariali per la revisione.
- `REVIEWER_README.md` — guida per il revisore esterno.

---

## Sviluppo

**Server:**
```
cd server
npm install
npm run dev        # avvia su :4000
```
Test (suite separate): `npm run test:auth`, `test:switch`, `test:scheduler`, `test:duress`, `test:ratelimit`, `test:routes`, `test:contacts`, `test:audit_chain`, `test:push`, ecc.

**App:**
```
cd app
npm install
npx expo start --dev-client
```

I segreti (chiavi, `.env`, DB) sono esclusi dal versionamento (vedi `.gitignore`). Il DB viene creato al primo avvio del server.

---

## Cosa resta

- Audit di sicurezza professionale indipendente (candidatura prevista, es. OTF Security Lab).
- KDF dei PIN con modulo nativo (Argon2id) — vedi `docs/C1_ESITO.md`.
- Deploy di produzione con HTTPS.
- Trovamenti minori aperti per l'audit: naming audit log (M4), P-256 nella console web (M5), forward secrecy dei blob su Drive (M6).
- Sottosistema attuatori (fase successiva, dopo l'audit).

---

## Licenza

Sentinella è rilasciata sotto GNU Affero General Public License v3.0 (AGPL-3.0). Vedi il file LICENSE.

Il copyright è detenuto dall'autore (NarboStanko). Questo consente, in futuro, versioni con feature aggiuntive o servizi gestiti a supporto della sostenibilità del progetto, mantenendo il core libero e verificabile.
