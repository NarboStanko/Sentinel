# Sentinella — Guida per il revisore esterno

> Documento di orientamento per un auditor di sicurezza che riceve questo repository
> senza conoscere il progetto. Redatto il 2026-07-21 leggendo il codice e i file di
> configurazione reali; i comandi riportati sono stati eseguiti e verificati.

---

## 1. Cos'è il sistema

Sentinella è un *dead man's switch* civico end-to-end encrypted. L'**owner** prepara un
pacchetto di contenuti, lo cifra sul proprio dispositivo e lo "arma" con un intervallo di
check-in. Un server (il **postino**) manda periodicamente una push «tutto ok?»; se l'owner
smette di rispondere (arresto, sparizione), il server chiede ai **contatti fidati** —
accoppiati di persona via QR — di approvare il rilascio. La chiave del pacchetto (DEK) è
spezzata con Shamir k-su-N: solo quando almeno k contatti reinviano la propria quota il
client riesce a ricombinare la chiave e conferma il rilascio. La garanzia principale:
**il server non conosce mai contenuti, chiavi, DEK né la soglia k** — conserva solo chiavi
pubbliche, blob opachi (quote reali mescolate a esche), puntatori allo storage esterno e
stato dello switch. Contromisure per la coercizione: PIN duress (facciata di dati spuri o
trigger silenzioso del rilascio) e catena audit hash-linked per rilevare manomissioni.
Attori, avversari e garanzie formali: vedi `docs/THREAT_MODEL.md`.

---

## 2. Struttura del repository

Il repo è un monorepo npm workspaces (`package.json` di radice, **lockfile unico**
`package-lock.json` alla radice — non esistono lockfile separati per `app/` e `server/`).

| Percorso | Contenuto |
|---|---|
| `server/` | Backend Node + TypeScript + Fastify + SQLite (`better-sqlite3`). Coordina switch, push, quote, recovery. |
| `app/` | App mobile Expo (React Native, SDK 51, `expo-router`). Tutta la crittografia dei contenuti sta qui. |
| `web/` | `recovery-console.html` — console di recupero via browser (deriva la chiave dalla seed, firma le richieste). |
| `docs/` | Documentazione per l'audit (vedi §8). |
| `app/plugins/` | Config plugin Expo (`withNetworkSecurityConfig.js`, vedi §7). |

### File con la logica di sicurezza, in ordine di rilevanza

**Lato app (dove vive la crittografia):**

1. `app/lib/crypto.ts` — nucleo crittografico: derivazione identità da seed BIP39,
   ECDH seal/open (XChaCha20-Poly1305), cifratura contenuti, Shamir split/combine,
   quote sigillate + esche (`makeDecoy`), trial decryption (`tryOpenShare`, `findMyShare`).
2. `app/lib/canonicalize.ts` — canonicalizzazione delle richieste firmate; deve restare
   bit-identica alla controparte server (invariante critico, vedi §6).
3. `app/lib/keystore.ts` — custodia della seed in `expo-secure-store`
   (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`).
4. `app/lib/pinHash.ts`, `app/lib/pinPolicy.ts`, `app/lib/lockout.ts`,
   `app/lib/lockState.ts`, `app/lib/facadeStore.ts` — PIN normale e duress, lockout
   esponenziale, stato di sblocco, modalità facciata.
5. `app/lib/auditChain.ts` — verifica client della catena audit.
6. `app/lib/storage.ts`, `app/lib/storage/googleDrive.ts`, `app/lib/storage/devBlob.ts`,
   `app/lib/driveAuth.ts`, `app/lib/attachments.ts` — astrazione storage (i blob arrivano
   ai provider **già cifrati**), OAuth Drive, cifratura allegati.
7. `app/lib/api.ts` — client HTTP con firma delle richieste.

**Lato server (dove vivono le decisioni di stato):**

1. `server/src/middleware/auth.ts` — autenticazione a firma P-256 per richiesta:
   canonicalizzazione, verifica firma, anti-replay (cache nonce, TTL 6 min), risoluzione
   attore (`owner` / `contact` / `*-of-switch`).
2. `server/src/routes/approvals.ts` — cuore del rilascio: `/approval/request`, `/shares`
   (blob opachi reali+esche), `/approval/submit`, `/release/confirm`. Qui si vede che k
   resta lato client.
3. `server/src/services/auditChain.ts` + `server/src/routes/audit_chain.ts` — catena audit
   hash-linked (SHA-256, hash precedente concatenato) e verifica/ancoraggio.
4. `server/src/services/scheduler.ts` — il "battito": `tick()` porta gli switch
   ACTIVE → GRACE → APPROVAL_PENDING e invia le push.
5. `server/src/routes/duress.ts` — `/duress/trigger`: porta gli switch in
   APPROVAL_PENDING (mai in RELEASED), rate-limit 3/giorno per owner.
6. `server/src/routes/recovery.ts` — recovery sociale (rotazione identità sotto quorum +
   ritardo; mai disarmo né rilascio).
7. `server/src/routes/auth.ts` — `/auth/challenge` + `/auth/verify` (usati dalla console web).
8. `server/src/services/rateLimiter.ts` — rate-limit per identità crittografica (+ IP come
   secondo livello), lockout per pattern sospetti sulle submit.
9. `server/src/lib/canonical.ts` — controparte server della canonicalizzazione.
10. `server/src/middleware/validate.ts` — validazione schema dei body.
11. `server/src/db.ts` — schema SQLite: cosa il server conserva (e cosa no).
12. `server/src/routes/switch.ts`, `checkin.ts`, `pairing.ts`, `vault.ts`, `push.ts` —
    ciclo di vita, check-in, pairing, puntatori ai contenuti, push token.
13. `server/src/routes/devblob.ts`, `server/src/routes/debug.ts` — **solo sviluppo**
    (guard `NODE_ENV !== 'production'`): storage placeholder e rotte di test.

---

## 3. Far girare il server

**Prerequisiti:** Node.js (testato con **v22.22.3** su Windows 11; nessuna dipendenza da
OS specifico — `better-sqlite3` compila un modulo nativo, serve una toolchain funzionante
o il prebuilt). Nessun database esterno: SQLite è embedded.

```bash
# dalla radice del repo (workspaces: installa server e app insieme)
npm install --legacy-peer-deps

cd server
npm run dev        # tsx watch src/index.ts — sviluppo con reload
# oppure:
npm run build && npm start   # tsc → node dist/index.js
```

- **Porta:** `4000` di default, override con la variabile `PORT`. Ascolta su `0.0.0.0`.
- **Database:** creato/inizializzato automaticamente all'avvio (`CREATE TABLE IF NOT
  EXISTS` in `src/db.ts`). Percorso: variabile `DB_PATH`, default `sentinella.db` nella
  directory corrente. I test usano `:memory:`.
- **Log all'avvio:** logger Fastify in JSON su stdout; l'ultima riga utile è
  `Sentinella server on :4000`. Da quel momento lo scheduler gira con un tick ogni 2 s.
- **Verifica rapida:** `GET http://localhost:4000/health` →
  `{ ok: true, service: 'sentinella', ts: ... }`.

Note: `trustProxy: true` è attivo (l'IP client viene letto da `X-Forwarded-For` — rilevante
per il rate-limit per IP se il server non è dietro un reverse proxy fidato). Header di
sicurezza impostati su ogni risposta; HSTS solo su HTTPS.

---

## 4. Lanciare i test

Non esiste uno script aggregato: ogni suite ha il suo `npm run`. Tutte girano in Node puro
via `tsx`, senza emulatore né dispositivo; le suite server usano SQLite in-memory.
Tempo indicativo: pochi secondi a suite, **~1–2 minuti per l'intero set**.

**Server** (da `server/`) — 11 suite, **262 test, tutti verificati passanti** il 2026-07-21:

| Comando | Test | Copre |
|---|---|---|
| `npm run test:auth` | 31 | Firma su rotte protette: 401 senza firma, ts scaduto, manomissione, replay, ruoli; equivalenza canonicalizzazione client/server |
| `npm run test:scheduler` | 33 | ACTIVE→GRACE→APPROVAL_PENDING, idempotenza, push selettive |
| `npm run test:switch` | 69 | Validazione limiti dev/prod, persistenza, contenuti multipli |
| `npm run test:contacts` | 33 | Lista contatti, offuscamento (preview troncata dei push token) |
| `npm run test:push` | 20 | pushSender: payload senza segreti, chiamata a Expo Push API |
| `npm run test:debug` | 22 | Rotte debug: seed-contacts, expire forzato, guard di stato |
| `npm run test:errorhandler` | 15 | 4xx al client, 500 senza leak di stack, guard NODE_ENV su rotte dev |
| `npm run test:routes` | 14 | Pairing: errori client 4xx, nessun dato sensibile negli errori |
| `npm run test:audit_chain` | 11 | Catena hash: append, verifica, rilevamento manomissioni, ancoraggio |
| `npm run test:ratelimit` | 8 | Limiti per identità, isolamento tra contatti, lockout |
| `npm run test:duress` | 6 | Trigger duress: transizioni, rate-limit 3/giorno |

**App** (da `app/`) — 3 suite di logica pura (nessuna UI):

| Comando | Test | Copre |
|---|---|---|
| `npm run test:crypto` | 37 asserzioni | Vettori fissi, proprietà soglia (<k fallisce, ≥k riesce), lunghezze multiple, pool misto quote+esche |
| `npm run test:storage` | 17 | Astrazione StorageProvider: i byte salvati sono il ciphertext, mai chiavi |
| `npm run test:attachments` | 19 | Cifratura allegati, limiti dimensione |

Le schermate React Native e i flussi che richiedono dispositivi fisici (scan QR, push
reali) **non hanno test automatici** — vedi §7.

---

## 5. Costruire e far girare l'app

**Prerequisiti:** account Expo (owner `narbo` in `app.json`), CLI EAS `>= 19.0.8`
(`eas.json`), e per le build cloud un login `eas login`. L'app usa `expo-dev-client`,
quindi **non gira in Expo Go**: serve una development build.

Profili in `app/eas.json`:

| Profilo | Uso |
|---|---|
| `development` | Development client, distribuzione interna — è il profilo per il lavoro quotidiano e il collaudo |
| `preview` | Distribuzione interna, Android come APK installabile direttamente |
| `production` | Build store, `autoIncrement` della versione |

```bash
cd app
npx expo start                                   # dev server (richiede dev build già installata)
eas build --profile development --platform android   # build del dev client
```

Configurazione necessaria in `app/app.json` → `expo.extra`:

- `serverUrl` — URL del backend raggiungibile **dal dispositivo** (attualmente
  `http://192.168.0.210:4000`, un IP di sviluppo: va adattato alla propria rete).
- `storageProvider` — `"auto"`: Drive in release, DevBlob in sviluppo.
- `googleDriveClientIdAndroid` / `googleDriveClientIdWeb` — client OAuth per Google Drive.
- `eas.projectId` — id progetto EAS (da sostituire se si builda su un altro account).

Inoltre: `app/google-services.json` (progetto Firebase per le push FCM) e
`app/network-security-config.xml`, iniettato dal plugin `app/plugins/withNetworkSecurityConfig.js`,
che **permette HTTP in chiaro solo verso l'IP di sviluppo** (vedi §7). Se si cambia
`serverUrl`, va aggiornato anche quel file, e serve un nuovo prebuild/build.

---

## 6. Percorsi critici da esaminare

### Autenticazione delle richieste (firma per richiesta, niente sessioni)
Client: `app/lib/canonicalize.ts` (`canonicalize()`) + `app/lib/api.ts` (costruzione e
firma della richiesta). Server: `server/src/middleware/auth.ts` — `canonicalize()`,
`verifySig()` (ECDSA P-256 su SHA-256), `checkAndRegisterNonce()` (anti-replay, chiave
`pub:ts:sig`, TTL 6 min, **cache in memoria**), `lookupActor()` / `requireAuth()`
(autorizzazione per ruolo e per appartenenza allo switch). Le due canonicalizzazioni
devono restare bit-identiche: `server/src/routes/auth.test.ts` verifica l'equivalenza.
`server/src/lib/canonical.ts` (`sortDeep`, `canonicalJson`) è condiviso con la catena audit.
La console web usa invece `/auth/challenge` + `/auth/verify` (`server/src/routes/auth.ts`).

### Catena audit
`server/src/services/auditChain.ts` — `computeEventHash()` (SHA-256 dei campi concatenati
con `|`, incluso `prev_hash`; genesi = 64 zeri), `appendToChain()`. Esposizione e verifica:
`server/src/routes/audit_chain.ts` (incluso l'ancoraggio: eventi aggiunti dopo un anchor
vengono rilevati). Verifica lato client: `app/lib/auditChain.ts`, schermata
`app/app/audit-tools.tsx`. Gli eventi vengono scritti dallo scheduler, dalle approvals e
dal duress; notare i `try/catch` intorno a `appendToChain` (un fallimento di scrittura
non blocca la transizione di stato — valutarne le conseguenze).

### Ciclo di vita dello switch
Stati in `server/src/db.ts` (`DISARMED|ACTIVE|GRACE|APPROVAL_PENDING|RELEASED`).
Creazione/armamento: `server/src/routes/switch.ts` (validazione limiti in
`server/src/config/limits.ts`). Check-in con jitter: `server/src/routes/checkin.ts`.
Transizioni temporali: `server/src/services/scheduler.ts` → `tick()` (esportata per i
test; `startScheduler()` la invoca ogni 2 s). Le push partono una sola volta per
transizione, non a ogni tick.

### Soglia Shamir e rilascio
Split e sigillo: `app/lib/crypto.ts` — `splitSecret()` / `combineSecret()` (Shamir),
`sealShare()` (quota cifrata per la pubkey del contatto), `makeDecoy()` (esche),
`tryOpenShare()` / `findMyShare()` (trial decryption: il contatto scarica *tutti* i blob
da `/shares` e scopre il proprio provando a decifrare). Lato server:
`server/src/routes/approvals.ts` — `/approval/submit` raccoglie le quote decifrate
(firmate, rate-limitate per contact_id, duplicate → 409) e restituisce tutte quelle
raccolte; è **il client** in `app/app/approve.tsx` che tenta la ricombinazione e, se la
DEK decifra il contenuto, chiama `/release/confirm`. I puntatori ai contenuti sono
esposti solo in stato RELEASED.

### PIN duress e lock screen
Setup: `app/app/duress-setup.tsx`; verifica PIN: `app/app/lock.tsx` con
`app/lib/pinHash.ts` (⚠ oggi SHA-256 singola salata — finding C1 in
`docs/FINDINGS_TRIAGE.md`), policy in `app/lib/pinPolicy.ts`, lockout esponenziale
(30 s → 4 h) in `app/lib/lockout.ts`, stato di sblocco in-memory in `app/lib/lockState.ts`
(riparte sempre bloccata, timeout 3 min in background, deep-link differiti).
Modalità A (facciata): `app/lib/facadeStore.ts` — dati fittizi, nessuna chiamata al server
reale. Modalità B (trigger silenzioso): `server/src/routes/duress.ts` — porta gli switch in
APPROVAL_PENDING saltando la grazia; **mai** direttamente in RELEASED.

### Storage e cifratura dei contenuti
Cifratura: `app/lib/crypto.ts` (`encryptContent`/`decryptContent`, XChaCha20-Poly1305;
DEK per switch, persistita solo sul client). Allegati: `app/lib/attachments.ts`.
Astrazione provider: `app/lib/storage.ts` (interfaccia `StorageProvider`; guardia
`isStorageReady()` pre-armo) con implementazioni `app/lib/storage/googleDrive.ts`
(+ OAuth in `app/lib/driveAuth.ts`) e `app/lib/storage/devBlob.ts` (sviluppo, appoggiata
a `server/src/routes/devblob.ts`). Il server riceve **solo il puntatore**:
`server/src/routes/vault.ts` e tabella `switch_contents` in `db.ts` (puntatore + IV +
label non sensibile, mai ciphertext).

---

## 7. Stato e limiti

**Testato automaticamente:** tutta la logica elencata in §4 — crypto pura, transizioni di
stato, autenticazione a firma, catena audit, rate-limit, duress lato server, storage e
allegati come moduli puri.

**Non testato automaticamente:** le schermate React Native, il pairing con scan QR reale
(serve la fotocamera di 2 dispositivi fisici — in `add-friend.tsx` c'è ancora il pulsante
"(demo) simula scan"), il ciclo push end-to-end su dispositivo, il flusso OAuth Google
Drive reale, la console web (verificata manualmente).

**Configurato per sviluppo, NON per produzione:**

- `app.json` → `extra.serverUrl = http://192.168.0.210:4000`: **HTTP in chiaro verso un
  IP locale**. In produzione serve HTTPS e la rimozione dell'eccezione cleartext.
- `app/network-security-config.xml`: permette cleartext verso `192.168.0.210` (Android).
  Da rimuovere/svuotare in produzione.
- `server/src/routes/devblob.ts` (`/dev/blob`) e `server/src/routes/debug.ts`
  (`/debug/*`): attive quando `NODE_ENV !== 'production'`. Verificare che il deploy
  imposti davvero `NODE_ENV=production`.
- Contatti di test `[DEV] Genera 2 contatti test` in compose: solo `__DEV__`.
- La cache anti-replay e parte del rate-limiting sono **in memoria**: si azzerano al
  riavvio del server e non sono condivise tra più istanze.
- Anomalia nota in `app/package.json`: una dependency spuria con chiave `"undefined"` che
  punta al percorso locale del repo (artefatto di un comando npm; da rimuovere).

**Trovamenti già noti e triagiati** (non riscoprirli da zero): `docs/FINDINGS_TRIAGE.md` —
in particolare i critici C1 (PIN con SHA-256 singola), C2 (esche distinguibili dagli
indici), C3 (il server apprende k via `recoveryK`, in tensione con l'invariante dichiarata).

**Prima dell'uso reale** il progetto stesso dichiara necessari: audit indipendente, threat
model formale completo e revisione legale (vedi `README.md` di radice e `CLAUDE.md`).

---

## 8. Gli altri documenti in `docs/`

| Documento | Contenuto |
|---|---|
| `THREAT_MODEL.md` | Modello di minaccia: attori, avversari (incluso il coercitore), garanzie promesse e loro confini. **Da leggere per primo.** |
| `CRYPTO_INVENTORY.md` | Inventario crittografico redatto dal codice reale (librerie e versioni dal lockfile, primitive, dove commento e codice divergono). |
| `FINDINGS_TRIAGE.md` | Trovamenti già noti con triage: stato (reale/falso allarme), gravità, note per il fix. |
| `DESIGN_DECISIONS.md` | Motivazioni delle scelte deliberate che senza contesto sembrerebbero errori (firma per richiesta vs sessioni, rate-limit per identità, rotte anonime del recovery, …). |
| `AUDIT_PROMPTS.md` | Prompt pronti per audit assistito da modelli linguistici, con metodologia (sessioni separate; consegnare `DESIGN_DECISIONS.md` solo in seconda fase). |

> Nota metodologica da `AUDIT_PROMPTS.md`, valida anche per revisori umani: leggere
> `DESIGN_DECISIONS.md` *dopo* essersi formati un giudizio indipendente riduce il rischio
> di accettare i razionali invece di metterli alla prova.
