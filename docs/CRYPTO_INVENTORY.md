# Cryptographic inventory — Sentinella

> 🇬🇧 English · [🇮🇹 Italiano](CRYPTO_INVENTORY.it.md)

> Preparatory document for an independent security audit.
> Written **by reading the actual code** (2026-07-20), not the comments nor the documentation.
> Where comment and code diverge, the **code** is reported and the divergence is flagged
> explicitly (see §10).
>
> Paths are relative to the repo root (`sentinella/sentinella`).
> No code file was modified to produce this document.

---

## 1. Cryptographic libraries and versions

The "declared" versions come from `app/package.json` and `server/package.json`; the "installed"
versions from the **single lockfile at the root** (`package-lock.json` — there are no separate
lockfiles for `app/` and `server/`).

| Library | Declared (app) | Declared (server) | Installed (lockfile) | Use |
|---|---|---|---|---|
| `@noble/curves` | `^1.6.0` | `^1.6.0` | **1.9.7** | P-256: ECDSA, ECDH, key generation |
| `@noble/ciphers` | `^1.0.0` | — | **1.3.0** | XChaCha20-Poly1305 |
| `@noble/hashes` | `^1.5.0` | `^1.5.0` | **1.8.0** | SHA-256, HKDF, `randomBytes` |
| `@scure/bip39` | `^1.4.0` | — | **1.6.0** | Seed phrase (mnemonic → seed) |
| `nanoid` | — | `^5.0.7` | **5.1.11** | Server-side IDs and tokens (CSPRNG) |
| `react-native-get-random-values` | `~1.11.0` | — | 1.11.x | `crypto.getRandomValues` polyfill in RN |
| `expo-secure-store` | `~13.0.0` | — | 13.0.x | On-device custody of seed/DEK/PIN |
| `node:crypto` (built-in) | — | built-in | — | `createHash('sha256')` server-side |
| Web Crypto API (browser) | — | — | — | PBKDF2/SHA/ECDSA in the web console |

Notes:
- `expo-crypto` (`~13.0.2`) is **declared but never imported** in the application code (dead dependency).
- (RESOLVED) `app/package.json` contained a malformed dependency with key `undefined` and a local absolute path as value. Removed: it exposed a path of the developer's filesystem and could break `npm install`.
- The web console `web/recovery-console.html` uses no libraries: P-256 is **reimplemented by hand in BigInt** (see §10).

---

## 2. Digital signatures

| Aspect | Value | Reference |
|---|---|---|
| Curve | NIST P-256 (secp256r1) | `app/lib/crypto.ts:14` |
| Algorithm | ECDSA, message pre-hashed with SHA-256 | `app/lib/crypto.ts:158-161` |
| Determinism | RFC 6979 (default of `@noble/curves`), `lowS` by default | library |
| Signature format | compact raw 64 bytes `r‖s`, transmitted as hex (128 chars) | `app/lib/crypto.ts:160` (`toCompactRawBytes`) |
| Signing key | P-256 private key derived from the seed (see §9) | `app/lib/crypto.ts:36-44` |
| Server-side verification | `p256.verify(sig, sha256(msg), pub)` | `server/src/middleware/auth.ts:54-61` |

### 2.1 Where HTTP requests are signed

**Client** — `signedReq` in `app/lib/api.ts:50-61`: signs
`canonicalize(method, path, ts, pubHex, body)` with `signChallenge`. The canonicalization
(`app/lib/canonicalize.ts:18-30`) produces `method|urlPath|ts|pub|JSON(deepSortedBody)` with
recursively sorted keys and the `pub`/`ts`/`sig` fields excluded from the signed body.

**Server** — `requireAuth(actorType)` in `server/src/middleware/auth.ts:101-141`:
1. ±5 min time window on `ts` (line 116);
2. ECDSA verification over the canonical string (lines 121-126) — the server-side canonicalization
   (`auth.ts:40-52`) must remain identical to the client-side one;
3. anti-replay: **in-memory** `Map` cache keyed by `pub:ts:sig`, TTL 6 min (lines 15-32);
4. actor lookup (`owner`, `contact`, `owner-of-switch`, `contact-of-switch`) by pubkey (lines 63-97).

**"Inline" signatures outside the middleware** (ad hoc challenge formats, all `sha256(string)` + ECDSA):
- `/contacts/:id/reject` → `"sentinella:reject-pairing:{contactId}:{ts}"` (`server/src/routes/pairing.ts:157`)
- `DELETE /contacts/:id` → `"sentinella:remove-contact:{contactId}:{ts}"` (`pairing.ts:179`)
- `PUT /contacts/:id` → `"sentinella:rotate-contact-key:{contactId}:{newPublicKey}:{ts}"` (`pairing.ts:235`)
- `/recovery/cancel` → signature over the `recoveryId` alone, **without timestamp** (`server/src/routes/recovery.ts:121`)
- `/recovery/pending-for-contact` → `"sentinella:recovery-pending:{pub}:{ts}"` (`recovery.ts:145`)
- `/auth/verify` → signature over the nonce `"sentinella:"+nanoid(24)` issued by `/auth/challenge`
  (`server/src/routes/auth.ts:31,46-48`); session = `nanoid(32)` in an in-memory `Map`, TTL 30 min (lines 55-56).
- Authenticated GETs via **query-param** (`/audit/anchor`, `/audit/events`, `/pending`): same
  `canonicalize('GET', path, ts, pub, {})` but `pub`/`ts`/`sig` travel in the URL
  (`app/lib/auditChain.ts:115-120`, `server/src/routes/audit_chain.ts:15-23`).

### 2.2 Where audit events are signed

**There is no dedicated signature for audit events.** The `signature` column of `audit_chain`
contains the **signature of the client HTTP request** that caused the event (`req.body.sig`), e.g.
`server/src/routes/switch.ts:93`, `approvals.ts:107`, `duress.ts:69`. That signature covers the
canonical string of the request, **not** the event fields (index, prev_hash, timestamp assigned by
the server). Many server-generated events have `signature: null` (e.g. `ROTATION_REQUESTED`,
`recovery.ts:46`). The server **holds no signing key at all**: the integrity of the chain rests
solely on the hash chain (§6) and on client-side verification against a saved anchor (`app/lib/auditChain.ts:104-112`).

---

## 3. Shamir k-of-N

| Aspect | Value | Reference |
|---|---|---|
| Implementation | **hand-written** (~35 lines), not an audited library | `app/lib/crypto.ts:110-147` |
| Finite field | GF(2⁸) with reduction polynomial `0x11b` (AES), EXP/LOG tables | `crypto.ts:112-115` |
| Polynomial degree | k−1 (k coefficients per byte, `co[0]` = secret byte) | `crypto.ts:120-122` |
| Coefficient entropy | `randomBytes(k-1)` from `@noble/hashes` (CSPRNG) for each byte | `crypto.ts:122` |
| Secret being split | the DEK (32 bytes) | `app/app/compose.tsx:305,319` |
| x of the real shares | 1…N (sequential) | `crypto.ts:119` |
| x of the decoys | **100+j** (see §10.2) | `compose.tsx:322` |
| Recombination | Lagrange interpolation at x=0, byte by byte | `crypto.ts:131-147` |
| Threshold check | none in the combiner: with <k shares it produces **silent garbage**; the error only surfaces because the Poly1305 tag of the decryption fails | `crypto.ts:131-147` + use in approve |

The comment at `crypto.ts:111` itself admits: "for production, evaluate a dedicated, audited
library". There is no integrity on the individual shares (no per-share MAC, no check for
duplicates or equal x values in `combineSecret` — duplicate inputs produce a division with denominator
`x_i ⊕ x_j = 0` → `gdiv(a,0)` reads the uninitialized `LOG[0]`, undefined result with no error).

---

## 4. Content encryption

| Aspect | Value | Reference |
|---|---|---|
| Algorithm | XChaCha20-Poly1305 (AEAD) | `app/lib/crypto.ts:19,94-108` |
| Key (DEK) | 32 bytes, `randomBytes(32)` | `compose.tsx:305`; also `crypto.ts:95` |
| Nonce | 24 bytes, `randomBytes(24)`, a **fresh one for every encryption** | `crypto.ts:96,102`; `attachments.ts:39` |
| Authentication tag | 16 bytes Poly1305, **appended to the ciphertext** by the library; verified on decrypt (throws on mismatch) | handled by `@noble/ciphers` |
| AAD | **not used** (no associated data) | all encryption points |
| Nonce transport | hex, `contentIv` field sent to the server alongside the pointer | `compose.tsx:324`, `server/src/db.ts:56` |
| Ciphertext transport | hex on the storage provider (doubles the size) | `googleDrive.ts:53`, `devBlob.ts:21` |
| DEK reuse | all content/attachments of a switch share the same DEK, with independent nonces (`encryptWithKey`) | `crypto.ts:101-105`, `keystore.ts:40-50` |
| Attachments | same parameters: XChaCha20-Poly1305 with the switch DEK, random 24B nonce per file; real name/MIME only in the encrypted manifest | `app/lib/attachments.ts:31-51` |
| DEK at rest | hex in `expo-secure-store` (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`) | `keystore.ts:40-44` |

Arming flow (`compose.tsx:303-325`): random DEK → encrypt attachments → JSON manifest
`{v, text, attachments}` → `encryptWithKey(dek, manifest)` → upload ciphertext to the provider →
the server receives **only** `drivePointer` + `contentIv` (+ a cleartext label chosen by the user).

---

## 5. Encryption of shares to contacts (hybrid scheme)

ECIES-like scheme in `sealTo`/`openWith` (`app/lib/crypto.ts:73-91`):

1. **Key exchange**: ephemeral-static ECDH on P-256. Ephemeral key
   `p256.utils.randomPrivateKey()` for every seal (`crypto.ts:78`); shared secret =
   `p256.getSharedSecret(eph, recipientPub)` → **33-byte compressed point, including the
   0x02/0x03 prefix byte** (not the x coordinate alone — a non-X9.63 choice, consistent between seal and open).
2. **KDF**: HKDF-SHA256, `salt = undefined`, `info = "sentinella/v1"`, 32-byte output
   (`crypto.ts:27,74-76`).
3. **Symmetric encryption**: XChaCha20-Poly1305, random 24-byte nonce (`crypto.ts:82-83`).
4. **Wire format**: JSON `{ephPub, nonce, ct}` in hex (`SealedBlob`, `crypto.ts:24`).

Share packaging: `sealShare` concatenates `[x (1 byte)] ‖ y (32 bytes)` and seals it to the
contact's pubkey (`crypto.ts:169-173`). **Decoys**: `makeDecoy` seals 33 random bytes to an
ephemeral key whose private half is discarded (`crypto.ts:175-179`) — indistinguishable *from the blob*.
The contact finds their own share by **trial decryption**: it tries `openWith` on all blobs; the
Poly1305 tag fails on other contacts' shares and on decoys (`crypto.ts:180-190`).

Properties: no sender authentication (anyone who knows the contact's pubkey can create valid
blobs); no AAD binding the blob to a switch/context.

---

## 6. Hashing — every point of use

| Use | Function | Input | Reference |
|---|---|---|---|
| Identity scalar derivation | SHA-256 | BIP39 seed (64B) → P-256 scalar | `app/lib/crypto.ts:40` |
| ECDSA signature pre-hash | SHA-256 | UTF-8 challenge/canonical string | `crypto.ts:159`, `server/src/middleware/auth.ts:56` |
| ECDH KDF | HKDF-SHA256 | 33B shared point, info `sentinella/v1` | `crypto.ts:74-76` |
| Pubkey fingerprint ("impronta") | SHA-256 truncated to **12 hex = 48 bits**, uppercase | compressed pubkey | `crypto.ts:46-48` |
| Safety number | SHA-256 of `min(pubA,pubB)‖max(pubA,pubB)`; first 12 bytes → 6 BIP39 words (uint16 mod 2048, uniform; **66 bits** total) | two pubkeys | `crypto.ts:60-71` |
| Audit chain (server) | SHA-256 via `node:crypto` over `chain_owner_id\|chain_index\|event_type\|actor_id\|canonicalJson(payload)\|timestamp_ms\|signature\|prev_hash`; genesis = 64 zeros | event fields concatenated with `\|` | `server/src/services/auditChain.ts:20-41` |
| Audit chain (client verification) | identical recomputation with `@noble/hashes` | same | `app/lib/auditChain.ts:54-75` |
| Contacts `to_hash` | SHA-256 (`node:crypto`) of `'salt::' + contactId`, base64 truncated to 16 chars — **"salt::" is a fixed literal string, not a salt** | contactId | `server/src/routes/pairing.ts:98` |
| PIN hash (unlock/backup/duress) | SHA-256 **single iteration** of `salt + pin` (string concatenation) | 16B hex salt + PIN | `app/lib/pinHash.ts:4-6` (see §7) |
| Web console derivation | PBKDF2-HMAC-SHA512 (2048 iter, salt `"mnemonic"`) → SHA-256 → scalar | mnemonic | `web/recovery-console.html:105-118` |
| Storage pointers | **no hash**: pointer = `gdrive://{fileId}` assigned by Google; file name = 32 random hex (16B `randomBytes`) | — | `app/lib/storage/googleDrive.ts:50,105` |

---

## 7. PIN derivation

Single function for all three PINs (unlock, seed backup, duress):

```ts
// app/lib/pinHash.ts:4-6
hashPin(salt, pin) = hex(sha256(utf8(salt + pin)))
```

| Aspect | Value | Reference |
|---|---|---|
| Function | SHA-256, **1 iteration — no cost-parameterized KDF** (no PBKDF2/scrypt/Argon2) | `app/lib/pinHash.ts` |
| Salt | 16 bytes from `randomBytes` (CSPRNG), hex, per-PIN | `app/app/lock.tsx:141`, `backup.tsx:84`, `duress-setup.tsx:139-140` |
| Cost parameters | **absent** | — |
| PIN format | ≥6 numeric digits, blacklist of 28 trivial sequences | `app/lib/pinPolicy.ts:6-27` |
| Storage | JSON `{hashHex, saltHex(, mode)}` in `expo-secure-store`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY` | `keystore.ts:107-115,160-171` |
| Comparison | string equality `===` (not constant-time) | `lock.tsx:80,97`, `duress-setup.tsx:29,62` |
| Anti-brute-force | application-level only: exponential lock-out 30s→4h from the 3rd failure, persisted in SecureStore, reset after 24h | `app/lib/lockout.ts:8-51` |

Consequence (see §10.1): the 6-digit PIN space is 10⁶; an attacker who extracts
`{hashHex, saltHex}` from the keystore inverts the hash offline in fractions of a second, lock-out included.
The duress PIN and the unlock PIN are distinguishable from the real PIN only by these hashes.

---

## 8. Entropy and random number generation

### 8.1 CSPRNG sources

| What | Source | Reference |
|---|---|---|
| Seed phrase (128 bits) | `generateMnemonic` from `@scure/bip39` → `crypto.getRandomValues` | `crypto.ts:30-32` |
| DEK, XChaCha nonce (24B), PIN salt (16B), decoy bytes | `randomBytes` from `@noble/hashes` → `crypto.getRandomValues` | various (§4, §5, §7) |
| ECDH ephemeral keys, decoy keys | `p256.utils.randomPrivateKey()` | `crypto.ts:78,176` |
| Shamir coefficients | `randomBytes(k-1)` per secret byte | `crypto.ts:122` |
| RN polyfill | `react-native-get-random-values` imported as the **first line** of the entry point | `app/app/_layout.tsx:1` |
| Server IDs (`usr_`, `c_`, `sw_`, `sc_`, `sh_`, `rec_`), invite token (`nanoid(16)`), auth nonce (`nanoid(24)`), session token (`nanoid(32)`) | `nanoid` (CSPRNG, 64-symbol alphabet) | `server/src/routes/pairing.ts:43,65,97`, `auth.ts:31,55`, `switch.ts:47,82,84`, `recovery.ts:41` |
| File name on Drive | `randomBytes(16)` → 32 hex | `googleDrive.ts:50` |
| Web console | `crypto.getRandomValues`/WebCrypto (no hand-rolled RNG) | `web/recovery-console.html` |

### 8.2 All uses of `Math.random` (non-cryptographic)

| Location | Use | Assessment |
|---|---|---|
| `app/app/compose.tsx:323` | **shuffle of real shares + decoys** before sending: `[...real, ...decoys].sort(() => Math.random() - 0.5)` | Non-cryptographic RNG **and** a notoriously biased shuffle (inconsistent comparator). Relevance reduced by the fact that decoys are in any case distinguishable by `x` (§10.2), but to be fixed together with that. |
| `server/src/routes/checkin.ts:8` | ±15% jitter on the check-in interval (`withJitter`) | purpose: obscure the cadence from DB/traffic observers. Predictable RNG (V8 PRNG state) — low severity, but if the jitter has an anti-analysis purpose a CSPRNG should be used. |
| `app/lib/crypto.test.ts:173` | shuffle in the test | test only, ok |
| `server/src/routes/switch.test.ts:207` | fake id in the test | test only, ok |

---

## 9. Seed phrase and identity derivation

| Aspect | Value | Reference |
|---|---|---|
| Wordlist | English BIP39 (2048 words) | `crypto.ts:21` |
| Words / entropy | 12 words = **128 bits** of entropy (+4 checksum bits) | `crypto.ts:31` |
| Mnemonic → seed | `mnemonicToSeedSync` = PBKDF2-HMAC-SHA512, 2048 iterations, salt `"mnemonic"` — **without BIP39 passphrase** (not supported) | `crypto.ts:37` |
| Seed → private key | **non-standard** (no BIP32/SLIP-10): `scalar = (BE(sha256(seed64)) mod (n−1)) + 1`; private = 32B scalar, public = 33B compressed point | `crypto.ts:38-43` |
| Input normalization | `trim().toLowerCase()` in the app; the web console adds `.normalize('NFKD')` (the app does **not** — theoretical divergence on non-ASCII input, irrelevant for the English wordlist) | `crypto.ts:34,37` vs `recovery-console.html:106` |
| Web console | same derivation reimplemented: PBKDF2 via WebCrypto + **hand-written P-256 in BigInt** to obtain the pubkey; then signs with WebCrypto ECDSA (raw r‖s, compatible with the server) | `recovery-console.html:91-118,136` |
| Custody | cleartext mnemonic inside `expo-secure-store` (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`); the private key is re-derived on every use; there is **no** use of Secure Enclave/StrongBox for non-exportable keys (the comment in `keystore.ts:1-3` describes the goal, not the state) | `app/lib/keystore.ts:10-18` |

The bias of the modular reduction `mod (n−1)` is ≈2⁻³² (the n of P-256 is extremely close to 2²⁵⁶): negligible
in practice, but it is not the standard construction (hash-to-scalar with oversampling, or BIP32).

---

## 10. Points requiring the auditor's attention

In order of estimated severity. This section is deliberately critical.

### 10.1 PIN: zero-cost hash over a 10⁶ space — **critical**
`hashPin` = a single SHA-256 of `salt+pin` (`app/lib/pinHash.ts:4-6`). A 6-digit PIN has
~20 bits of entropy: whoever obtains the record from the keystore (seized device + extraction, backup,
local escalation) enumerates the entire space offline instantly, bypassing the application-level
lock-out of `lockout.ts`. Worse: the attacker recovers **both** the real PIN **and** the duress
PIN, and can therefore *distinguish them* — exactly what a coercion PIN must prevent.
A memory-hard KDF is needed (Argon2id / scrypt; high-cost PBKDF2 as a minimum) and ideally
binding to hardware keys. Secondary note: comparisons with `===` are not constant-time.

### 10.2 Decoys are distinguishable by the server via `x` — **critical for the metadata model**
Real shares have `x = 1…N` (`crypto.ts:119`), decoys `x = 100+j` (`compose.tsx:322`), and the
`x` is stored **in the clear** in the `shares` table (`db.ts:68`, `switch.ts:82`). The server can
therefore separate real shares from decoys at a glance, count the **real N** and observe which indices
are resubmitted to `/approval/submit` (which exposes `share.x` again, `approvals.ts:99-100`).
The invariant "the server does not know how many real shares exist" (comment `db.ts:61-64`) is
**contradicted by the code**. The biased shuffle with `Math.random` (§8.2) is irrelevant as long as
`x` remains the distinguishing channel.

### 10.3 The server learns k via `recoveryK` — **comment/code divergence**
`switch/create` declares "the threshold k is NOT sent to the server" (`switch.ts:46`), but
`compose.tsx:324` sends `recoveryK: threshold` — **the very same value as the Shamir threshold** — and
`/switch/arm` persists it in `users.recovery_k` (`switch.ts:95-98`). Formally it is the social
recovery quorum, but since it is identical to k the server effectively knows the release threshold,
violating project invariant no. 3. `/auth/verify` also returns `threshold_k` in the SELECT
over the switches (`auth.ts:58`) — see 10.4.

### 10.4 Queries on non-existent columns: `threshold_k`, `drive_pointer`, `content_iv` — **functional bug**
The current schema of `switches` (`db.ts:37-46`) has no `threshold_k`, and the
`drive_pointer`/`content_iv` columns are **dropped** by the migration (`db.ts:125-126`). Yet:
`auth.ts:58` (`/auth/verify`) and `vault.ts:9` (`/vault/view`) select them. On a DB created from the
current schema `db.prepare` raises `no such column` → 500 at runtime. Either the code is dead/legacy
(to be removed) or it only works on historical DBs: in both cases it is a code/schema divergence that
the auditor must clarify.

### 10.5 "Signed audit log" that is not signed — **unfulfilled claim**
No server-side signing key exists. The chain (`auditChain.ts`) is merely hash-linked; the
`signature` column recycles client request signatures that do not cover the event fields, and many
events have `signature: null` (§2.2). A malicious server can rewrite the entire chain by
recomputing the hashes; the only defense is the client-side saved anchor (`verifyFromAnchor`), which
protects only against rollbacks subsequent to the last check. Furthermore, the hash preimage is a
`|`-concatenation of non-length-prefixed fields (`auditChain.ts:30-39`): `event_type`/
`actor_id`/`payload` containing `|` can create parsing ambiguities (the values are largely
server-controlled, but `payload` includes client input such as `newPublicKey`).

### 10.6 Hand-written Shamir — **unaudited primitive**
See §3: no audited library, no per-share integrity, `combineSecret` does not reject duplicate
x values (division by zero in GF(256) → read of uninitialized `LOG[0]` → silent undefined
output), no constant-time (lookup tables → cache timing, limited relevance
client-side). The TODO at `crypto.ts:111` acknowledges it. To be replaced or thoroughly audited.

### 10.7 Hand-written P-256 in BigInt in the web console
`recovery-console.html:91-102` implements curve arithmetic from scratch (non-constant-time
double-and-add, no point validation). It is used only to derive the pubkey from the seed — but
the seed is the system's ultimate secret and is processed by unaudited code in a browser
context (extensions, cache, devtools). Any divergence from `@noble/curves` here is also a
lock-out risk (different pubkey → different identity).

**Context and decision (M5):**
- The choice to implement the curve arithmetic by hand is DELIBERATE: the console is an emergency
  recovery tool designed to work offline, and Web Crypto does not expose the scalar
  multiplication (priv × G) needed to derive the pubkey. The SIGNATURE instead uses native Web
  Crypto (`crypto.subtle`, ECDSA) — only the pubkey derivation is hand-written.
- Timing side-channel risk: LOW in context. The operation is client-side, on the user's
  device, one-shot (one derivation at startup), so it offers no statistical surface for a
  timing attack; an attacker with code in the page would in any case have direct access to the seed.
- Lock-out risk (MORE CONCRETE): if the hand-written derivation diverges by even one bit from
  `@noble/curves` as used in the app, the same seed produces different identities → auth failure at
  the moment of recovery. MUST BE VERIFIED with an equivalence test (same seed → same compressed
  pubkey in console and app) on a few test seeds.
- Upstream risk (independent of the implementation): the console processes the SEED in a browser
  context (extensions, devtools, cache, and possible tampering with the page if served from an
  untrusted source). This is the greater risk, not the hand-written P-256. Recommendation: open the
  console only from a verified local file or trusted HTTPS, ideally on an offline device.

**Decision:** accepted in the current context (offline-first, signing already native, low timing risk). For
the professional audit: (1) validate console↔app equivalence to rule out lock-out; (2) evaluate
whether to inline `@noble/curves` as a standalone bundle while preserving offline operation; (3)
evaluate hardening of the browser context (how the page is served/opened).

### 10.8 Non-standard identity derivation
`sha256(seed) mod (n−1) + 1` (§9) instead of BIP32/SLIP-10: it works, but it is a custom
construction, without BIP39 passphrase, without the possibility of deriving multiple keys, with a
theoretical modular bias ≈2⁻³². NFKD normalization exists only in the web console, not in the app (`crypto.ts:37`).

### 10.9 48-bit fingerprint
`fingerprint()` truncates SHA-256 to 12 hex = 48 bits (`crypto.ts:46-48`). A second-preimage on 48
bits (~2⁴⁸ key generation attempts) is within reach of a well-equipped adversary who
wants a substituted pubkey to be accepted by someone who only verifies the short fingerprint. The 6-word safety number
(66 bits, `crypto.ts:60-71`) is more robust but below the customary 112 bits (Signal uses
60 digits ≈ 200 bits across both sides). Evaluate lengthening it or making the word comparison mandatory.

### 10.10 Anti-replay state and sessions in memory only
The nonce cache (`auth.ts` middleware, lines 15-32), challenges and sessions (`routes/auth.ts:15-16`)
live in in-process `Map`s: a server restart opens a ±5 min replay window for
already-seen signed requests and invalidates the sessions. With multiple instances behind a load balancer the
anti-replay protection is not shared. (Deterministic ECDSA per RFC 6979 means the same
request produces the same signature: the `pub:ts:sig` cache key works, but only per-process.)

### 10.11 Signatures and metadata in the query string
Authenticated GETs (`/pending`, `/audit/anchor`, `/audit/events`, `/recovery/pending-for-contact`)
carry `pub`, `ts`, `sig` **in the URL** (§2.1): they end up in proxy/reverse-proxy logs and
in history. They do not allow replay beyond the 5 min window (and the nonce cache does not cover GETs:
`checkAndRegisterNonce` is only in the POST middleware — a signed GET is replayable for 5 minutes by
anyone reading the logs in real time). The GET routes furthermore expose data without auth where the
`switchId` alone acts as a capability: `/switch`, `/switch/contents`, `/approval/request`, `/shares`,
`/contacts?ownerId=`, `/vault/view` — the auditor should evaluate the entropy and the circulation of
these IDs (generated with `nanoid(10)`, ~60 bits).

### 10.12 Blobs on Drive public to "anyone with the link"
`googleDrive.ts:88-99` sets the `reader/anyone` permission; the download happens without auth
(`googleDrive.ts:118`). A choice documented in the code (lines 21-26): confidentiality rests 100%
on XChaCha20-Poly1305 + Shamir. Correct on the cryptographic level, but: the fileId is a
permanent capability, the ciphertext remains downloadable forever (no forward secrecy: a future
k-quorum + archived blob = release), and the Drive access patterns are visible to Google.

**Analysis M6 — structural tension (not a bug):**
The obvious mitigation (delete/expire the blob after delivery) requires answering: who has
the authority to delete? Sentinella is a dead-man's switch: the switch goes to RELEASED because
the owner does not respond (arrest, disappearance, death), so the owner is NOT available when the
deletion would be due. Hypotheses evaluated:
- Owner's OAuth token on the server: tokens expire (owner gone = inactive account); and giving the
  server the power to delete on the owner's Drive contradicts the principle (server = opaque
  pointers, no power over content) and opens the door to release sabotage by a compromised
  server.
- Contacts delete: they do not have the owner's Drive credentials; sharing that power reopens the
  problem (whoever can delete can sabotage).
- Native Drive TTL: not reliable, depends on the owner's account being active.
- Rotate the key: protected by distributed Shamir, no central point can rotate it without the
  quorum (= the release itself).
TENSION: forward secrecy requires that someone be able to destroy the blob in the future; the design
denies anyone unilateral power over the data. Every deletion mechanism also grants the power to
sabotage delivery (the primary purpose). Secondary tension: the receiving block allows late
access by the contacts; deleting early cuts off the latecomers, and a deleted blob is
unrecoverable.
DECISION: accepted as a structural trade-off. The system favors reliable delivery over
forward secrecy — a defensible choice for a dead-man's switch. Primary defense: Shamir k-quorum
(k shares are needed in any case to decrypt any copy). True forward secrecy = a different delivery
model (redesign), to be evaluated at the audit.

### 10.13 Minor points
- `to_hash` uses the literal `'salt::'` as a pseudo-salt (`pairing.ts:98`): misleading name, no
  real salt property; the input (`contactId` nanoid) nonetheless makes the output unpredictable.
- Check-in jitter with `Math.random` (§8.2): if it serves an anti-analysis purpose, use a CSPRNG.
- ECDH uses the 33B compressed shared point (prefix included) as HKDF IKM instead of the x
  coordinate alone (X9.63): not a security flaw but non-standard, and it binds any future
  reimplementation (web console, other clients) to reproduce this detail exactly.
- HKDF with `salt = undefined` (`crypto.ts:75`): permitted (zero salt per RFC 5869) but an explicit
  salt/per-message context would be more robust.
- No AAD in any AEAD: the blobs are not cryptographically bound to a switch/context
  (e.g. a sealed share could be re-presented on another switch of the same owner).
- `expo-crypto` dependency declared and never used.
- Single lockfile at the root: `server/` has no lockfile of its own — verify that the server
  deployment uses pinned versions of the crypto libraries.
- The seed remains readable in SecureStore (no non-exportable hardware key); the
  "Secure Enclave/StrongBox" claim in `keystore.ts:1-3` and in the development plan is, as of today, only a comment.

---

*End of inventory. Document generated in preparation for the audit; no code file was modified.*
