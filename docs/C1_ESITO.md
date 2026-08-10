# C1 — Esito dell'indagine: la KDF per i PIN richiede un modulo nativo

**Stato:** NON risolto in autonomia — rimandato all'audit professionale con raccomandazione motivata.

## Il problema
`app/lib/pinHash.ts` usa una singola sha256(salt + pin). Per un PIN di 6 cifre (10^6 combinazioni): brute-force offline istantaneo per chi estrae il record da SecureStore; un'analisi forense recupera gli hash del PIN normale e del PIN duress, li brute-forza entrambi all'istante e li distingue → l'indistinguibilità del duress crolla a livello di storage. Serve una KDF lenta.

## Benchmark su dispositivo reale (Hermes)
KDF in JavaScript puro (@noble/hashes) — INUTILIZZABILE:
- scrypt N=8192: ~6.300 ms (telefono veloce)
- scrypt N=16384: ~12.600 ms
- scrypt N=32768: ~25.000 ms
- PBKDF2 50.000 iter: ~6.300 ms
- PBKDF2 100.000 iter: ~13.000 ms
- PBKDF2 600.000 iter (OWASP 2023): ~102.000 ms

Iterazione di SHA-256 nativo (expo-crypto digest in loop) — PRATICABILE MA MEDIOCRE:
- 1.000 iter: 79 ms (veloce) / 436 ms (lento)
- 5.000 iter: 333 ms / 867 ms
- 10.000 iter: 636 ms / 1.744 ms
- 20.000 iter: 1.195 ms / 3.386 ms

Osservazione: sul telefono lento il costo è dominato da un overhead fisso del bridge JS-nativo (~330-436ms per avviare), non dal lavoro crittografico. Ogni chiamata digest attraversa il bridge React Native. Si paga molto tempo per poca robustezza. expo-crypto (già installato) espone solo primitive (getRandomBytes, digestStringAsync, digest, getRandomValues, randomUUID): nessuna KDF con iterazioni.

## Perché l'iterazione di SHA-256 non basta
È essenzialmente PBKDF1: non memory-hard. Un attaccante con GPU/ASIC parallelizza e aggira il beneficio (Argon2/scrypt costringono a usare memoria, neutralizzando le GPU). Con ~3.000 iterazioni (limite pratico per restare sotto ~600ms sul telefono lento) il brute-force diventa ~3.000x più costoso: miglioramento reale ma modesto contro un avversario con risorse — e il threat model include avversari con risorse. Introdurla darebbe un falso senso di "risolto".

## Raccomandazione per l'audit
Soluzione corretta: Argon2id via modulo nativo (una singola chiamata nativa fa tutto, senza attraversare il bridge N volte → veloce e memory-hard). Richiede: una libreria KDF nativa affidabile per React Native/Expo (da valutare con competenza di sicurezza), un development build, e l'audit della libreria stessa. Domande per l'auditor: (1) quale libreria Argon2/scrypt nativa è affidabile e mantenuta? (2) parametri Argon2id per un PIN a 6 cifre in questo threat model? (3) l'iterazione di SHA-256 nativo (~3.000 iter) è un tampone accettabile nel frattempo? (4) strategia di migrazione dei PIN esistenti e blindatura dell'uniformità normale/duress.

## Migrazione (quando si implementerà, qualunque KDF)
Formato hash versionato: v1$<sha256> legacy, v2$<params>$<hash> nuovo. Verifica che legge il prefisso e usa il metodo giusto. PUNTO CRITICO duress: la migrazione deve mantenere PIN normale e PIN duress sempre nella stessa versione — mai uno v1 e uno v2 — altrimenti un analista forense deduce l'esistenza del secondo PIN. Approccio più sicuro: nuovi PIN in v2; per gli esistenti, operazione esplicita "aggiorna sicurezza PIN" che richiede di reinserire tutti i PIN insieme e li riscrive uniformemente. Ri-test obbligatorio di entrambe le modalità duress dopo la migrazione.
