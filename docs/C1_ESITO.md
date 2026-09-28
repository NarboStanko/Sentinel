# C1 — Investigation outcome: the KDF for PINs requires a native module

> 🇬🇧 English · [🇮🇹 Italiano](C1_ESITO.it.md)

**Status:** NOT resolved independently — deferred to the professional audit with a reasoned recommendation.

## The problem
`app/lib/pinHash.ts` uses a single sha256(salt + pin). For a 6-digit PIN (10^6 combinations): instant offline brute-force for anyone who extracts the record from SecureStore; a forensic analysis recovers the hashes of the normal PIN and the duress PIN, brute-forces both instantly and tells them apart → the indistinguishability of the duress PIN collapses at the storage level. A slow KDF is needed.

## Benchmark on a real device (Hermes)
KDF in pure JavaScript (@noble/hashes) — UNUSABLE:
- scrypt N=8192: ~6,300 ms (fast phone)
- scrypt N=16384: ~12,600 ms
- scrypt N=32768: ~25,000 ms
- PBKDF2 50,000 iter: ~6,300 ms
- PBKDF2 100,000 iter: ~13,000 ms
- PBKDF2 600,000 iter (OWASP 2023): ~102,000 ms

Iterating native SHA-256 (expo-crypto digest in a loop) — FEASIBLE BUT MEDIOCRE:
- 1,000 iter: 79 ms (fast) / 436 ms (slow)
- 5,000 iter: 333 ms / 867 ms
- 10,000 iter: 636 ms / 1,744 ms
- 20,000 iter: 1,195 ms / 3,386 ms

Observation: on the slow phone the cost is dominated by a fixed JS-native bridge overhead (~330-436 ms just to start), not by the cryptographic work. Every digest call crosses the React Native bridge. You pay a lot of time for little robustness. expo-crypto (already installed) exposes only primitives (getRandomBytes, digestStringAsync, digest, getRandomValues, randomUUID): no KDF with iterations.

## Why iterating SHA-256 is not enough
It is essentially PBKDF1: not memory-hard. An attacker with GPUs/ASICs parallelizes and bypasses the benefit (Argon2/scrypt force the use of memory, neutralizing GPUs). With ~3,000 iterations (the practical limit to stay under ~600 ms on the slow phone) brute-force becomes ~3,000x more expensive: a real but modest improvement against a well-resourced adversary — and the threat model includes well-resourced adversaries. Introducing it would give a false sense of "solved".

## Recommendation for the audit
Correct solution: Argon2id via a native module (a single native call does everything, without crossing the bridge N times → fast and memory-hard). Requires: a trustworthy native KDF library for React Native/Expo (to be evaluated with security expertise), a development build, and an audit of the library itself. Questions for the auditor: (1) which native Argon2/scrypt library is trustworthy and maintained? (2) Argon2id parameters for a 6-digit PIN in this threat model? (3) is iterating native SHA-256 (~3,000 iter) an acceptable stopgap in the meantime? (4) migration strategy for existing PINs and hardening of the normal/duress uniformity.

## Migration (when implemented, whatever the KDF)
Versioned hash format: v1$<sha256> legacy, v2$<params>$<hash> new. Verification reads the prefix and uses the right method. CRITICAL POINT for duress: the migration must keep the normal PIN and the duress PIN always at the same version — never one v1 and one v2 — otherwise a forensic analyst infers the existence of the second PIN. Safer approach: new PINs in v2; for existing ones, an explicit "upgrade PIN security" operation that requires re-entering all PINs together and rewrites them uniformly. Mandatory re-test of both duress modes after the migration.
