# Sentinella — Audit findings and remediation plan

> 🇬🇧 English · [🇮🇹 Italiano](FINDINGS_TRIAGE.it.md)

## Final status of the autonomous audit (August 2026)

**CRITICAL:**
- **C1 (PIN with single SHA-256):** INVESTIGATED, requires a native module. On-device benchmarks show that no build-free KDF is viable on Hermes (scrypt/PBKDF2 in JS = seconds; native SHA-256 iteration dominated by bridge overhead). Deferred to the professional audit. See [docs/C1_ESITO.md](C1_ESITO.md). Documentation commit.
- **C2 (decoys distinguishable by the server):** RESOLVED and verified E2E on 3 devices. Index x removed from the wire at arm time; x lives inside the encrypted blob; the arm schema `.strict()` rejects x. Commit 7890f46.
- **C3 (server learns k):** RESOLVED phase 1. recoveryK no longer sent at arm time; recovery_k uses default 2. Phase 2 (decoupled recovery-quorum UI) deferred. Commit 906fc12.

**HIGH:**
- **A1 (threshold_k nonexistent column):** RESOLVED. It broke restore-from-seed. Commit 0e79190.
- **A2 (anti-replay in memory only):** RESOLVED. Nonce cache moved from an in-memory Map to the SQLite table `seen_nonces` (atomic INSERT OR IGNORE), survives restarts. Commit 1d8832d.
- **A3 (leftover session token):** RESOLVED. The 2 `/audit/*` routes switch from session tokens to per-request signatures; the 2 events (BACKUP_VIEWED, RECOVERED_DURING_PENDING) now enter the chain SIGNED. Removed sessions/verifySession/token. Auth unified on per-request signatures. Verified E2E (restore + backup on device). Commit 766a2dc.

**MEDIUM:**
- **M1 (decoy shuffle with Math.random):** RESOLVED. Fisher-Yates with secure entropy (randomBytes) + rejection sampling. Empirical proof: the bias of the old `sort(Math.random-0.5)` was 77.6%, the new one 1.28%. Commit a93c2ee.
- **M2 (Math.random in checkin jitter):** ASSESSED non-critical. The jitter is anti-thundering-herd (load distribution), not a security countermeasure. Documented in the code. Closed.
- **M3 (48-bit safety number):** FALSE ALARM. The pairing safety number uses `safetyNumber()` = 66 bits (6 BIP39 words, commutative ordering), which is adequate. The "48 bits" was `fingerprint()`, a function NOT used in production (dead code), removed. Commit 1d8832d.
- **M4 (misleading "signed audit log" naming):** OPEN, documentation only. Not a bug: it is a hash-linked chain + request signatures; automatic events have signature null by design (the server must not be able to sign). Align naming/docs.
- **M5 (P-256 hand-reimplemented in the web console):** ASSESSED — deliberate offline-first choice, native signing, low timing risk; lock-out risk to be tested, browser-context risk to be hardened at audit time. See CRYPTO_INVENTORY.md §10.7.
- **M6 (Drive blobs "anyone with link", no forward secrecy):** ASSESSED — accepted structural trade-off: forward secrecy would require a deletion power that would weaken delivery (the primary purpose) or give the server power over the data. Primary Shamir defense intact. Redesign (not a fix) for true forward secrecy. See CRYPTO_INVENTORY §10.12.

**PRACTICAL NOTES (not audit findings):**
- Facade-token cache at bootstrap: `isFacadeActive` is sometimes true before unlock → push token registration fails with "Connessione non disponibile" (cosmetic, the token registers after unlock). Not fixed, noted.
- Migration of nullable `shares.x` in production: the CREATE IF NOT EXISTS schema does not update existing DBs; in dev the DB is recreated, in production an ALTER migration will be needed. TODO.

**SUMMARY:** all critical and high findings are addressed (C2/C3/A1/A2/A3 resolved, C1 documented for audit). Real medium findings resolved (M1) or clarified (M2/M3). Remaining: M4 (docs), M5/M6 (specialist assessments) for the professional audit.

---

Outcome of the triage of the findings that emerged from the cryptographic inventory (July 2026).
Each entry was investigated: status (real / false alarm / to verify), severity, and notes for the fix.

The suggested order of work is by severity and by regression risk: first what breaks declared security guarantees, but tackling each entry calmly and with tests, not in bulk.

---

## Critical — break declared security guarantees

### C1 — PINs hashed with a single SHA-256
**Status:** real, confirmed (`pinHash.ts`). **UPDATED (August 2026):** investigated, not solvable without a native module. See [docs/C1_ESITO.md](C1_ESITO.md). Deferred to the professional audit with supporting benchmarks.
**Impact:** a 6-digit PIN has 10^6 combinations; with a single SHA-256, anyone who extracts the record from SecureStore can try them all in a fraction of a second. **Most serious consequence:** a forensic analysis recovers both the normal PIN and the duress PIN, and being able to distinguish them defeats the storage-level indistinguishability of duress — precisely the guarantee the coercion mode promises.
**Fix:** replace with a slow, salted KDF — Argon2id (preferred) or PBKDF2 with a high iteration count. Random per-PIN salt, already present in the record.
**Caution:** this touches the storage of existing PINs. A **migration** is needed: already-set PINs are hashed with the old scheme. Plan a re-hash on the first successful unlock, or force a reset. Must be designed carefully so as not to lock the user out. **Do not rush this.**

### C2 — Decoys are distinguishable by the server
**Status:** real (real share indices `x = 1…N`, decoys `x = 100+j`, `x` in cleartext in the `shares` table). **UPDATED (August 2026):** DONE and verified E2E on 3 devices. Commit 7890f46. Index x removed from the wire at arm time; x lives inside the encrypted blob; the arm schema `.strict()` rejects x.
**Impact:** a compromised server distinguishes real shares from decoys by looking at the index, and by counting the real ones it learns N. This contradicts the comment in `db.ts` and guarantee 3.3 of the threat model.
**Fix:** assign the decoys indices in the same space as the real shares, or make the shares uniformly opaque to the server. Verify that client-side recombination still selects the correct shares.

### C3 — The server learns k (the threshold)
**Status:** real (`compose.tsx` sends `recoveryK: threshold`; `/switch/arm` persists it in `users.recovery_k`). **UPDATED (August 2026):** DONE phase 1. Commit 906fc12. recoveryK no longer sent at arm time; recovery_k uses default 2. Phase 2 (decoupled recovery-quorum UI) deferred.
**Impact:** the server knows how many contacts are needed for the release — information that the declared invariant (`switch.ts:46`, "k is NOT sent to the server") denies. Divergence between code and model.
**Fix:** decide which of the two is the intended truth. If k must remain private from the server, remove the sending and manage the threshold client-side / inside the encrypted material. If the server legitimately needs `recovery_k` for social recovery (which is a different thing from the Shamir threshold of the content), then separate the two concepts and correct the misleading comment. **Clarify the model first, then the code.**

---

## High — functional bugs

### A1 — `threshold_k`: nonexistent column in the /auth/verify query
**Status:** real. **FIX APPLIED** (removed from the SELECT).
**Was:** the restore-from-seed query selected a missing column → SQL error → identity recovery flow broken for owners with a switch. The client did not use the field.

### A2 — Anti-replay in memory only
**Status:** to be confirmed, plausible.
**Impact:** the anti-replay nonce cache is in memory; on server restart it is cleared, reopening a window in which already-seen signed requests could be replayed (within the timestamp validity window).
**Fix:** consider persisting the nonce cache, or accept the risk and document it (the window is limited by the timestamp TTL, ±5 min). Cost/benefit decision.

### A3 — Leftover session-token authentication
**Status:** real but limited in scope. Investigated: `sessions` is used only in `/auth/verify` (restore) and does not protect critical routes (which use per-request signatures). It is NOT a bypass of sensitive actions.
**Impact:** low. It is unnecessary surface: a secondary auth model that lives only for the restore flow.
**Fix:** evaluate whether the restore flow can use per-request signatures like everything else, eliminating `sessions`/`challenges` and the expiring token. Reduces surface, not urgent.

---

## Medium — hardening

### M1 — Decoy shuffle with `Math.random`
`sort(() => Math.random() - 0.5)` does not produce uniform permutations and is non-cryptographic. Replace with Fisher-Yates over a secure source. Relevant because the order of the shares could be observable.

### M2 — Math.random in crypto-adjacent contexts
The inventory reports 4 uses of `Math.random`. Verify each one: if it touches material that must be unpredictable (share order, ids, jitter), replace with a secure source. If it is only UI/cosmetics, note it as harmless.

### M3 — Fingerprint/safety number truncated to 48 bits
48 bits of safety number: assess whether it is sufficient against targeted collision attacks during pairing. Compare with established practice (Signal uses longer numbers). Possible lengthening.

### M4 — "Signed audit log" without a server signing key
Misleading naming: there is no server signature (a correct and documented choice — the server must not be able to sign). It is a hash-linked chain + the user's request signatures, often NULL for automatic events. **Not a bug**, but align the naming and the documentation so as not to mislead the auditor.

### M5 — P-256 hand-reimplemented in the web console
The verification web console reimplements P-256 in BigInt instead of using a library. Error surface. If the web console is an accessory tool, assess its actual use; if it is needed, use an audited library.

### M6 — Drive blobs "anyone with link"
The blobs on Drive are shared by link. Documented choice (confidentiality lies in the encryption, not in the ACL), but without forward secrecy: if the content key leaks in the future, an archived blob remains decryptable. Note in the threat model as an accepted limitation or consider rotation.

---

## False alarms (closed)

- **`drive_pointer` nonexistent column in `switches`:** false alarm. The column was moved to `switch_contents` during a refactoring; the two `ALTER TABLE switches DROP COLUMN` in `db.ts` handle the migration. The code reads `drive_pointer` from the correct table.

---

## Suggested order of work

1. **A1** — done.
2. **C3** — clarify the model (k at the server): it is conceptual, unlocks the understanding of C2.
3. **C2** — indistinguishable decoys: touches the share logic, must be tested with the release flow.
4. **C1** — KDF for the PINs: the most important, but with a delicate migration. Dedicated session, with a fresh mind, with duress tests afterwards.
5. **A2, M1, M2** — hardening of entropy and replay, can be grouped.
6. **M3–M6, A3** — refinements and surface reduction, once the rest is stable.

**Method note:** every fix of a critical finding must be followed by an end-to-end verification of the affected flow. C1 in particular is not considered closed until duress has been re-tested on the device (facade + trigger + lockout) after the PIN migration.
