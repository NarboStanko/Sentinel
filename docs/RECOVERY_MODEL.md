# Sentinella — Identity recovery model

> 🇬🇧 English · [🇮🇹 Italiano](RECOVERY_MODEL.it.md)

**Status:** analysis complete, decision made (Option 1), Part A done (commit 6b4851e), server flow validated in a partial test. Parts C/D/E to be done in a dedicated session (see section 6). Before resuming: clean reset of DB + phones.
**Why documented:** it touches the most delicate security flow in the system (identity recovery). A mistake here = the user loses access, or an attacker steals an account. It deserves a fresh mind and, ideally, a professional auditor's eye.

---

## 1. Two distinct mechanisms (do not confuse them)

Sentinella has TWO ways to regain control after losing the phone. They serve different cases.

### Restore from seed (already working, tested E2E)
- **Assumption:** you still have the seed phrase.
- **How:** on a new device you re-enter the seed → `identityFromSeed` regenerates the SAME key (priv/pub are derived from the seed). Challenge-response (`/auth/challenge` + `/auth/verify`) proves possession. You are back in immediately.
- **No quorum, no delay.** If you have the seed, you are you, period.
- Files: `restore.tsx`, `auth.ts`.

### Social recovery (key rotation, BROKEN today)
- **CORRECT assumption:** you have lost the phone AND the seed. You have a NEW seed → new identity (key B, ownerId_B).
- **Purpose:** transfer control of the old account (ownerId_X, controlled by the lost key A) to the new key B.
- **How:** `/recovery/initiate` (pins the new_public_key = B) → contacts approve (`/recovery/approve`, quorum = recovery_k) → 7-day delay → `/recovery/finalize` rotates `users.public_key` from A to B.
- **Server invariant (finalize):** rotates ONLY the public key. It does not touch the DEK, the Shamir shares, or switch state. Switches keep running; the shares (sealed to the contacts) remain valid.
- **Brakes:** blocked if a switch is in GRACE/APPROVAL_PENDING; cancelable (`/recovery/cancel`) by whoever still holds key A (signs the recoveryId).
- Files: `recovery.ts`, `social-recovery.tsx`.

**Fundamental clarity:** the contacts do NOT give you your identity back (key A, derived from the lost seed, is unrecoverable forever). They authorize the TRANSFER of the account to the new key B.

---

## 2. The model flaws of the current social recovery

### Flaw 1 — The new device does not know the old ownerId
`social-recovery.tsx` InitiateSection does `loadOwnerId()` + `identityFromSeed(loadSeed())` of the CURRENT device. But in the real scenario (new device, new seed), `loadOwnerId()` is the NEW ownerId, not the old ownerId_X to be recovered. The UI text says "you have access to the seed phrase" — which is the RESTORE case, not recovery. Real ambiguity.

**Decision made:** the old ownerId is provided by the contacts. They have it in their own trusted contacts.
**Later discovery (simplifies things):** the contact does NOT need to communicate it manually. `ApproveSection` uses `recoveryPendingForContact` — the server automatically shows the contact the pending recovery requests that concern them (authenticated with the contact's signature). So the approval flow is already automatic. What remains to be solved is how the INITIATING DEVICE specifies ownerId_X: the initiate UI must ASK for the old ownerId (input field), not use loadOwnerId().

### Flaw 2 — The contacts' trust still points to key A (THE CRITICAL KNOT)
The contact stores in SecureStore `verified_owner_key = A` (keystore.ts:83, a single string), verified IN PERSON at pairing. `approve.tsx` compares the owner key against this local copy ("Owner key not verified. Repeat the in-person pairing").

After the rotation, the server has B but every contact still has A locally → the comparison fails → the contact can NO longer operate for the new owner.

**How does the contact move from A to B?** This is THE security decision of the recovery.

---

## 3. Decision: Option 1 (social trust)

**Choice:** approving the recovery IS the new verification. When the contact approves (an explicit act, signed with their device) and the recovery is finalized, the contact's app locally updates `verified_owner_key` from A to B.

**Security entrusted to:** quorum (k contacts must approve) + 7-day delay + cancel signed with key A.

**Accepted trade-off:** the contact does NOT compare B's safety number in person. They trust that whoever initiated the recovery is the owner, based on the fact that they know ownerId_X and that the quorum agrees. This is the model of social recovery wallets (Argent, etc.).

**Documented residual risk:** if an attacker (a) discovers ownerId_X, (b) deceives/compromises k contacts, (c) the owner does not cancel within 7 days (because they really did lose key A, so they CANNOT cancel) → account theft. Defense = quorum + 7-day window. For k=2 against a capable adversary this is a real, non-trivial risk. **This is the risk class that the professional audit should validate.**

**Discarded options:**
- Option 2 (in-person re-verification of B): very secure but hollows out the point of recovery (if you have to meet everyone again, you might as well redo the pairing).
- Option 3 (restore access but not contact trust): in the Sentinella case, where the whole purpose IS involving the contacts, it leaves the system half-working.

---

## 4. Implementation plan (in stages, with gates and separate commits)

Each part must be tested and committed before the next. Part C is the dangerous one: test E2E with care.

### Part A — Initiate UI asks for the old ownerId (Flaw 1)
- `social-recovery.tsx` InitiateSection: add an input field "ownerId to recover". Do not use the device's `loadOwnerId()`.
- `identityFromSeed(loadSeed())` stays (the new key B is the new device's key). But the target ownerId comes from the input.
- `api.recoveryInitiate(ownerIdInput, newPubHex)`.
- Clarify the text: "Use this section if you lost both phone AND seed. Enter your old account ID (your trusted contacts can tell it to you)."

### Part B — (already covered)
The contact sees pending requests automatically via `recoveryPendingForContact`. Only verify that the list shows enough context (owner name, date) for an informed approval. Optionally: show the contact the ownerId of the owner under recovery, so they can communicate it (useful for Part A).

### Part C — Trust update after finalization (Flaw 2, THE HEART)
- Upon finalization of the recovery, the app of EVERY contact who approved must update `verified_owner_key` from A to B.
- **Problem:** how does the contact know that the recovery has been finalized and what B is? Options:
  - The contact, when opening the app, checks the status of the recoveries they approved; if finalized, they read the new_public_key (B) from the server and update the local copy.
  - **Security WARNING:** reading B "from the server" and trusting it blindly would reintroduce the risk of a compromised server substituting the key. BUT in the Option 1 model trust comes from having approved: the contact updates to B ONLY if they have their own `recovery_approvals` entry for that recovery, and B = the new_public_key that was pinned at initiate (immutable). Verify that new_public_key cannot be modified after initiate.
  - An endpoint like `/recovery/status` is needed which, for an authenticated contact who approved, returns { finalized, newPublicKey }.
- After the local update, `approve.tsx` will compare against B and will work.
- **Mandatory E2E test:** after the recovery, the contact must be able to approve a release of the NEW owner without "key not verified".

### Part D — Full E2E test
- Delay: `initiate` does not expose delaySec from the client (uses the 7-day default). To test, force `unlock_at` in the DB after initiate:
  `UPDATE recoveries SET unlock_at = 0 WHERE id = '<recoveryId>';` (.cjs script)
- Choreography: T1 = owner (key A). Simulate loss: new device/reset with a NEW seed → key B. Initiate toward ownerId_X (old). T2/T3 approve. Force unlock_at=0. Finalize. Verify: B controls the account; T2/T3 can operate for B (Part C works).

### Part E — recovery_k quorum UI (the ORIGINAL goal of C3 phase 2)
- Only AFTER the recovery works E2E with the default of 2.
- UI where the user chooses recovery_k (bounded by the number of contacts). Dedicated endpoint that updates users.recovery_k, decoupled from the content threshold (C3 phase 1 already done).
- Explain clearly the difference between "contacts to release the documents" (content k) and "contacts to recover the identity" (recovery_k), or the user will confuse them.

---

## 5. Security notes for the audit

- Validate the Option 1 model: is the risk "k deceived contacts + owner cannot cancel" acceptable for the threat model?
- `/recovery/initiate` is anonymous (whoever lost the key cannot sign). Anyone who knows an ownerId can initiate a recovery. Defense: quorum + delay + cancel. Validate.
- `/recovery/finalize` is anonymous but harmless (it rotates toward the already-pinned new_public_key anyway; the delay+quorum+no-inflight checks do the work).
- Verify that `new_public_key` is IMMUTABLE after initiate (if modifiable, an attacker could change the target after the contacts have approved).
- Part C: the local trust update must happen ONLY for contacts who actually approved, and toward the immutable new_public_key — never an arbitrary key provided by the server.

---

## 6. Partial test outcome (analysis session)

**Part A: DONE and committed (6b4851e).** InitiateSection now asks for the old ownerId via input instead of using the device's loadOwnerId(). UI text clarified ("phone AND seed lost" scenario). tsc clean. Contact trust NOT touched.

**Server flow initiate→approve→finalize: VALIDATED (partial test, delay forced).**
- Recovery started from a device with Part A, entered T1's ownerId (usr_mglsq2pN0o).
- Contacts approved (quorum reached).
- unlock_at forced to 0 in the DB (bypass of the 7-day delay, dev trick).
- finalize executed: `users.public_key` correctly rotated to the new_public_key (verified: user.public_key === rec.new_public_key, finalized=1).
- CONCLUSION: the server-side rotation mechanics work.

**The Part C wall: CONFIRMED empirically.**
- After the rotation, T1 (which had key A) can no longer arm: the server recognizes key B as the owner, no longer A. Devices with the old trust relationship are misaligned.
- This confirms Flaw 2: the server-side rotation does NOT update the contacts' local trust (verified_owner_key remains A). Part C is needed to realign.

**Test caveat:** the "new device with new seed" scenario was NOT simulated cleanly — the new_public_key used (034abb...) was an identity already existing in the scenario, not a fresh key. The DB and phones are now in a "dirty" state (mixed identities, rotation without Part C).

**For the next session (Part C + D):**
1. START OVER from a CLEAN DB and phones (full reset: delete sentinella.db*, recreate, wipe app data on the 3 phones, redo onboarding + pairing with in-person verification).
2. Simulate cleanly: one dedicated device (or a reset T1) with a NEW seed = fresh key B. The other two = contacts who approve.
3. Implement Part C (see section 4): /recovery/status endpoint that, for a contact who approved, returns {finalized, newPublicKey}; the contact's app, upon finalization, updates verified_owner_key from A to B ONLY if they approved AND toward the immutable new_public_key. First verify that new_public_key is immutable after initiate.
4. Full E2E test: after the recovery, the contact MUST be able to operate for the new owner (B) without "key not verified".
5. Then Part E (recovery_k quorum UI), the original goal of C3 phase 2.

## 7. REVISION — reading the code overturns Part C

**Discovery: the "Part C wall" for the contacts does NOT exist. Part C (updating the contacts' trust) is NOT needed.**

Analysis of the actual code:
- approve.tsx: the contact loads verifiedOwnerKey but uses it ONLY as an existence gate (if (!verifiedOwnerKey)); it does NOT compare it against the owner key from the server. Comment in the code (lines 29-30): "never uses the owner key from the push payload or from the server". The contact's operations (findMyShare with id.priv, decryption, submit) use their OWN private key, never the owner's.
- p256.verify is not called by any client screen to validate owner signatures.
- approvals.ts (server): approvals work by switchId and encrypted shares (addressed to the contact's key); the contact-owner link is by owner_id, IMMUTABLE across the rotation (only public_key changes).

Consequence: after the A→B rotation, the contact keeps operating without any changes. No contact-side fix.

Reinterpretation of the observed "wall": T1 could no longer arm because it had the OLD key A and the server now recognizes B as the owner. CORRECT behavior (the old device is no longer the owner), not a flaw.

**The REAL flaw (which also affects restore-from-seed on a new device):**
- restore.tsx restores ownerId + switchId from the server (authVerify also returns switches), but does NOT restore verified_contact_keys (local in SecureStore, lost with the old device).
- compose.tsx: to arm, a chosen contact must be in verifiedKeys (verified in person). On a new device it is EMPTY.
- So the new owner regains access + EXISTING switches (already-sealed shares keep working), but must re-verify contacts in person to arm NEW switches.
- This is CORRECT and INTENDED behavior: in-person verification must not survive a device change (otherwise a compromised server could inject fake contact keys).

**Final picture of the recovery:**
1. Contacts after the rotation: they work, no fix needed.
2. New owner regains access/switches: via login with B (same authChallenge/authVerify flow as restore).
3. New owner must re-verify contacts to arm NEW switches: correct/intended.
4. Part C (contact trust update): NOT necessary, ABANDONED.

**Done in this session:**
- /recovery/status (C.1) implemented then REMOVED (not necessary). Commit 3522893.
- C3 phase 2 closed with a DYNAMIC quorum instead of a UI: recovery_k computed at finalize as min(n, max(2, ceil(n/2))) over the current contacts, with an n=0 guard. users.recovery_k deprecated (inert). Commit 3522893.
- Part A (initiate asks for the ownerId) remains valid. Commit 6b4851e.

**What remains (minor UX only):**
- Clear message after the recovery: inform the new owner that they must re-verify contacts in person to arm new switches (not a cryptic error).
- Warning for the n=1 contact case: quorum=1 is weakly secure (a single contact can initiate the rotation); flag it.

**Method lesson:** the high-level analysis had hypothesized a flaw ("the contacts break") that reading the code disproved. Reading the code before implementing avoided building a complex, useless Part C in a security flow. Less surface, not more.
