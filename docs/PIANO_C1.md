# Plan C1 — PIN with slow KDF (scrypt) + versioned migration

> 🇬🇧 English · [🇮🇹 Italiano](PIANO_C1.it.md)

**To be tackled with a fresh mind.** This is the most delicate fix of the audit: it touches the storage of the PINs that protect the app. The typical failure mode is not a visible bug but *locking the user out* or *making the duress PIN distinguishable*. No rush.

## Why

Today `pinHash.ts` does a single `sha256(salt + pin)`. Two problems:
1. A 6-digit PIN = 10^6 combinations; a single SHA-256 = instant offline brute force for anyone who extracts the record from SecureStore.
2. **Severe:** a forensic analysis recovers the hashes of both the normal PIN and the duress PIN, brute-forces both instantly, and figures out which one triggers the countermeasure. The indistinguishability of the duress PIN — carefully maintained across UI, network, decoys — collapses here, at the last link.

## What is already in place (verified)

- `@noble/hashes` installed, with `scrypt.js` present → **scrypt in pure JS, no native module, no build**. Fully testable via Metro.
- Current `pinHash.ts`:
  ```ts
  import { sha256 } from '@noble/hashes/sha256';
  import { bytesToHex } from '@noble/hashes/utils';
  export function hashPin(salt: string, pin: string): string {
    return bytesToHex(sha256(new TextEncoder().encode(salt + pin)));
  }
  ```
- Only three call sites: `app/app/lock.tsx` (unlock), `app/app/backup.tsx` (backup PIN), `app/app/duress-setup.tsx` (duress PIN). No hidden spots.

## KDF choice: scrypt (not Argon2, not PBKDF2)

- Argon2id would be slightly preferable but is not in `@noble/hashes` → it would require a native lib → a build. Discarded.
- scrypt is **memory-hard** (resists GPU/ASIC), better than PBKDF2 (CPU-hard only) against well-resourced adversaries — consistent with the threat model.
- `@noble/hashes/scrypt` exposes `scryptAsync(pwd, salt, opts)` → use the async version so the UI is not blocked (the hash MUST be slow, ~100-250ms).

## Versioned hash format

Every stored hash carries a version prefix, so legacy and new hashes coexist and the parameters remain readable:
- Legacy: `v1$<sha256hex>` (or no prefix = implicitly v1)
- New: `v2$<N>$<r>$<p>$<scrypthex>` — the parameters INSIDE the string, so if they are raised someday the old v2 hashes remain verifiable.

## scrypt parameters (to be MEASURED on the device)

Starting point: N=2^15 (32768), r=8, p=1, dkLen=32. Target ~100-250ms per hash on a real phone.
**They must be measured**: on a slow phone they might be too much. Add a temporary log of the hash time at the first unlock and tune. If too slow, go down to N=2^14; if too fast, go up to N=2^16.

## Migration: transparent, versioned re-hash

When verifying a PIN:
1. Read the prefix of the stored hash.
2. If `v1` (or no prefix) → verify with sha256 (old method). If it matches: user authenticated **and** flag `needsMigration = true`.
3. If `v2` → verify with scrypt.
4. After a successful verification with `needsMigration`, re-hash the PIN with scrypt (v2) and overwrite the storage.

This way existing PINs keep working and migrate automatically at the first successful unlock. **Nobody gets locked out.**

## THE CRITICAL POINT — the duress PIN must not become distinguishable

Risk: if only the PIN the user actually uses to unlock (the normal one) migrates and NOT the duress PIN, the storage ends up with one v2 hash (normal) and one v1 hash (duress) → a forensic analyst sees a PIN that never migrated → **infers the existence of the duress PIN**. This destroys the purpose of the fix.

Two possible strategies — DECIDE deliberately:
- **(a) Simultaneous migration:** at the first unlock with the normal PIN, re-hash the duress PIN (and the backup one) to v2 AS WELL without knowing its cleartext value. BUT scrypt needs the cleartext PIN to re-hash: if the duress PIN is unknown (the user has not just entered it), it cannot be re-hashed. So pure (a) is not possible without the value.
- **(b) Lazy but uniform migration:** each PIN migrates when it IS ENTERED AND VERIFIED. As long as both are v1, they are indistinguishable (both old). The risk is the window in which one is v2 and the other v1. Mitigation: **as long as they cannot ALL be migrated together, leave them all in v1** — that is, do not migrate at the first unlock, but only when uniformity can be guaranteed. Or: at the next SETUP/CHANGE of the PINs (where the user re-enters both), write both in v2.

**Recommended approach (safer):** do NOT migrate automatically on unlock. Instead:
- All NEW PINs (set from now on) use v2.
- For existing PINs: at the next explicit change (the user changes a PIN / reconfigures duress), rewrite in v2. Until then they stay v1 — but they *both* stay v1, hence indistinguishable from each other.
- Alternatively, offer an "upgrade PIN security" option that asks the user to re-enter ALL the PINs (normal + duress + backup) in a single operation and rewrites them all in v2 together. Uniform by construction.

This entirely avoids the distinguishability window. Take the time to evaluate which of the two: uniform lazy migration, or an explicit "upgrade all PINs together" operation.

## Structure of the new pinHash.ts

- `hashPinV2(salt, pin): Promise<string>` — async scrypt, returns `v2$N$r$p$<hex>`
- `hashPinV1(salt, pin): string` — the old sha256, INTERNAL, used only to verify legacy hashes
- `verifyPin(stored, salt, pin): Promise<{ valid: boolean; version: 'v1'|'v2' }>` — reads the prefix, verifies with the right method
- The call sites become async (lock/backup/duress-setup already perform async operations, manageable)

## Implementation order

1. Rewrite `pinHash.ts` with the three functions + versioned format. Do NOT remove the ability to verify v1.
2. Update the 3 call sites: setup → v2; verification → `verifyPin`.
3. Measure the hash time on a real phone, tune the parameters.
4. Decide on and implement the migration strategy (recommended: no auto-migrate on unlock; v2 for new PINs + explicit uniform operation for the old ones).
5. `npx tsc --noEmit` clean.

## MANDATORY re-test afterwards (C1 is not closed without it)

On a real device, with Metro:
- Unlock with an existing normal PIN → works (v1 or v2 verification depending on the strategy).
- Set a new PIN → saved in v2 → unlock works.
- **Duress mode A (facade):** enter the duress PIN → the facade starts correctly → exit with the normal PIN.
- **Duress mode B (trigger):** enter the duress PIN → the trigger fires → the switch goes to APPROVAL_PENDING.
- **Lockout:** repeated wrong PINs → exponential lockout works.
- **Indistinguishability:** verify that in storage the normal PIN and the duress PIN have the SAME version format (both v1 or both v2) — never one v1 and one v2.

Only when all of these pass is C1 closed. Then commit + update FINDINGS_TRIAGE (C1 done).

## Implementation prompt (use with a fresh mind)

To be written at the start of the fresh session, with the stop at the top. Do NOT hand it over in a rush: first have the scrypt parameters measured on the phone, then decide the migration strategy, THEN implement.
