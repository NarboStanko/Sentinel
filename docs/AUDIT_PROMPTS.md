# Sentinella — Prompt per audit su modelli linguistici

## Come usarli

**Un prompt per sessione, sessioni separate.** Un modello che ha già "assolto" il sistema in una risposta tende a restare coerente con sé stesso. Sessioni indipendenti danno giudizi indipendenti.

**Cosa consegnare all'inizio:** il codice, `THREAT_MODEL.md`, `CRYPTO_INVENTORY.md`.

**Cosa NON consegnare subito:** `DESIGN_DECISIONS.md`. Contiene le motivazioni delle scelte, e un modello che le legge tende ad accettarle invece di metterle in discussione. Consegnalo solo nella seconda fase, quando confronti le segnalazioni ricevute con il razionale: quelle che restano valide anche dopo aver letto le motivazioni sono le segnalazioni che contano.

**Registra tutto.** Anche i falsi positivi: la frequenza con cui modelli diversi segnalano la stessa cosa è un segnale, anche quando la segnalazione è sbagliata.

---

## Prompt 1 — Attaccante con database

> Hai ottenuto accesso in lettura e scrittura al database SQLite di questo server. Non hai le chiavi private di nessun utente. Il tuo obiettivo è alterare la storia degli eventi senza che l'utente possa accorgersene verificando la catena audit.
>
> Elenca ogni azione che puoi compiere e per ciascuna indica se è rilevabile, da chi, e a quali condizioni. Dove trovi azioni non rilevabili, spiega la sequenza esatta.
>
> Considera anche: eventi che il sistema non scrive affatto, eventi che può perdere, e finestre temporali in cui la catena è incompleta.

## Prompt 2 — Distinguere il duress

> Questo sistema ha un PIN di emergenza che, se digitato al posto di quello normale, attiva contromisure invisibili. Ci sono due modalità: una mostra dati fittizi senza contattare il server, l'altra avvia una procedura di rilascio in background mostrando i dati reali.
>
> Sei un avversario che osserva il dispositivo mentre la vittima lo sblocca, e puoi anche esaminarlo successivamente. Trova ogni modo per distinguere uno sblocco con PIN di emergenza da uno sblocco normale.
>
> Considera: tempi di risposta, traffico di rete, consumo, artefatti su disco, contenuto dell'APK, stato dell'interfaccia, comportamento dopo un riavvio, differenze nei log di sistema.

## Prompt 3 — Canonicalizzazione e firme

> Analizza la funzione di canonicalizzazione usata per firmare le richieste, presente in due implementazioni che devono produrre output identici (client e server).
>
> Domande: esistono due payload semanticamente diversi che producono la stessa stringa canonica? La concatenazione con separatore è iniettabile tramite il contenuto dei campi? L'ordinamento è deterministico per tutti i tipi JSON, inclusi valori nulli, array annidati, chiavi con caratteri speciali, numeri in notazione diversa?
>
> Costruisci un caso concreto di collisione se ne trovi uno.

## Prompt 4 — Ciclo di vita delle chiavi

> Traccia il percorso di ogni segreto in questa applicazione React Native: seed phrase, chiave privata di identità, chiave di cifratura del contenuto, quote di Shamir, PIN.
>
> Per ciascuno: dove viene generato, con quale entropia, dove risiede in memoria, per quanto tempo, dove viene persistito, se viene azzerato dopo l'uso, e chi può leggerlo in quel percorso.
>
> Indica dove il runtime JavaScript rende impossibile garantire l'azzeramento e quali sono le conseguenze pratiche.

## Prompt 5 — Soglia di Shamir

> Esamina l'implementazione della condivisione a soglia e della ricombinazione.
>
> Verifica: la generazione dei coefficienti usa una sorgente crittograficamente sicura? L'aritmetica è su un campo finito corretto? La ricombinazione ha comportamenti dipendenti dai dati che potrebbero costituire un canale laterale? È possibile che k-1 quote rivelino informazione parziale sul segreto?
>
> Verifica anche il caso degenere: cosa accade con quote malformate, duplicate, o con indici fuori intervallo.

## Prompt 6 — Escalation sulle rotte

> Questo server usa un middleware di autenticazione con quattro tipi di attore. Ogni rotta di scrittura dichiara quale tipo richiede.
>
> Costruisci una matrice di tutte le rotte con il tipo di attore richiesto, e cerca: rotte dove il tipo è più permissivo del necessario, rotte dove la relazione tra attore e risorsa non viene verificata, percorsi in cui un contatto può agire su risorse di un owner diverso, o in cui un owner può agire su switch non suoi.
>
> Verifica anche le rotte deliberatamente anonime: quali garanzie perdono e se esistono abusi possibili.

## Prompt 7 — Il progettista sbagliato

> Assumi che chi ha progettato questo sistema abbia commesso almeno tre errori concettuali significativi — non bug di implementazione, ma scelte architetturali che non reggono al modello di minaccia dichiarato.
>
> Trovali. Per ciascuno spiega perché la scelta sembra ragionevole, perché non lo è, e cosa andrebbe fatto invece.
>
> Non elencare buone pratiche generiche: cerca ciò che è sbagliato in questo sistema specifico.

## Prompt 8 — Il caso reale

> Una giornalista in un paese autoritario usa questo strumento. Ha materiale che comprometterebbe funzionari di governo. Ha configurato tre contatti fidati in tre paesi diversi, soglia 2, e un intervallo di check-in giornaliero.
>
> Viene arrestata. Il suo telefono viene sequestrato e analizzato da un laboratorio forense. Gli inquirenti hanno risorse statali, tempo, e possono ottenere collaborazione dal fornitore del server e dal provider di storage.
>
> Descrivi cosa possono ricostruire, cosa possono impedire, cosa non possono fare in nessun caso. Sii specifico su quale materiale ottengono da ciascuna fonte.

---

## Cosa fare dopo

Raccogli le segnalazioni in una tabella: descrizione, quale modello l'ha sollevata, gravità stimata, e se resta valida dopo aver letto `DESIGN_DECISIONS.md`.

Le segnalazioni che sopravvivono al confronto con il razionale sono quelle da portare all'audit professionale: risparmiano tempo al revisore e mostrano che il progetto ha già fatto un lavoro di autocritica.
