# Piano C1 — PIN con KDF lenta (scrypt) + migrazione versionata

**Da affrontare a mente fresca.** È il fix più delicato dell'audit: tocca lo storage dei PIN che proteggono l'app. L'errore-tipo non è un bug visibile ma *chiudere fuori l'utente* o *rendere il duress distinguibile*. Nessuna fretta.

## Perché

Oggi `pinHash.ts` fa una singola `sha256(salt + pin)`. Due problemi:
1. PIN di 6 cifre = 10^6 combinazioni; SHA-256 singola = brute force offline istantaneo per chi estrae il record da SecureStore.
2. **Grave:** un'analisi forense recupera hash del PIN normale e del PIN duress, li brute-forza entrambi all'istante, e capisce quale attiva la contromisura. L'indistinguibilità del duress — curata su UI, rete, esche — crolla qui, all'ultimo anello.

## Cosa c'è già (verificato)

- `@noble/hashes` installato, con `scrypt.js` presente → **scrypt in JS puro, nessun modulo nativo, nessun build**. Tutto testabile via Metro.
- `pinHash.ts` attuale:
  ```ts
  import { sha256 } from '@noble/hashes/sha256';
  import { bytesToHex } from '@noble/hashes/utils';
  export function hashPin(salt: string, pin: string): string {
    return bytesToHex(sha256(new TextEncoder().encode(salt + pin)));
  }
  ```
- Tre soli call site: `app/app/lock.tsx` (sblocco), `app/app/backup.tsx` (PIN backup), `app/app/duress-setup.tsx` (PIN duress). Nessun punto nascosto.

## Scelta KDF: scrypt (non Argon2, non PBKDF2)

- Argon2id sarebbe leggermente preferibile ma non è in `@noble/hashes` → richiederebbe lib nativa → build. Scartato.
- scrypt è **memory-hard** (resiste a GPU/ASIC), meglio di PBKDF2 (solo CPU-hard) contro avversari con risorse — coerente col threat model.
- `@noble/hashes/scrypt` espone `scryptAsync(pwd, salt, opts)` → usare l'async per non bloccare la UI (l'hash DEVE essere lento, ~100-250ms).

## Formato hash versionato

Ogni hash memorizzato porta un prefisso di versione, così legacy e nuovi convivono e i parametri restano leggibili:
- Legacy: `v1$<sha256hex>` (o nessun prefisso = implicitamente v1)
- Nuovo: `v2$<N>$<r>$<p>$<scrypthex>` — i parametri DENTRO la stringa, così se un domani li si alza i vecchi hash v2 restano verificabili.

## Parametri scrypt (da MISURARE sul dispositivo)

Punto di partenza: N=2^15 (32768), r=8, p=1, dkLen=32. Target ~100-250ms per hash su telefono reale.
**Vanno misurati**: su un telefono lento potrebbero essere troppo. Aggiungere un log temporaneo del tempo di hash al primo sblocco e tarare. Se troppo lento, scendere a N=2^14; se troppo veloce, salire a N=2^16.

## Migrazione: re-hash trasparente e versionato

Alla verifica di un PIN:
1. Leggi il prefisso dell'hash memorizzato.
2. Se `v1` (o nessun prefisso) → verifica con sha256 (vecchio metodo). Se combacia: utente autenticato **e** flag `needsMigration = true`.
3. Se `v2` → verifica con scrypt.
4. Dopo una verifica riuscita con `needsMigration`, ri-hasha il PIN con scrypt (v2) e sovrascrivi lo storage.

Così i PIN esistenti continuano a funzionare e migrano automaticamente al primo sblocco riuscito. **Nessuno viene chiuso fuori.**

## IL PUNTO CRITICO — il duress non deve diventare distinguibile

Rischio: se migra solo il PIN che l'utente usa per sbloccare (il normale) e NON il duress, negli storage resta un hash v2 (normale) e uno v1 (duress) → un analista forense vede un PIN mai migrato → **deduce l'esistenza del duress**. Questo distrugge lo scopo del fix.

Due strategie possibili — DECIDERE consapevolmente:
- **(a) Migrazione simultanea:** al primo sblocco col PIN normale, ri-hasha in v2 ANCHE il PIN duress (e il backup) senza conoscerne il valore in chiaro. MA scrypt ha bisogno del PIN in chiaro per ri-hashare: se non conosco il PIN duress (l'utente non l'ha appena inserito), non posso ri-hasharlo. Quindi (a) puro non è possibile senza il valore.
- **(b) Migrazione pigra ma uniforme:** ogni PIN migra quando VIENE INSERITO E VERIFICATO. Finché entrambi sono v1, sono indistinguibili (entrambi vecchi). Il rischio è la finestra in cui uno è v2 e l'altro v1. Mitigazione: **finché non sono TUTTI migrabili insieme, lasciali tutti in v1** — cioè non migrare al primo sblocco, ma solo quando si può garantire uniformità. Oppure: alla prossima IMPOSTAZIONE/CAMBIO dei PIN (dove l'utente reinserisce entrambi), scrivi entrambi in v2.

**Approccio raccomandato (più sicuro):** NON migrare automaticamente allo sblocco. Invece:
- Tutti i PIN NUOVI (impostati d'ora in poi) usano v2.
- Per i PIN esistenti: alla prossima modifica esplicita (l'utente cambia PIN / riconfigura duress), riscrivi in v2. Fino ad allora restano v1 — ma restano v1 *entrambi*, quindi indistinguibili tra loro.
- In alternativa, offrire una voce "aggiorna sicurezza PIN" che chiede all'utente di reinserire TUTTI i PIN (normale + duress + backup) in un'unica operazione e li riscrive tutti in v2 insieme. Uniforme per costruzione.

Questo evita del tutto la finestra di distinguibilità. Da valutare con calma quale delle due: migrazione pigra uniforme, o operazione esplicita "aggiorna tutti i PIN insieme".

## Struttura del nuovo pinHash.ts

- `hashPinV2(salt, pin): Promise<string>` — scrypt async, ritorna `v2$N$r$p$<hex>`
- `hashPinV1(salt, pin): string` — la vecchia sha256, INTERNA, usata solo in verifica dei legacy
- `verifyPin(stored, salt, pin): Promise<{ valid: boolean; version: 'v1'|'v2' }>` — legge il prefisso, verifica col metodo giusto
- I call site diventano async (lock/backup/duress-setup già fanno operazioni async, gestibile)

## Ordine di implementazione

1. Riscrivi `pinHash.ts` con le tre funzioni + formato versionato. NON rimuovere la capacità di verificare v1.
2. Aggiorna i 3 call site: impostazione → v2; verifica → `verifyPin`.
3. Misura il tempo di hash su un telefono reale, tara i parametri.
4. Decidi e implementa la strategia di migrazione (raccomandato: no auto-migrate allo sblocco; v2 per i nuovi + operazione esplicita uniforme per i vecchi).
5. `npx tsc --noEmit` pulito.

## Ri-test OBBLIGATORIO dopo (C1 non è chiuso senza)

Su dispositivo reale, con Metro:
- Sblocco con PIN normale esistente → funziona (verifica v1 o v2 a seconda della strategia).
- Imposta un PIN nuovo → salvato in v2 → sblocco funziona.
- **Duress modalità A (facciata):** inserisci il PIN duress → facciata parte correttamente → esci col PIN normale.
- **Duress modalità B (trigger):** inserisci il PIN duress → trigger parte → switch va in APPROVAL_PENDING.
- **Lockout:** PIN sbagliati ripetuti → lockout esponenziale funziona.
- **Indistinguibilità:** verifica che negli storage il PIN normale e il duress abbiano lo STESSO formato di versione (entrambi v1 o entrambi v2) — mai uno v1 e uno v2.

Solo quando tutti questi passano, C1 è chiuso. Poi commit + aggiornare FINDINGS_TRIAGE (C1 fatto).

## Prompt di implementazione (usare a mente fresca)

Da scrivere all'inizio della sessione fresca, con lo stop in cima. NON darlo di corsa: prima far misurare i parametri scrypt sul telefono, poi decidere la strategia di migrazione, POI implementare.
