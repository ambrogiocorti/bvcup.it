# Tornei Scuola

Piattaforma web per la gestione completa di tornei scolastici, pensata per seguire l'intero ciclo operativo: configurazione dei tornei, gestione squadre e studenti, calendario partite, aggiornamento live dei match, risultati pubblici, reportistica e classifiche.

Il progetto usa un frontend statico in HTML/CSS/JavaScript vanilla e Supabase come backend per autenticazione, database PostgreSQL, policy RLS, RPC e sincronizzazione dati.

## Funzionalita principali

- Portale pubblico per visualizzare tornei, classifiche, partite concluse e dettagli statistici.
- Dashboard amministrativa multi-ruolo per gestire tornei, squadre, studenti, calendario, eventi di atletica e report.
- Pagina live match per aggiornare punteggio, timer, presenze, falli, MVP, cartellini e statistiche giocatore.
- Lock multi-admin con versione e scadenza per evitare modifiche concorrenti sullo stesso match.
- Finalizzazione match con salvataggio definitivo del risultato e delle statistiche.
- Gestione sport di squadra: calcio, basket e pallavolo.
- Gestione atletica separata, con eventi individuali, risultati, leaderboard e regole dedicate.
- Generazione automatica calendario gironi e semifinali.
- Import CSV guidato con anteprima, validazione e report errori.
- Report stampabile con ranking studenti, classifica squadre, filtri e colonne configurabili.
- Migrazioni SQL complete per schema, dati demo, correzioni legacy e protezioni database.

## Pagine dell'applicazione

### `index.html`

Pagina pubblica consultabile da studenti, docenti e pubblico. Permette di:

- selezionare un torneo;
- vedere classifica e contesto del torneo;
- consultare le partite concluse;
- aprire il dettaglio di una singola partita con statistiche giocatore;
- visualizzare eventi e ranking atletica quando il torneo selezionato e di tipo atletica;
- accedere al login amministratore tramite il pulsante dedicato.

### `admin.html`

Dashboard amministrativa protetta da autenticazione Supabase. Include:

- riepilogo generale con contatori principali;
- report generale per tornei di squadra e atletica;
- gestione calendario match;
- creazione manuale e generazione automatica partite;
- gestione tornei;
- gestione squadre e studenti;
- gestione eventi e risultati atletica;
- impostazioni specifiche per torneo;
- import CSV per dati massivi;
- controlli di visibilita in base al ruolo dell'utente.

### `live.html`

Interfaccia operativa per gestire un match in tempo reale. Supporta:

- acquisizione lock live;
- salvataggio snapshot;
- finalizzazione match;
- punteggio casa/ospite;
- timer;
- quarti e timeout per sport compatibili;
- roster casa e ospite;
- presenze;
- falli;
- voto MVP;
- cartellini gialli e rossi;
- modalita sola lettura per match gia conclusi o utenti senza lock.

## Ruoli amministrativi

La piattaforma supporta tre ruoli principali:

- `super_admin`: accesso completo a gestione tornei, squadre, calendario, impostazioni, atletica, CSV e report.
- `match_manager`: gestione operativa dei match e accesso ai report consentiti.
- `report_viewer`: consultazione report senza permessi di modifica.

Le regole sono applicate nel frontend tramite `js/auth.js` e devono essere coerenti con le policy RLS definite nel database Supabase.

## Architettura tecnica

### Frontend

Il frontend e composto da pagine statiche e moduli JavaScript ES Modules:

- `js/main-index.js`: logica della pagina pubblica.
- `js/main-admin.js`: logica della dashboard amministrativa.
- `js/main-live.js`: logica dell'interfaccia live match.
- `js/matches.js`: tornei, squadre, calendario, classifiche e statistiche match.
- `js/live.js`: lock, snapshot, finalizzazione e sottoscrizioni live.
- `js/events.js`: gestione atletica, eventi, risultati e ranking.
- `js/reports.js`: dataset report, ranking studenti, MVP e classifiche.
- `js/csv-import.js`: parsing, validazione, anteprima e import CSV.
- `js/auth.js`: sessione, profilo admin, login, logout e permessi ruolo.
- `js/db.js`: client Supabase e wrapper di esecuzione.
- `js/app-config.js`: configurazione Supabase, ruoli, sport e parametri live.
- `js/utils.js`: funzioni condivise di utilita.

### Backend

Supabase fornisce:

- autenticazione utenti;
- database PostgreSQL;
- tabelle applicative;
- relazioni e vincoli;
- Row Level Security;
- RPC per operazioni live atomiche;
- trigger di protezione;
- realtime subscription.

Le migrazioni sono nella cartella `sql/`.

## Setup rapido

1. Crea o apri un progetto Supabase.
2. Apri il pannello SQL Editor di Supabase.
3. Esegui le migrazioni SQL in ordine crescente dalla cartella `sql/`.
4. Verifica che tabelle, policy, RPC e trigger siano stati creati correttamente.
5. Configura `js/app-config.js` con URL e anon key del progetto Supabase.
6. Servi il progetto con un server statico, ad esempio Live Server di VS Code.
7. Apri `index.html` per la pagina pubblica.
8. Accedi alla dashboard tramite login amministratore.

Per usare dati dimostrativi, esegui anche `sql/002_seed_demo_tornei.sql` dopo la migrazione principale.

## Migrazioni SQL

Le migrazioni disponibili sono:

- `001_refactor_hybrid.sql`: schema principale, RLS, view e RPC.
- `001_refactor_hybrid_rollback.sql`: rollback della migrazione principale.
- `002_seed_demo_tornei.sql`: dati demo per tornei, squadre, giocatori, match ed eventi.
- `003_mvp_config_per_torneo.sql`: configurazione MVP per torneo.
- `004_fix_legacy_foreign_keys.sql`: correzione relazioni legacy.
- `005_fix_finalize_match_ambiguous.sql`: correzione ambiguita su `match_id` nella finalizzazione.
- `006_fix_allow_mvp_schema_cache.sql`: refresh/correzione schema per `allow_mvp`.
- `007_atletica_attempts_limits.sql`: regole atletica avanzate per tentativi e limiti eventi.
- `008_hard_guards_matches_and_orphans.sql`: blocco match atletica, pulizia orfani e FK hard su risultati atletica.

In ambienti gia esistenti e consigliato applicare le migrazioni nell'ordine indicato e verificare eventuali messaggi del SQL Editor.

## Flusso operativo consigliato

1. Crea un torneo scegliendo sport, formato e anno.
2. Configura le impostazioni specifiche del torneo.
3. Inserisci squadre e studenti manualmente o tramite CSV.
4. Genera il calendario automatico o crea match manuali.
5. Apri un match dalla dashboard admin e gestiscilo dalla pagina live.
6. Salva snapshot durante la partita se necessario.
7. Finalizza il match quando il risultato e definitivo.
8. Consulta risultati e classifiche dalla pagina pubblica.
9. Usa il report generale per controllare ranking, MVP, presenze, falli e classifica squadre.
10. Stampa il report quando serve una copia ufficiale.

## Import CSV

La dashboard admin include import guidati con template scaricabili.

### Squadre e studenti

Formato:

```csv
team_name;student_full_name
```

Uso tipico:

- creazione o aggiornamento squadre;
- inserimento massivo studenti;
- associazione studenti alla classe/squadra.

### Eventi atletica

Formato:

```csv
event_name;unit;sort_order;is_active
```

Uso tipico:

- creazione eventi;
- configurazione unita di misura;
- ordinamento eventi;
- attivazione/disattivazione eventi.

### Risultati atletica

Formato:

```csv
event_name;team_name;student_full_name;value;notes
```

Uso tipico:

- inserimento massivo risultati;
- associazione risultato ad atleta e classe;
- generazione ranking atletica.

Ogni import segue questo flusso:

1. selezione torneo;
2. download template;
3. caricamento file;
4. anteprima;
5. validazione;
6. report errori/avvisi;
7. conferma import.

## Funzioni live e RPC

Le principali RPC usate dalla gestione live sono:

- `acquire_match_lock(match_id, ttl_seconds)`: acquisisce il lock del match.
- `refresh_match_lock(match_id, ttl_seconds)`: rinnova il lock attivo.
- `release_match_lock(match_id)`: rilascia il lock.
- `save_live_snapshot(match_id, payload, expected_version)`: salva lo stato temporaneo del match.
- `finalize_match(match_id, payload, stats_payload, expected_version)`: finalizza risultato e statistiche.

Il frontend include fallback compatibili, ma per concorrenza multi-admin affidabile e consigliato applicare sempre le RPC del database.

## Report e classifiche

La piattaforma calcola:

- classifica squadre;
- ranking studenti;
- percentuale presenza;
- falli;
- score;
- MVP;
- leaderboard atletica;
- medaglie atletica;
- classifica eventi individuali.

I report amministrativi supportano:

- filtri per classe/squadra;
- filtri presenza, falli e score;
- filtri atletica per atleta, evento e classe;
- selezione colonne;
- stampa ottimizzata.

## Sicurezza e permessi

Il progetto usa un modello ibrido:

- il frontend nasconde o disabilita azioni in base al ruolo;
- Supabase Auth identifica l'utente;
- il database deve applicare RLS e vincoli per proteggere i dati;
- le RPC gestiscono operazioni critiche come lock e finalizzazione;
- i trigger impediscono stati non validi, ad esempio match legati a tornei di atletica.

Le chiavi Supabase presenti nel frontend devono essere chiavi pubbliche `anon`, mai service role key.

## Requisiti

- Browser moderno con supporto ES Modules.
- Progetto Supabase configurato.
- Connessione internet per caricare:
  - Supabase JS da CDN;
  - Font Awesome da CDN;
  - Google Fonts.
- Server statico locale o hosting statico.

## Avvio locale

Con VS Code:

1. installa l'estensione Live Server;
2. apri la cartella del progetto;
3. avvia Live Server su `index.html`;
4. accedi alla dashboard tramite il pulsante admin.

In alternativa puoi usare un qualsiasi server statico. Evita di affidarti al solo `file://`, perche i moduli ES e alcune policy del browser possono creare problemi.

## Struttura del progetto

```text
.
├── admin.html
├── index.html
├── live.html
├── favicon.svg
├── css/
│   └── style.css
├── js/
│   ├── app-config.js
│   ├── auth.js
│   ├── csv-import.js
│   ├── db.js
│   ├── events.js
│   ├── live.js
│   ├── main-admin.js
│   ├── main-index.js
│   ├── main-live.js
│   ├── matches.js
│   ├── reports.js
│   ├── teams.js
│   └── utils.js
```

## Stato del progetto

La piattaforma e pensata come applicazione scolastica leggera ma completa: non richiede un backend custom, mantiene la logica applicativa nel frontend e delega persistenza, sicurezza e operazioni critiche a Supabase.
