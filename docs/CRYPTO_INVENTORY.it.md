# Inventario crittografico — Sentinella

> [🇬🇧 English](CRYPTO_INVENTORY.md) · 🇮🇹 Italiano

> Documento preparatorio per audit di sicurezza indipendente.
> Redatto **leggendo il codice reale** (2026-07-20), non i commenti né la documentazione.
> Dove commento e codice divergono, è riportato il **codice** e la divergenza è segnalata
> esplicitamente (vedi §10).
>
> Percorsi relativi alla radice del repo (`sentinella/sentinella`).
> Nessun file di codice è stato modificato per produrre questo documento.

---

## 1. Librerie crittografiche e versioni

Le versioni "dichiarate" vengono da `app/package.json` e `server/package.json`; le versioni
"installate" dal **lockfile unico alla radice** (`package-lock.json` — non esistono lockfile
separati per `app/` e `server/`).

| Libreria | Dichiarata (app) | Dichiarata (server) | Installata (lockfile) | Uso |
|---|---|---|---|---|
| `@noble/curves` | `^1.6.0` | `^1.6.0` | **1.9.7** | P-256: ECDSA, ECDH, generazione chiavi |
| `@noble/ciphers` | `^1.0.0` | — | **1.3.0** | XChaCha20-Poly1305 |
| `@noble/hashes` | `^1.5.0` | `^1.5.0` | **1.8.0** | SHA-256, HKDF, `randomBytes` |
| `@scure/bip39` | `^1.4.0` | — | **1.6.0** | Seed phrase (mnemonic → seed) |
| `nanoid` | — | `^5.0.7` | **5.1.11** | ID e token server-side (CSPRNG) |
| `react-native-get-random-values` | `~1.11.0` | — | 1.11.x | Polyfill `crypto.getRandomValues` in RN |
| `expo-secure-store` | `~13.0.0` | — | 13.0.x | Custodia seed/DEK/PIN su device |
| `node:crypto` (built-in) | — | built-in | — | `createHash('sha256')` lato server |
| Web Crypto API (browser) | — | — | — | PBKDF2/SHA/ECDSA nella console web |

Note:
- `expo-crypto` (`~13.0.2`) è **dichiarata ma mai importata** nel codice applicativo (dipendenza morta).
- (RISOLTO) In `app/package.json` era presente una dipendenza malformata con chiave `undefined` e un path assoluto locale come valore. Rimossa: esponeva un percorso del filesystem dello sviluppatore e poteva rompere `npm install`.
- La console web `web/recovery-console.html` non usa librerie: P-256 è **reimplementata a mano in BigInt** (vedi §10).

---

## 2. Firme digitali

| Aspetto | Valore | Riferimento |
|---|---|---|
| Curva | NIST P-256 (secp256r1) | `app/lib/crypto.ts:14` |
| Algoritmo | ECDSA, messaggio pre-hashato con SHA-256 | `app/lib/crypto.ts:158-161` |
| Determinismo | RFC 6979 (default di `@noble/curves`), `lowS` di default | libreria |
| Formato firma | compatta raw 64 byte `r‖s`, trasmessa in hex (128 char) | `app/lib/crypto.ts:160` (`toCompactRawBytes`) |
| Chiave di firma | privata P-256 derivata dalla seed (vedi §9) | `app/lib/crypto.ts:36-44` |
| Verifica lato server | `p256.verify(sig, sha256(msg), pub)` | `server/src/middleware/auth.ts:54-61` |

### 2.1 Dove si firmano le richieste HTTP

**Client** — `signedReq` in `app/lib/api.ts:50-61`: firma
`canonicalize(method, path, ts, pubHex, body)` con `signChallenge`. La canonicalizzazione
(`app/lib/canonicalize.ts:18-30`) produce `method|urlPath|ts|pub|JSON(bodyOrdinatoDeep)` con
chiavi ordinate ricorsivamente e i campi `pub`/`ts`/`sig` esclusi dal body firmato.

**Server** — `requireAuth(actorType)` in `server/src/middleware/auth.ts:101-141`:
1. finestra temporale ±5 min sul `ts` (riga 116);
2. verifica ECDSA sulla stringa canonica (righe 121-126) — la canonicalizzazione server
   (`auth.ts:40-52`) deve restare identica a quella client;
3. anti-replay: cache **in memoria** `Map` con chiave `pub:ts:sig`, TTL 6 min (righe 15-32);
4. lookup dell'attore (`owner`, `contact`, `owner-of-switch`, `contact-of-switch`) per pubkey (righe 63-97).

**Firme "inline" fuori dal middleware** (formati di challenge ad hoc, tutti `sha256(stringa)` + ECDSA):
- `/contacts/:id/reject` → `"sentinella:reject-pairing:{contactId}:{ts}"` (`server/src/routes/pairing.ts:157`)
- `DELETE /contacts/:id` → `"sentinella:remove-contact:{contactId}:{ts}"` (`pairing.ts:179`)
- `PUT /contacts/:id` → `"sentinella:rotate-contact-key:{contactId}:{newPublicKey}:{ts}"` (`pairing.ts:235`)
- `/recovery/cancel` → firma del solo `recoveryId`, **senza timestamp** (`server/src/routes/recovery.ts:121`)
- `/recovery/pending-for-contact` → `"sentinella:recovery-pending:{pub}:{ts}"` (`recovery.ts:145`)
- `/auth/verify` → firma del nonce `"sentinella:"+nanoid(24)` emesso da `/auth/challenge`
  (`server/src/routes/auth.ts:31,46-48`); sessione = `nanoid(32)` in `Map` in-memory, TTL 30 min (righe 55-56).
- GET autenticati via **query-param** (`/audit/anchor`, `/audit/events`, `/pending`): stessa
  `canonicalize('GET', path, ts, pub, {})` ma `pub`/`ts`/`sig` viaggiano nell'URL
  (`app/lib/auditChain.ts:115-120`, `server/src/routes/audit_chain.ts:15-23`).

### 2.2 Dove si firmano gli eventi audit

**Non esiste una firma dedicata per gli eventi audit.** La colonna `signature` di `audit_chain`
contiene la **firma della richiesta HTTP client** che ha causato l'evento (`req.body.sig`), ad es.
`server/src/routes/switch.ts:93`, `approvals.ts:107`, `duress.ts:69`. Quella firma copre la stringa
canonica della richiesta, **non** i campi dell'evento (indice, prev_hash, timestamp assegnati dal
server). Molti eventi generati dal server hanno `signature: null` (es. `ROTATION_REQUESTED`,
`recovery.ts:46`). Il server **non possiede alcuna chiave di firma**: l'integrità della catena si
regge solo sull'hash chain (§6) e sulla verifica client con àncora salvata (`app/lib/auditChain.ts:104-112`).

---

## 3. Shamir k-su-N

| Aspetto | Valore | Riferimento |
|---|---|---|
| Implementazione | **fatta a mano** (~35 righe), non una libreria auditata | `app/lib/crypto.ts:110-147` |
| Campo finito | GF(2⁸) con polinomio riduttore `0x11b` (AES), tabelle EXP/LOG | `crypto.ts:112-115` |
| Grado del polinomio | k−1 (k coefficienti per byte, `co[0]` = byte del segreto) | `crypto.ts:120-122` |
| Entropia dei coefficienti | `randomBytes(k-1)` da `@noble/hashes` (CSPRNG) per ogni byte | `crypto.ts:122` |
| Segreto diviso | la DEK (32 byte) | `app/app/compose.tsx:305,319` |
| x delle quote reali | 1…N (sequenziali) | `crypto.ts:119` |
| x delle esche | **100+j** (vedi §10.2) | `compose.tsx:322` |
| Ricombinazione | interpolazione di Lagrange in x=0, byte per byte | `crypto.ts:131-147` |
| Verifica della soglia | nessuna nel combinatore: con <k quote produce **garbage silenzioso**; l'errore emerge solo perché il tag Poly1305 della decifratura fallisce | `crypto.ts:131-147` + uso in approve |

Il commento a `crypto.ts:111` stesso ammette: «per la produzione valutare una libreria dedicata e
auditata». Non c'è integrità sulle singole quote (nessun MAC per-share, nessun controllo di
duplicati o x uguali in `combineSecret` — input duplicati producono divisione con denominatore
`x_i ⊕ x_j = 0` → `gdiv(a,0)` legge `LOG[0]` non inizializzato, risultato indefinito senza errore).

---

## 4. Cifratura dei contenuti

| Aspetto | Valore | Riferimento |
|---|---|---|
| Algoritmo | XChaCha20-Poly1305 (AEAD) | `app/lib/crypto.ts:19,94-108` |
| Chiave (DEK) | 32 byte, `randomBytes(32)` | `compose.tsx:305`; anche `crypto.ts:95` |
| Nonce | 24 byte, `randomBytes(24)`, uno **nuovo per ogni cifratura** | `crypto.ts:96,102`; `attachments.ts:39` |
| Tag di autenticazione | 16 byte Poly1305, **appeso al ciphertext** dalla libreria; verificato in decrypt (throw su mismatch) | gestito da `@noble/ciphers` |
| AAD | **non usata** (nessun associated data) | tutti i punti di cifratura |
| Trasporto nonce | hex, campo `contentIv` inviato al server accanto al puntatore | `compose.tsx:324`, `server/src/db.ts:56` |
| Trasporto ciphertext | hex sul provider storage (raddoppia la dimensione) | `googleDrive.ts:53`, `devBlob.ts:21` |
| Riuso DEK | tutti i contenuti/allegati di uno switch condividono la stessa DEK, con nonce indipendenti (`encryptWithKey`) | `crypto.ts:101-105`, `keystore.ts:40-50` |
| Allegati | stessi parametri: XChaCha20-Poly1305 con DEK dello switch, nonce 24B random per file; nome/MIME reali solo nel manifest cifrato | `app/lib/attachments.ts:31-51` |
| DEK a riposo | hex in `expo-secure-store` (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`) | `keystore.ts:40-44` |

Flusso d'armo (`compose.tsx:303-325`): DEK random → cifra allegati → manifest JSON
`{v, text, attachments}` → `encryptWithKey(dek, manifest)` → upload ciphertext sul provider →
il server riceve **solo** `drivePointer` + `contentIv` (+ label in chiaro scelta dall'utente).

---

## 5. Cifratura delle quote verso i contatti (schema ibrido)

Schema ECIES-like in `sealTo`/`openWith` (`app/lib/crypto.ts:73-91`):

1. **Scambio chiavi**: ECDH effimero-statico su P-256. Chiave effimera
   `p256.utils.randomPrivateKey()` per ogni sigillo (`crypto.ts:78`); segreto condiviso =
   `p256.getSharedSecret(eph, recipientPub)` → **punto compresso di 33 byte, incluso il byte di
   prefisso 0x02/0x03** (non la sola coordinata x — scelta non-X9.63, coerente tra seal e open).
2. **KDF**: HKDF-SHA256, `salt = undefined`, `info = "sentinella/v1"`, output 32 byte
   (`crypto.ts:27,74-76`).
3. **Cifratura simmetrica**: XChaCha20-Poly1305, nonce 24 byte random (`crypto.ts:82-83`).
4. **Wire format**: JSON `{ephPub, nonce, ct}` in hex (`SealedBlob`, `crypto.ts:24`).

Impacchettamento quota: `sealShare` concatena `[x (1 byte)] ‖ y (32 byte)` e la sigilla verso la
pubkey del contatto (`crypto.ts:169-173`). **Esche**: `makeDecoy` sigilla 33 byte random verso una
chiave effimera la cui privata viene scartata (`crypto.ts:175-179`) — indistinguibile *dal blob*.
Il contatto ritrova la propria quota per **trial decryption**: prova `openWith` su tutti i blob; il
tag Poly1305 fallisce su quote altrui ed esche (`crypto.ts:180-190`).

Proprietà: nessuna autenticazione del mittente (chi conosce la pubkey del contatto può creare blob
validi); nessuna AAD che leghi il blob a switch/contesto.

---

## 6. Hash — ogni punto d'uso

| Uso | Funzione | Input | Riferimento |
|---|---|---|---|
| Derivazione scalare identità | SHA-256 | seed BIP39 (64B) → scalare P-256 | `app/lib/crypto.ts:40` |
| Pre-hash firma ECDSA | SHA-256 | stringa challenge/canonica UTF-8 | `crypto.ts:159`, `server/src/middleware/auth.ts:56` |
| KDF ECDH | HKDF-SHA256 | punto condiviso 33B, info `sentinella/v1` | `crypto.ts:74-76` |
| Fingerprint pubkey («impronta») | SHA-256 troncata a **12 hex = 48 bit**, uppercase | pubkey compressa | `crypto.ts:46-48` |
| Safety number | SHA-256 di `min(pubA,pubB)‖max(pubA,pubB)`; primi 12 byte → 6 parole BIP39 (uint16 mod 2048, uniforme; **66 bit** totali) | due pubkey | `crypto.ts:60-71` |
| Catena audit (server) | SHA-256 via `node:crypto` su `chain_owner_id\|chain_index\|event_type\|actor_id\|canonicalJson(payload)\|timestamp_ms\|signature\|prev_hash`; genesis = 64 zeri | campi evento concatenati con `\|` | `server/src/services/auditChain.ts:20-41` |
| Catena audit (verifica client) | identica ricomputazione con `@noble/hashes` | idem | `app/lib/auditChain.ts:54-75` |
| `to_hash` contatti | SHA-256 (`node:crypto`) di `'salt::' + contactId`, base64 troncato a 16 char — **"salt::" è una stringa letterale fissa, non un salt** | contactId | `server/src/routes/pairing.ts:98` |
| Hash PIN (sblocco/backup/duress) | SHA-256 **singola iterazione** di `salt + pin` (concatenazione stringhe) | salt hex 16B + PIN | `app/lib/pinHash.ts:4-6` (vedi §7) |
| Derivazione console web | PBKDF2-HMAC-SHA512 (2048 iter, salt `"mnemonic"`) → SHA-256 → scalare | mnemonic | `web/recovery-console.html:105-118` |
| Puntatori storage | **nessun hash**: puntatore = `gdrive://{fileId}` assegnato da Google; nome file = 32 hex random (16B `randomBytes`) | — | `app/lib/storage/googleDrive.ts:50,105` |

---

## 7. Derivazione PIN

Funzione unica per tutti e tre i PIN (sblocco, backup seed, duress):

```ts
// app/lib/pinHash.ts:4-6
hashPin(salt, pin) = hex(sha256(utf8(salt + pin)))
```

| Aspetto | Valore | Riferimento |
|---|---|---|
| Funzione | SHA-256, **1 iterazione — nessun KDF a costo** (niente PBKDF2/scrypt/Argon2) | `app/lib/pinHash.ts` |
| Salt | 16 byte da `randomBytes` (CSPRNG), hex, per-PIN | `app/app/lock.tsx:141`, `backup.tsx:84`, `duress-setup.tsx:139-140` |
| Parametri di costo | **assenti** | — |
| Formato PIN | ≥6 cifre numeriche, blacklist di 28 sequenze banali | `app/lib/pinPolicy.ts:6-27` |
| Storage | JSON `{hashHex, saltHex(, mode)}` in `expo-secure-store`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY` | `keystore.ts:107-115,160-171` |
| Confronto | uguaglianza stringhe `===` (non constant-time) | `lock.tsx:80,97`, `duress-setup.tsx:29,62` |
| Anti-brute-force | solo applicativo: lockout esponenziale 30s→4h dal 3° errore, persistito in SecureStore, reset dopo 24h | `app/lib/lockout.ts:8-51` |

Conseguenza (vedi §10.1): lo spazio dei PIN a 6 cifre è 10⁶; un attaccante che estragga
`{hashHex, saltHex}` dal keystore inverte l'hash offline in frazioni di secondo, lockout compreso.
Il duress PIN e il PIN di sblocco sono distinguibili dal PIN vero solo da questi hash.

---

## 8. Entropia e generazione di numeri casuali

### 8.1 Sorgenti CSPRNG

| Cosa | Sorgente | Riferimento |
|---|---|---|
| Seed phrase (128 bit) | `generateMnemonic` di `@scure/bip39` → `crypto.getRandomValues` | `crypto.ts:30-32` |
| DEK, nonce XChaCha (24B), salt PIN (16B), byte delle esche | `randomBytes` di `@noble/hashes` → `crypto.getRandomValues` | vari (§4, §5, §7) |
| Chiavi effimere ECDH, chiavi esca | `p256.utils.randomPrivateKey()` | `crypto.ts:78,176` |
| Coefficienti Shamir | `randomBytes(k-1)` per byte del segreto | `crypto.ts:122` |
| Polyfill RN | `react-native-get-random-values` importato come **prima riga** dell'entry | `app/app/_layout.tsx:1` |
| ID server (`usr_`, `c_`, `sw_`, `sc_`, `sh_`, `rec_`), token invito (`nanoid(16)`), nonce auth (`nanoid(24)`), token sessione (`nanoid(32)`) | `nanoid` (CSPRNG, alfabeto 64) | `server/src/routes/pairing.ts:43,65,97`, `auth.ts:31,55`, `switch.ts:47,82,84`, `recovery.ts:41` |
| Nome file su Drive | `randomBytes(16)` → 32 hex | `googleDrive.ts:50` |
| Console web | `crypto.getRandomValues`/WebCrypto (nessuna RNG manuale) | `web/recovery-console.html` |

### 8.2 Tutti gli usi di `Math.random` (non crittografico)

| Posizione | Uso | Valutazione |
|---|---|---|
| `app/app/compose.tsx:323` | **shuffle di quote reali + esche** prima dell'invio: `[...real, ...decoys].sort(() => Math.random() - 0.5)` | RNG non crittografico **e** shuffle notoriamente biased (comparatore incoerente). Rilevanza attenuata dal fatto che le esche sono comunque distinguibili dalla `x` (§10.2), ma da correggere insieme a quella. |
| `server/src/routes/checkin.ts:8` | jitter ±15% sull'intervallo di check-in (`withJitter`) | scopo: offuscare il ritmo verso osservatori del DB/traffico. RNG prevedibile (stato PRNG di V8) — bassa severità, ma se il jitter ha valenza anti-analisi andrebbe usato un CSPRNG. |
| `app/lib/crypto.test.ts:173` | shuffle nel test | solo test, ok |
| `server/src/routes/switch.test.ts:207` | id fittizio nel test | solo test, ok |

---

## 9. Seed phrase e derivazione dell'identità

| Aspetto | Valore | Riferimento |
|---|---|---|
| Wordlist | BIP39 inglese (2048 parole) | `crypto.ts:21` |
| Parole / entropia | 12 parole = **128 bit** di entropia (+4 bit checksum) | `crypto.ts:31` |
| Mnemonic → seed | `mnemonicToSeedSync` = PBKDF2-HMAC-SHA512, 2048 iterazioni, salt `"mnemonic"` — **senza passphrase BIP39** (non supportata) | `crypto.ts:37` |
| Seed → chiave privata | **non standard** (niente BIP32/SLIP-10): `scalar = (BE(sha256(seed64)) mod (n−1)) + 1`; privata = scalar 32B, pubblica = punto compresso 33B | `crypto.ts:38-43` |
| Normalizzazione input | `trim().toLowerCase()` nell'app; la console web aggiunge `.normalize('NFKD')` (l'app **no** — divergenza teorica su input non-ASCII, irrilevante per la wordlist inglese) | `crypto.ts:34,37` vs `recovery-console.html:106` |
| Console web | stessa derivazione riimplementata: PBKDF2 via WebCrypto + **P-256 in BigInt scritto a mano** per ricavare la pubkey; firma poi con WebCrypto ECDSA (r‖s raw, compatibile col server) | `recovery-console.html:91-118,136` |
| Custodia | mnemonic in chiaro dentro `expo-secure-store` (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`); la privata è riderivata a ogni uso; **non** c'è uso di Secure Enclave/StrongBox per chiavi non esportabili (il commento in `keystore.ts:1-3` descrive l'obiettivo, non lo stato) | `app/lib/keystore.ts:10-18` |

Il bias del riduzione modulare `mod (n−1)` è ≈2⁻³² (n di P-256 è vicinissimo a 2²⁵⁶): trascurabile
in pratica, ma non è la costruzione standard (hash-to-scalar con oversampling o BIP32).

---

## 10. Punti che richiedono attenzione dell'auditor

In ordine di gravità stimata. Questa sezione è deliberatamente critica.

### 10.1 PIN: hash a costo zero su spazio di 10⁶ — **critico**
`hashPin` = una singola SHA-256 di `salt+pin` (`app/lib/pinHash.ts:4-6`). Un PIN di 6 cifre ha
~20 bit di entropia: chi ottiene il record dal keystore (device sequestrato + estrazione, backup,
escalation locale) enumera l'intero spazio offline istantaneamente, aggirando il lockout
applicativo di `lockout.ts`. Peggio: l'attaccante recupera **sia** il PIN vero **sia** il duress
PIN, e può quindi *distinguerli* — esattamente ciò che un PIN di coercizione deve impedire.
Serve un KDF memory-hard (Argon2id / scrypt; PBKDF2 ad alto costo come minimo) e idealmente il
binding a chiavi hardware. Nota secondaria: confronti con `===` non constant-time.

### 10.2 Le esche sono distinguibili dal server tramite `x` — **critico per il modello metadata**
Le quote reali hanno `x = 1…N` (`crypto.ts:119`), le esche `x = 100+j` (`compose.tsx:322`), e la
`x` è salvata **in chiaro** nella tabella `shares` (`db.ts:68`, `switch.ts:82`). Il server può
quindi separare reali ed esche a colpo d'occhio, contare **N reale** e osservare quali indici
vengono reinviati a `/approval/submit` (che espone di nuovo `share.x`, `approvals.ts:99-100`).
L'invariante «il server non sa quante quote reali esistano» (commento `db.ts:61-64`) è
**contraddetta dal codice**. Lo shuffle biased con `Math.random` (§8.2) è irrilevante finché la
`x` resta il canale di distinzione.

### 10.3 Il server apprende k via `recoveryK` — **divergenza commento/codice**
`switch/create` dichiara «la soglia k NON viene inviata al server» (`switch.ts:46`), ma
`compose.tsx:324` invia `recoveryK: threshold` — **lo stesso valore della soglia Shamir** — e
`/switch/arm` lo persiste in `users.recovery_k` (`switch.ts:95-98`). Formalmente è il quorum del
recovery sociale, ma essendo identico a k il server conosce di fatto la soglia di rilascio,
violando l'invariante di progetto n.3. `/auth/verify` restituisce anche `threshold_k` nella SELECT
degli switch (`auth.ts:58`) — vedi 10.4.

### 10.4 Query su colonne inesistenti: `threshold_k`, `drive_pointer`, `content_iv` — **bug funzionale**
Lo schema attuale di `switches` (`db.ts:37-46`) non ha `threshold_k`, e le colonne
`drive_pointer`/`content_iv` vengono **droppate** dalla migrazione (`db.ts:125-126`). Eppure:
`auth.ts:58` (`/auth/verify`) e `vault.ts:9` (`/vault/view`) le selezionano. Su un DB creato dallo
schema corrente `db.prepare` solleva `no such column` → 500 a runtime. O il codice è morto/legacy
(da rimuovere) o funziona solo su DB storici: in entrambi i casi è una divergenza codice/schema che
l'auditor deve chiarire.

### 10.5 «Audit log firmato» che non è firmato — **claim non mantenuto**
Nessuna chiave di firma server-side esiste. La catena (`auditChain.ts`) è solo hash-linked; la
colonna `signature` ricicla firme di richieste client che non coprono i campi dell'evento, e molti
eventi hanno `signature: null` (§2.2). Un server malevolo può riscrivere l'intera catena
ricalcolando gli hash; l'unica difesa è l'àncora salvata client-side (`verifyFromAnchor`), che
protegge solo da rollback successivi all'ultimo controllo. Inoltre il preimage dell'hash è una
concatenazione con `|` di campi non length-prefixed (`auditChain.ts:30-39`): `event_type`/
`actor_id`/`payload` contenenti `|` possono creare ambiguità di parsing (i valori sono in gran
parte controllati dal server, ma `payload` include input client come `newPublicKey`).

### 10.6 Shamir fatto a mano — **primitiva non auditata**
Vedi §3: nessuna libreria auditata, nessuna integrità per-share, `combineSecret` non rifiuta x
duplicate (divisione per zero in GF(256) → lettura di `LOG[0]` non inizializzato → output
indefinito silenzioso), nessuna costant-time (tabelle lookup → cache timing, rilevanza limitata
lato client). Il TODO in `crypto.ts:111` lo riconosce. Da sostituire o auditare a fondo.

### 10.7 P-256 in BigInt scritto a mano nella console web
`recovery-console.html:91-102` implementa da zero aritmetica di curva (double-and-add non
constant-time, nessuna validazione di punto). È usata solo per derivare la pubkey dalla seed — ma
la seed è il segreto massimo del sistema e viene processata da codice non auditato in un contesto
browser (estensioni, cache, devtools). Ogni divergenza da `@noble/curves` qui è anche un rischio di
lock-out (pubkey diversa → identità diversa).

**Contesto e decisione (M5):**
- La scelta di implementare l'aritmetica di curva a mano è DELIBERATA: la console è uno strumento
  di recupero d'emergenza pensato per funzionare offline, e Web Crypto non espone la
  moltiplicazione scalare (priv × G) necessaria a derivare la pubkey. La FIRMA usa invece Web
  Crypto nativo (`crypto.subtle`, ECDSA) — solo la derivazione pubkey è a mano.
- Rischio timing side-channel: BASSO nel contesto. L'operazione è client-side, sul dispositivo
  dell'utente, one-shot (una derivazione all'avvio), quindi non offre superficie statistica per un
  attacco timing; un attaccante con codice nella pagina avrebbe comunque accesso diretto alla seed.
- Rischio lock-out (PIÙ CONCRETO): se la derivazione a mano diverge anche di un bit da
  `@noble/curves` usato nell'app, la stessa seed produce identità diverse → auth fallita nel
  momento del recupero. VA VERIFICATO con un test di equivalenza (stessa seed → stessa pubkey
  compressa in console e app) su alcune seed di prova.
- Rischio a monte (indipendente dall'implementazione): la console processa la SEED in un contesto
  browser (estensioni, devtools, cache, e possibile manomissione della pagina se servita da fonte
  non fidata). Questo è il rischio maggiore, non la P-256 a mano. Raccomandazione: aprire la
  console solo da file locale verificato o HTTPS fidato, idealmente su dispositivo offline.

**Decisione:** accettato nel contesto attuale (offline-first, firma già nativa, timing basso). Per
l'audit professionale: (1) validare l'equivalenza console↔app per escludere lock-out; (2) valutare
se inlinare `@noble/curves` come bundle standalone mantenendo il funzionamento offline; (3)
valutare hardening del contesto browser (come si serve/apre la pagina).

### 10.8 Derivazione identità non standard
`sha256(seed) mod (n−1) + 1` (§9) invece di BIP32/SLIP-10: funziona, ma è una costruzione
custom, senza passphrase BIP39, senza possibilità di derivare chiavi multiple, con bias modulare
teorico ≈2⁻³². La normalizzazione NFKD c'è solo nella console web, non nell'app (`crypto.ts:37`).

### 10.9 Fingerprint a 48 bit
`fingerprint()` tronca SHA-256 a 12 hex = 48 bit (`crypto.ts:46-48`). Una second-preimage su 48
bit (~2⁴⁸ tentativi di generazione chiave) è alla portata di un avversario ben attrezzato che
voglia far accettare una pubkey sostituita a chi verifica solo l'impronta breve. Il safety number
a 6 parole (66 bit, `crypto.ts:60-71`) è più robusto ma sotto i 112 bit consuetudinari (Signal usa
60 cifre ≈ 200 bit sui due lati). Valutare l'allungamento o l'obbligo del confronto a parole.

### 10.10 Stato anti-replay e sessioni solo in memoria
Cache nonce (`auth.ts` middleware, righe 15-32), challenge e sessioni (`routes/auth.ts:15-16`)
vivono in `Map` in-process: un riavvio del server apre una finestra di replay di ±5 min per
richieste firmate già viste e invalida le sessioni. Con più istanze dietro load balancer la
protezione anti-replay non è condivisa. (ECDSA deterministica RFC 6979 fa sì che la stessa
richiesta produca la stessa firma: la chiave di cache `pub:ts:sig` funziona, ma solo per-processo.)

### 10.11 Firme e metadati in query string
I GET autenticati (`/pending`, `/audit/anchor`, `/audit/events`, `/recovery/pending-for-contact`)
trasportano `pub`, `ts`, `sig` **nell'URL** (§2.1): finiscono nei log di proxy/reverse-proxy e
nella history. Non consentono replay oltre la finestra di 5 min (e la cache nonce non copre i GET:
`checkAndRegisterNonce` è solo nel middleware POST — un GET firmato è rigiocabile per 5 minuti da
chi legge i log in tempo reale). Le route GET espongono inoltre dati senza auth dove il solo
`switchId` fa da capability: `/switch`, `/switch/contents`, `/approval/request`, `/shares`,
`/contacts?ownerId=`, `/vault/view` — l'auditor dovrebbe valutare l'entropia e la circolazione di
questi ID (generati con `nanoid(10)`, ~60 bit).

### 10.12 Blob su Drive pubblici «a chiunque abbia il link»
`googleDrive.ts:88-99` imposta permesso `reader/anyone`; il download avviene senza auth
(`googleDrive.ts:118`). Scelta documentata nel codice (righe 21-26): la riservatezza poggia al 100%
su XChaCha20-Poly1305 + Shamir. Corretto sul piano crittografico, ma: il fileId è una capability
permanente, il ciphertext resta scaricabile per sempre (nessuna forward secrecy: un k-quorum
futuro + blob archiviato = rilascio), e i pattern di accesso a Drive sono visibili a Google.

**Analisi M6 — tensione strutturale (non un bug):**
La mitigazione ovvia (cancellare/scadere il blob dopo la consegna) richiede di rispondere a: chi ha
l'autorità di cancellare? Sentinella è un dead-man's switch: lo switch va in RELEASED perché
l'owner non risponde (arresto, sparizione, morte), quindi l'owner NON è disponibile quando ci
sarebbe da cancellare. Ipotesi valutate:
- Token OAuth dell'owner sul server: i token scadono (owner sparito = account inattivo); e dare al
  server il potere di cancellare su Drive dell'owner contraddice il principio (server = puntatori
  opachi, nessun potere sui contenuti) e apre il sabotaggio del rilascio da parte di un server
  compromesso.
- Contatti cancellano: non hanno le credenziali Drive dell'owner; condividere quel potere riapre il
  problema (chi può cancellare può sabotare).
- TTL nativo Drive: non affidabile, dipende dall'account owner attivo.
- Ruotare la chiave: protetta da Shamir distribuito, nessun punto centrale può ruotarla senza il
  quorum (= il rilascio stesso).
TENSIONE: la forward secrecy richiede che qualcuno possa distruggere il blob nel futuro; il design
nega a chiunque potere unilaterale sui dati. Ogni meccanismo di cancellazione dà anche il potere di
sabotare la consegna (lo scopo primario). Tensione secondaria: il blocco ricezione consente accesso
tardivo dei contatti; cancellare presto taglia fuori i tardivi, e un blob cancellato è
irrecuperabile.
DECISIONE: accettato come trade-off strutturale. Il sistema privilegia la consegna affidabile sulla
forward secrecy — scelta difendibile per un dead-man's switch. Difesa primaria: Shamir k-quorum
(serve comunque k quote per decifrare qualsiasi copia). Forward secrecy vera = modello di consegna
diverso (riprogettazione), da valutare all'audit.

### 10.13 Punti minori
- `to_hash` usa il literal `'salt::'` come pseudo-salt (`pairing.ts:98`): nome fuorviante, nessuna
  proprietà di salt reale; l'input (`contactId` nanoid) rende comunque l'output imprevedibile.
- Jitter check-in con `Math.random` (§8.2): se ha finalità anti-analisi, usare CSPRNG.
- ECDH usa il punto condiviso compresso a 33B (prefisso incluso) come IKM di HKDF anziché la sola
  coordinata x (X9.63): non è un difetto di sicurezza ma è non-standard, e vincola qualsiasi
  reimplementazione futura (console web, altri client) a riprodurre esattamente questo dettaglio.
- HKDF con `salt = undefined` (`crypto.ts:75`): lecito (salt zero per RFC 5869) ma un salt
  esplicito/contesto per-messaggio sarebbe più robusto.
- Nessuna AAD in alcun AEAD: i blob non sono legati crittograficamente a switch/contesto
  (es. una quota sigillata potrebbe essere ripresentata su un altro switch dello stesso owner).
- `expo-crypto` dipendenza dichiarata e mai usata.
- Lockfile unico alla radice: `server/` non ha un lockfile proprio — verificare che il deploy del
  server usi versioni bloccate delle librerie crypto.
- La seed resta leggibile in SecureStore (nessuna chiave hardware non-esportabile); il claim
  «Secure Enclave/StrongBox» in `keystore.ts:1-3` e nel piano di sviluppo è a oggi solo un commento.

---

*Fine inventario. Documento generato per la preparazione all'audit; nessun file di codice è stato modificato.*
