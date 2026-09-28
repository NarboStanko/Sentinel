# Sentinella — Decisioni di design e motivazioni

> [🇬🇧 English](DESIGN_DECISIONS.md) · 🇮🇹 Italiano

Documento per il revisore. Ogni scelta qui elencata è deliberata: senza il contesto, alcune apparirebbero errori.

---

## Autenticazione e trasporto

**Firma su ogni rotta di scrittura, non token di sessione.**
Un token di sessione rubato dà accesso completo fino alla scadenza. Una firma per richiesta lega ogni azione alla chiave privata dell'attore, che non lascia mai il dispositivo. Il costo è la canonicalizzazione, che diventa un invariante critico.

**Canonicalizzazione condivisa bit-identica client/server.**
Estratta in un modulo senza dipendenze (`app/lib/canonicalize.ts` ↔ `server/src/lib/canonical.ts`), con un test che verifica l'equivalenza. Se le due implementazioni divergono di un solo carattere, tutte le firme falliscono. L'ordinamento delle chiavi è **ricorsivo** sugli oggetti annidati e preserva l'ordine negli array.

**Rate-limit per identità crittografica, non per IP.**
Più contatti dello stesso owner possono trovarsi sulla stessa rete (stessa casa, stesso ufficio). Un rate-limit per IP li farebbe bloccare a vicenda durante un rilascio, che è esattamente il momento in cui il sistema deve funzionare. Il limite per IP resta come secondo livello anti-DoS.

**Alcune rotte restano anonime per necessità.**
`/recovery/initiate` e `/recovery/finalize` non possono richiedere una firma: servono proprio a chi ha perso la chiave privata. È un compromesso consapevole, mitigato dal ritardo di 7 giorni e dall'approvazione dei contatti.

---

## Quorum e soglia

**k minimo 2, per vincolo di prodotto.**
Un rilascio su singola approvazione renderebbe il sistema fragile a un solo contatto compromesso, distratto o coercizzato. Il costo è che serve un minimo di due contatti reali per usare il sistema, e i test richiedono tre dispositivi.

**Il duress avvia il rilascio, non lo esegue.**
La modalità B porta gli switch in `APPROVAL_PENDING` saltando la grazia. Non li porta in `RELEASED`. Anche sotto coercizione, il consenso dei contatti resta necessario: nessun singolo evento sul dispositivo dell'owner può far uscire i contenuti.

---

## Catena audit

**Firma solo le azioni dell'utente.**
Gli eventi generati dallo scheduler (`CHECK_PENDING`, `APPROVAL_REQUESTED`) entrano in catena con `actor_id = 'server'` e firma nulla. Dare una chiave di firma al server significherebbe che un attaccante che compromette il server può firmare eventi falsi — riaprendo esattamente la minaccia che la catena dovrebbe contrastare. Meglio dichiarare che quegli eventi non hanno provenienza dimostrabile.

**Una catena per owner, non una globale.**
Una catena unica esporrebbe a ogni utente il volume di attività degli altri. La separazione preserva la privacy al costo di una gestione più complessa degli eventi che coinvolgono due parti.

**Eventi multi-attore duplicati con prospettive distinte.**
Il pairing genera `CONTACT_PAIRED` nella catena dell'owner (firmato dall'owner) e `BECAME_CONTACT_OF` in quella del contatto (firmato dal contatto). Non è ridondanza: ciascun attore ha la propria narrazione verificabile della stessa interazione, firmata da sé.

**La firma è dentro l'hash della catena.**
Lega la sequenza alla provenienza: non si può sostituire una firma senza rompere la catena, né riordinare senza invalidare le firme.

**`chain_index` e `timestamp_ms` sono nell'hash; l'`id` autoincrementale no.**
`chain_index` impedisce la cancellazione di eventi intermedi con rinumerazione; `timestamp_ms` impedisce il riordino. L'`id` del database è escluso perché il client, che verifica localmente, non lo conosce — includerlo renderebbe la verifica non deterministica.

**Le scritture in catena sono best-effort.**
Ogni `appendToChain` è in `try/catch` e non è transazionale con l'azione principale. Un errore nell'audit non deve impedire all'utente di armare o disarmare uno switch. Conseguenza dichiarata: in caso di crash tra l'azione e l'audit, un evento può mancare. Si è preferita la disponibilità dell'azione alla completezza del log.

**L'anchor è manuale.**
L'app mostra l'hash corrente e invita l'utente a salvarlo fuori dal sistema. Nessuna pubblicazione automatica su blockchain o servizi terzi: introdurrebbe costi, dipendenze e — soprattutto — un pattern di metadati che rivelerebbe l'uso di Sentinella a chi osserva.

---

## Coercizione

**Biometria esclusa dallo sblocco.**
Contro-intuitivo rispetto alla prassi comune, ma necessario: un'impronta si ottiene con la forza fisica, un PIN no. Se l'app si sbloccasse con l'impronta, nessuna delle due modalità duress scatterebbe mai. La biometria resta solo per accedere alla configurazione del duress, dove l'utente non è sotto coercizione.

**PIN unico per sblocco e accesso alla seed.**
Sotto stress, meno segreti da ricordare significa meno errori. L'utente deve tenere a mente due PIN: quello vero e quello di emergenza.

**Facciata con dati spuri, non account vuoto.**
Un account completamente vuoto è sospetto ("perché hai quest'app se non ci hai nulla?"). La facciata mostra uno switch disarmato e contatti fittizi marcati come verificati: un utente che ha provato lo strumento senza usarlo davvero.

**La facciata è interamente locale.**
Un guard centrale nella funzione di richiesta intercetta ogni chiamata — incluse quelle firmate, che passano dalla stessa funzione — e restituisce un errore di rete generico. Il server non riceve alcun traffico durante la facciata: verificato sul campo osservando i log per l'intera durata di una sessione in modalità A.

**La facciata persiste tra i riavvii.**
Se il coercitore spegne e riaccende il dispositivo e fa risbloccare, deve rivedere gli stessi dati spuri. Una facciata che si resetta mostrerebbe dati diversi al secondo accesso, tradendo la finzione.

**Conferme scritte esatte per le azioni catastrofiche.**
Attivare la modalità B richiede di digitare `HO CAPITO`; avviare il recovery dopo una verifica fallita richiede `AVVIA RECOVERY`. Confronto stretto, sensibile alle maiuscole, senza normalizzazione. Un tap singolo su un alert è troppo facile da dare per panico o per errore, e queste azioni sono irreversibili o costose.

**Il rate-limit sul trigger è silenzioso.**
Il quarto trigger in una giornata riceve `429` e l'app non mostra nulla di diverso. Rivelare l'esistenza di un limite direbbe al coercitore che c'è un meccanismo nascosto.

**Blacklist di PIN comuni e lunghezza minima.**
Il PIN duress ha conseguenze irreversibili quando digitato. Un PIN a quattro cifre banale potrebbe essere indovinato per caso da un ladro che prova le combinazioni ovvie, o digitato da un familiare, facendo partire un rilascio reale.

---

## Storage

**Il provider non conosce le chiavi.**
L'interfaccia di storage riceve e restituisce byte già cifrati. Google Drive conserva materiale opaco: verificato aprendo un blob dal browser e constatando che è illeggibile.

**Ambito Drive minimo (`drive.file`).**
L'app accede solo ai file che ha creato, non all'intero Drive dell'utente.

**Login e refresh usano lo stesso client OAuth.**
Ottenere i token con un client e rinnovarli con un altro produce un rifiuto da parte di Google alla scadenza del primo token — un guasto che si manifesterebbe solo dopo un'ora di utilizzo, difficile da diagnosticare.

**Armare richiede uno storage connesso.**
Senza un provider attivo non esiste un luogo dove collocare il pacchetto. L'app blocca l'armo e guida alla connessione, invece di fallire più avanti nel flusso.

**Disconnettere Drive è impedito con switch armati.**
I blob dei pacchetti attivi risiedono su Drive: disconnettere renderebbe il pacchetto irrecuperabile per i contatti al momento del rilascio. La verifica è *fail-safe*: se lo stato non è determinabile (per esempio rete assente), la disconnessione viene comunque bloccata.

---

## Errori e informazione

**L'error handler distingue i 4xx leciti dai 5xx interni.**
I codici informativi (400, 401, 409, 413, 415, 429...) raggiungono il client con il proprio messaggio; tutto il resto diventa un `500` generico con lo stack registrato solo lato server. Mascherare anche i 4xx rendeva impossibile il debug lato client senza aggiungere sicurezza.

**Le rotte di sviluppo non vengono registrate in produzione.**
Il controllo avviene all'inizio della funzione di registrazione, non dentro ciascuna rotta: in produzione gli endpoint semplicemente non esistono e rispondono `404`, indistinguibile da un percorso inesistente. Un `403` rivelerebbe che la funzione esiste ma è disabilitata.

**Validazione con rifiuto dei campi non previsti.**
Venti schemi con modalità stretta. La validazione è posta dopo l'autenticazione, così una richiesta non firmata riceve `401` e non `400`: non si rivela la forma attesa del payload a chi non è autenticato.
