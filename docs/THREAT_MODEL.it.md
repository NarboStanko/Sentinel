# Sentinella — Modello di minaccia

> [🇬🇧 English](THREAT_MODEL.md) · 🇮🇹 Italiano

**Versione:** 1.0 · **Data:** luglio 2026 · **Stato del progetto:** prototipo funzionante, non ancora sottoposto ad audit indipendente

---

## 1. Cos'è Sentinella

Un *dead-man's switch* civico. L'utente (*owner*) prepara un pacchetto di contenuti cifrati e lo "arma" con un intervallo di check-in. Se l'owner non risponde ai check-in entro l'intervallo più un periodo di grazia, il sistema chiede ai *contatti fidati* dell'owner di approvare il rilascio. Raggiunto il quorum, i contatti ricombinano la chiave e accedono al contenuto.

Caso d'uso di riferimento: una persona che detiene informazioni la cui pubblicazione è nell'interesse pubblico, e che vuole garantirne la diffusione qualora venga messa nell'impossibilità di agire.

**Ciò che il sistema promette:**
- Il server non può leggere i contenuti (cifratura end-to-end).
- Il server non può rilasciare i contenuti da solo (serve il quorum dei contatti).
- Il server non può alterare la cronologia degli eventi senza che sia rilevabile.
- L'owner sotto coercizione ha due contromisure: una facciata di dati spuri e un trigger silenzioso.

---

## 2. Attori

| Attore | Descrizione | Fidato per |
|---|---|---|
| **Owner** | Chi prepara e arma il pacchetto | Sé stesso |
| **Contatto fidato** | Persona accoppiata in presenza con l'owner, detiene una quota Shamir | Approvare il rilascio (solo in quorum) |
| **Server** | Backend Node/Fastify + SQLite | Nulla di crittografico: coordina, non conosce chiavi né contenuti |
| **Storage provider** | Google Drive dell'owner (o DevBlob in sviluppo) | Conservare byte opachi |
| **Coercitore** | Chi ha accesso fisico all'owner e al suo dispositivo | — (avversario) |

---

## 3. Minacce coperte

### 3.1 Server compromesso — passivo (lettura)

**Scenario:** un attaccante ottiene accesso in lettura al database e ai file del server (exploit, accesso fisico, insider).

**Copertura:** i contenuti non transitano né risiedono sul server. Il server conserva puntatori a blob cifrati su storage esterno, quote Shamir cifrate per il destinatario, chiavi pubbliche. Nessun materiale segreto in chiaro.

**Residuo:** metadati esposti. Chi è owner di chi, quanti contatti, quando è stato armato uno switch, i timestamp dei check-in. Il grafo sociale è visibile. **Non mitigato.**

### 3.2 Server compromesso — attivo (alterazione)

**Scenario:** l'attaccante ha controllo in scrittura e vuole alterare la storia: cancellare eventi, inventarne, riordinarli.

**Copertura:** catena di hash con eventi utente firmati (`audit_chain`). Ogni evento contiene l'hash del precedente; l'hash copre `chain_owner_id ‖ chain_index ‖ event_type ‖ actor_id ‖ canonical(payload) ‖ timestamp_ms ‖ signature ‖ prev_hash`. Le azioni dell'utente portano la firma P-256 dell'attore, che il server non può falsificare non avendo la chiave privata.

L'utente può salvare un *anchor* (hash dell'ultimo evento della propria catena) fuori dal sistema, e in seguito verificare che la catena ricostruita dal server corrisponda.

**Limite dichiarato:** il sistema **rileva**, non impedisce. Un attaccante con controllo del DB può cancellare o riscrivere; l'utente se ne accorge solo verificando contro un anchor salvato in precedenza. Senza anchor, un attaccante con tempo sufficiente può ricostruire una catena coerente dal genesis.

### 3.3 Server che tenta il rilascio autonomo

**Scenario:** il server vuole far uscire i contenuti senza il consenso dei contatti.

**Copertura:** la chiave di cifratura del contenuto è divisa in quote Shamir (soglia k, minimo 2 per vincolo di prodotto). Le quote sono cifrate per la chiave pubblica di ciascun contatto: il server le trasporta senza poterle leggere. Servono k contatti che sottomettano la propria quota decifrata.

**Residuo:** se k contatti sono compromessi o colludono, il rilascio avviene. È una proprietà del modello a soglia, non un difetto implementativo.

### 3.4 Richieste non autenticate al server

**Scenario:** un attaccante che conosce un `switch_id` tenta di disarmarlo, armarlo, aggiungere contenuti, sottomettere quote.

**Copertura:** ogni rotta di scrittura richiede una firma P-256 su una canonicalizzazione deterministica di `(method, path, timestamp, chiave pubblica, body)`. Quattro tipi di attore (`owner`, `contact`, `owner-of-switch`, `contact-of-switch`) con lookup che verifica anche la relazione (es. che quel contatto appartenga all'owner di quello switch). Protezione replay via cache di nonce con finestra ±5 min e TTL 6 min.

Il rate-limit sulle sottomissioni è per identità crittografica (`contact_id`), non per IP: due contatti dietro la stessa rete non si bloccano a vicenda.

Le quote già sottomesse non possono essere sovrascritte (`UPDATE ... AND submitted_share IS NULL`, tentativo registrato come `SHARE_OVERWRITE_ATTEMPTED`).

### 3.5 Coercizione fisica dell'owner

**Scenario:** qualcuno costringe l'owner a sbloccare l'app.

**Copertura:** PIN di emergenza (*duress*), con due modalità alternative configurabili:

- **Modalità A — facciata.** L'app si sblocca mostrando dati spuri credibili (uno switch disarmato, contatti fittizi marcati come verificati). **Nessuna chiamata raggiunge il server**: un guard centrale intercetta ogni richiesta e restituisce un errore di rete plausibile. Lo stato facciata persiste in SecureStore, quindi resta coerente anche se il coercitore riavvia il dispositivo e fa risbloccare. Si esce solo sbloccando con il PIN normale; a quel punto l'app registra `DURESS_FACADE_TRIGGERED` e avvisa l'utente.

- **Modalità B — trigger silenzioso.** L'app si sblocca mostrando i dati **reali**, indistinguibile da uno sblocco normale, mentre in background porta gli switch attivi in `APPROVAL_PENDING`, saltando la grazia. I contatti ricevono subito le richieste di approvazione. Il quorum resta necessario: il duress **avvia** il rilascio, non lo esegue.

**Indistinguibilità:** entrambe le modalità usano lo stesso percorso di navigazione dello sblocco normale, azzerano il contatore di lockout come farebbe un PIN valido, e non producono messaggi, ritardi o segnali visibili. La schermata di sblocco non contiene alcun riferimento all'esistenza di un PIN di emergenza.

**La biometria è esclusa dallo sblocco per scelta deliberata:** un'impronta è coercibile (basta prendere il dito), un PIN nella testa no. Se l'app si sbloccasse con l'impronta, il duress non scatterebbe mai.

**Vincoli sul PIN duress:** minimo 6 cifre, blacklist di 28 pattern comuni, diverso dal PIN di sblocco. Rate-limit di 3 trigger al giorno per owner.

### 3.6 Brute force sul dispositivo

**Copertura:** lockout esponenziale persistente (30s → 2min → 10min → 1h → 4h, tetto), che sopravvive alla chiusura dell'app. Reset dopo 24h senza tentativi falliti.

---

## 4. Minacce NON coperte (dichiarate esplicitamente)

| Minaccia | Perché non coperta |
|---|---|
| **Malware sul dispositivo dell'owner** | Un attaccante con codice in esecuzione sul telefono legge SecureStore, la memoria, e osserva l'inserimento del PIN. Nessuna difesa possibile a questo livello. |
| **Server + anchor entrambi compromessi** | Se l'attaccante controlla il server e l'utente non ha mai salvato un anchor esterno, può ricostruire una catena audit coerente e falsa. |
| **Collusione di k contatti** | Proprietà del modello a soglia. La scelta di k è un compromesso tra disponibilità e resistenza alla collusione. |
| **Coercizione dei contatti** | Un attaccante che costringe k contatti ad approvare ottiene il rilascio. I contatti non hanno un meccanismo duress. |
| **Analisi forense del dispositivo** | La facciata regge un'ispezione superficiale sotto stress, non un'analisi tecnica: l'APK contiene il codice della facciata, e i dati reali sono presenti in SecureStore. |
| **Metadati sul server** | Grafo dei contatti, tempistiche, frequenza d'uso sono in chiaro nel DB. |
| **Compromissione dello storage provider** | Google può cancellare i blob (non leggerli: sono cifrati). Un blob cancellato rende il pacchetto irrecuperabile. |
| **Denial of service sul server** | Se il server è offline, i check-in non arrivano e il ciclo si ferma. Rate-limit IP presente come secondo livello, ma non c'è ridondanza. |

---

## 5. Sottosistema pianificato: uscite verso attuatori

**Non implementato.** Documentato qui perché il design è stato deciso e introduce una superficie d'attacco propria, che l'auditor può voler considerare nel valutare l'architettura esistente.

**Cos'è:** un'uscita generica che, al rilascio, consegna un comando di attivazione a un dispositivo controllato dall'utente (Raspberry Pi, ESP32 o simile). La semantica dell'azione è a carico dell'utente: apertura di una serratura, avvio di una registrazione, sblocco di un contenitore. Sentinella fornisce il meccanismo di attivazione verificabile, non decide cosa attiva.

**Principio di design:** l'attuatore non deve fidarsi né del server né della rete. Il segreto di attivazione risiede **dentro il pacchetto cifrato**, protetto dalla stessa soglia di Shamir dei contenuti, e cifrato per la chiave pubblica dell'attuatore. Diventa quindi disponibile solo dopo che k contatti hanno approvato e ricombinato la chiave. Il server trasporta un blob che non può leggere e non può fabbricare.

**Proprietà che ne derivano:**
- Un server compromesso non può azionare l'attuatore: non possiede il segreto.
- Un'attivazione intercettata non è riutilizzabile (vedi anti-replay).
- Nessun cloud di terze parti entra nel perimetro di fiducia.

**Decisioni prese:**

| Aspetto | Scelta | Motivazione |
|---|---|---|
| Anti-replay | Contatore monotono persistente, nessuna scadenza temporale | Un microcontrollore senza RTC prende l'ora dalla rete: chi controlla la rete controlla la scadenza. Il contatore non richiede orologio. |
| Attuatore offline al rilascio | L'attivazione resta pendente finché il dispositivo torna disponibile | Uno scenario di rilascio si verifica quando l'owner non può intervenire: perdere l'attivazione per un'interruzione di rete vanificherebbe la funzione. |
| Arruolamento | Verifica in presenza con confronto di safety number, come per i contatti | Un'associazione via rete è soggetta a sostituzione della chiave pubblica dell'attuatore. |
| Conferma | L'attuatore firma un'attestazione di esecuzione che entra nella catena audit | Senza, non è possibile sapere se l'azione fisica è avvenuta. |
| Modalità di prova | Flag di simulazione sul dispositivo: registra invece di azionare | Rende i test non distruttivi. |
| Partecipazione al trigger duress | Configurabile dall'utente in fase di setup | Se l'attuatore risponde al duress, un coercitore che conosce il meccanismo ha un incentivo a forzarne l'uso. La scelta è dell'utente, informata. |

**Rischi noti del sottosistema:**
- Il contatore anti-replay deve sopravvivere allo spegnimento: su microcontrollori richiede scrittura in memoria non volatile, con attenzione ai cicli di scrittura.
- L'endpoint server che consegna i blob di attivazione non deve consentire di enumerare quali owner possiedono attuatori.
- Un attuatore compromesso fisicamente può essere impedito di agire (negazione del servizio) o azionato in un momento diverso da quello previsto.
- Un'attivazione pendente per un tempo indefinito può scattare in un contesto radicalmente cambiato rispetto a quello in cui è stata autorizzata.

---

## 6. Superficie crittografica

Rimando a `CRYPTO_INVENTORY.md` per l'elenco puntuale di primitive, parametri e punti d'uso.

Sintesi: firme su curva P-256 per l'autenticazione delle richieste e degli eventi audit; condivisione a soglia di Shamir per la chiave di contenuto; cifratura simmetrica autenticata per i contenuti; SHA-256 per la catena audit; derivazione con salt per i PIN in SecureStore.

---

## 7. Domande che ci si aspetta dall'audit

Le aree su cui si richiede attenzione prioritaria:

1. **Ricombinazione Shamir** — l'implementazione è priva di leak temporali o di canali laterali? La generazione delle quote usa entropia adeguata?
2. **Ciclo di vita delle chiavi** — le chiavi in chiaro vengono azzerate in memoria dopo l'uso? Quanto persistono nel runtime JavaScript?
3. **Canonicalizzazione** — l'ordinamento ricorsivo produce serializzazioni deterministiche e non ambigue? Esistono payload che collidono?
4. **Indistinguibilità del duress** — esistono canali laterali osservabili (timing, traffico di rete, consumo, artefatti su disco) che distinguono uno sblocco duress da uno normale?
5. **Catena audit** — la costruzione dell'hash è priva di ambiguità di concatenazione? Il separatore `|` può essere iniettato tramite payload?
6. **Best-effort dell'audit** — le scritture in catena non sono transazionali con l'azione principale: quali eventi si possono perdere e con quali conseguenze?
7. **Modello di autenticazione** — i quattro tipi di attore coprono tutte le rotte con la granularità corretta? Esistono percorsi di escalation?

---

## 8. Stato e limiti dichiarati

- **242 test automatici** lato server, tutti verdi. Coprono autenticazione, rate-limit, catena audit, hardening, duress lato server.
- **Testato end-to-end su dispositivi fisici** con build di produzione: pairing in presenza, armo, quorum, rilascio, decifratura, entrambe le modalità duress.
- **Non testato:** quorum con download da Google Drive (richiede un terzo dispositivo); durata reale (switch armati per settimane); comportamento delle notifiche push dopo lunga inattività.
- **Il server gira in HTTP** su rete locale in fase di sviluppo. Il deploy in produzione richiede HTTPS (Let's Encrypt) e la rimozione della configurazione che consente traffico in chiaro verso l'IP di sviluppo.
- **Nessun audit indipendente è stato svolto.** Il sistema non deve essere usato da persone in situazioni di rischio reale prima che ciò avvenga.
