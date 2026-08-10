# Sentinella — Trovamenti dell'audit e piano di rimedio

Esito del triage dei trovamenti emersi dall'inventario crittografico (luglio 2026).
Ogni voce è stata investigata: stato (reale / falso allarme / da verificare), gravità, e note per il fix.

L'ordine di lavoro suggerito è per gravità e per rischio di regressione: prima ciò che rompe garanzie di sicurezza dichiarate, ma affrontando ogni voce con calma e test, non in blocco.

---

## Critici — rompono garanzie di sicurezza dichiarate

### C1 — PIN hashati con singola SHA-256
**Stato:** reale, confermato (`pinHash.ts`). **AGGIORNATO (agosto 2026):** indagato, non risolvibile senza modulo nativo. Vedi [docs/C1_ESITO.md](C1_ESITO.md). Rimandato all'audit professionale con benchmark a supporto.
**Impatto:** un PIN di 6 cifre ha 10^6 combinazioni; con SHA-256 singola, chi estrae il record da SecureStore le prova tutte in una frazione di secondo. **Conseguenza più grave:** un'analisi forense recupera sia il PIN normale sia il PIN duress, e potendo distinguerli vanifica l'indistinguibilità del duress a livello di storage — proprio la garanzia che la modalità di coercizione promette.
**Fix:** sostituire con una KDF lenta e salata — Argon2id (preferito) o PBKDF2 con conteggio iterazioni elevato. Salt casuale per PIN, già presente nel record.
**Attenzione:** tocca lo storage dei PIN esistenti. Serve una **migrazione**: i PIN già impostati sono hashati col vecchio schema. Prevedere re-hash al primo sblocco riuscito, o forzare reimpostazione. Da progettare con cura per non bloccare fuori l'utente. **Non fare di fretta.**

### C2 — Le esche sono distinguibili dal server
**Stato:** reale (indici quote reali `x = 1…N`, esche `x = 100+j`, `x` in chiaro nella tabella `shares`). **AGGIORNATO (agosto 2026):** FATTO e verificato E2E su 3 dispositivi. Commit 7890f46. Indice x rimosso dal wire all'arm; x vive dentro il blob cifrato; schema arm `.strict()` rifiuta x.
**Impatto:** un server compromesso distingue quote reali da esche guardando l'indice, e contando le reali apprende N. Contraddice il commento in `db.ts` e la garanzia 3.3 del threat model.
**Fix:** assegnare alle esche indici nello stesso spazio delle quote reali, oppure rendere le quote uniformemente opache al server. Verificare che la ricombinazione lato client continui a selezionare le quote corrette.

### C3 — Il server apprende k (la soglia)
**Stato:** reale (`compose.tsx` invia `recoveryK: threshold`; `/switch/arm` lo persiste in `users.recovery_k`). **AGGIORNATO (agosto 2026):** FATTO fase 1. Commit 906fc12. recoveryK non più inviato all'arm; recovery_k usa default 2. Fase 2 (UI quorum recovery disaccoppiato) rimandata.
**Impatto:** il server conosce quanti contatti servono per il rilascio — informazione che l'invariante dichiarata (`switch.ts:46`, «k NON viene inviata al server») nega. Divergenza tra codice e modello.
**Fix:** decidere quale delle due è la verità voluta. Se k deve restare privato al server, rimuovere l'invio e gestire la soglia lato client / dentro il materiale cifrato. Se il server ha legittimamente bisogno di `recovery_k` per il recovery sociale (che è cosa diversa dalla soglia Shamir del contenuto), allora separare i due concetti e correggere il commento fuorviante. **Chiarire prima il modello, poi il codice.**

---

## Alti — bug funzionali

### A1 — `threshold_k`: colonna inesistente nella query di /auth/verify
**Stato:** reale. **FIX APPLICATO** (rimossa dalla SELECT).
**Era:** la query di restore-da-seed selezionava una colonna assente → errore SQL → flusso di recupero identità rotto per owner con switch. Il client non usava il campo.

### A2 — Anti-replay solo in memoria
**Stato:** da confermare, verosimile.
**Impatto:** la cache dei nonce anti-replay è in memoria; al riavvio del server si azzera, riaprendo una finestra in cui richieste firmate già viste potrebbero essere rigiocate (entro la finestra di validità del timestamp).
**Fix:** valutare persistenza della cache nonce, o accettare il rischio documentandolo (la finestra è limitata dal TTL del timestamp, ±5 min). Decisione di costo/beneficio.

### A3 — Autenticazione a token di sessione residua
**Stato:** reale ma circoscritto. Investigato: `sessions` è usato solo in `/auth/verify` (restore) e non protegge rotte critiche (che usano firma per-richiesta). NON è un bypass delle azioni sensibili.
**Impatto:** basso. È superficie inutile: un modello di auth secondario che vive solo per il flusso restore.
**Fix:** valutare se il flusso restore può usare la firma per-richiesta come tutto il resto, eliminando `sessions`/`challenges` e il token a scadenza. Riduce superficie, non urgente.

---

## Medi — irrobustimenti

### M1 — Shuffle delle esche con `Math.random`
`sort(() => Math.random() - 0.5)` non produce permutazioni uniformi ed è non crittografico. Sostituire con Fisher-Yates su sorgente sicura. Rilevante perché l'ordine delle quote potrebbe essere osservabile.

### M2 — Math.random in contesti crypto-adiacenti
L'inventario segnala 4 usi di `Math.random`. Verificare ciascuno: se tocca materiale che deve essere imprevedibile (ordine quote, id, jitter), sostituire con sorgente sicura. Se è solo UI/cosmesi, annotare come innocuo.

### M3 — Fingerprint/safety number troncato a 48 bit
48 bit di safety number: valutare se sufficiente contro attacchi di collisione mirati durante il pairing. Confrontare con prassi (Signal usa numeri più lunghi). Possibile allungamento.

### M4 — "Audit log firmato" senza chiave di firma del server
Naming fuorviante: non c'è firma del server (scelta corretta e documentata — il server non deve poter firmare). È hash-chain + firme di richiesta dell'utente, spesso NULL per eventi automatici. **Non è un bug**, ma allineare il naming e la documentazione per non indurre in errore l'auditor.

### M5 — P-256 reimplementata a mano nella console web
La console web di verifica reimplementa P-256 in BigInt invece di usare una libreria. Superficie di errore. Se la console web è uno strumento accessorio, valutarne l'uso reale; se serve, usare una libreria auditata.

### M6 — Blob Drive "anyone with link"
I blob su Drive sono condivisi per link. Scelta documentata (la riservatezza è nella cifratura, non nell'ACL), ma senza forward secrecy: se la chiave di contenuto trapela in futuro, un blob archiviato resta decifrabile. Annotare nel threat model come limite accettato o valutare rotazione.

---

## Falsi allarmi (chiusi)

- **`drive_pointer` colonna inesistente in `switches`:** falso allarme. La colonna è stata spostata in `switch_contents` durante un refactoring; i due `ALTER TABLE switches DROP COLUMN` in `db.ts` gestiscono la migrazione. Il codice legge `drive_pointer` dalla tabella corretta.

---

## Ordine di lavoro suggerito

1. **A1** — fatto.
2. **C3** — chiarire il modello (k al server): è concettuale, sblocca la comprensione di C2.
3. **C2** — esche indistinguibili: tocca la logica quote, va testato col flusso di rilascio.
4. **C1** — KDF per i PIN: il più importante, ma con migrazione delicata. Sessione dedicata, a mente fresca, con test del duress dopo.
5. **A2, M1, M2** — irrobustimenti su entropia e replay, raggruppabili.
6. **M3–M6, A3** — rifiniture e riduzione superficie, quando il resto è stabile.

**Nota di metodo:** ogni fix di un trovamento critico va seguito da una verifica end-to-end del flusso toccato. C1 in particolare non è considerato chiuso finché il duress non è ri-testato sul dispositivo (facciata + trigger + lockout) dopo la migrazione dei PIN.
