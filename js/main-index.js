import { signInAdmin } from './auth.js';
import {
  computeStandings,
  loadMatchesBySport,
  loadSportById,
  loadSportConfig,
  loadTeamsBySport,
  getFirstActiveSportId, // Added to get the single tournament ID
} from './matches.js';
import { db, run, subscribeTable } from './db.js';
import {
  escapeHtml,
  formatDateTime,
  medalByRank,
  setHidden,
  showToast,
} from './utils.js';

const DEFAULT_SUBTITLE =
  'Risultati e classifica in tempo reale';

const SPORT_TYPE_LABELS = {
  pallavolo: 'Pallavolo',
};

const FORMAT_LABELS = {
  gironi: 'Gironi',
  eliminazione: 'Eliminazione diretta',
};

const state = {
  selectedSportId: null,
  selectedSport: null, // This will hold the single tournament data
  unsubscribe: null,
};

function closeModal(id) {
  document.getElementById(id)?.classList.remove('open');
}

function openModal(id) {
  document.getElementById(id)?.classList.add('open');
}

function getSportTypeLabel(type) {
  return SPORT_TYPE_LABELS[type] ?? 'Torneo';
}

function getFormatLabel(format) {
  return FORMAT_LABELS[format] ?? 'Formato libero';
}

function resetPublicTournamentUi() {
  const subtitle = document.getElementById('public-subtitle');
  const standingTitle = document.getElementById('standing-title');
  const matchesTitle = document.getElementById('matches-title');
  const contextCard = document.getElementById('sport-context-card');
  const contextContent = document.getElementById('sport-context-content');

  if (subtitle) subtitle.textContent = DEFAULT_SUBTITLE;
  if (standingTitle) {
    standingTitle.innerHTML = '<i class="fa-solid fa-list-ol"></i> Classifica';
  }
  if (matchesTitle) {
    matchesTitle.innerHTML = '<i class="fa-solid fa-calendar-check"></i> Partite Giocate';
  }
  if (contextContent) contextContent.innerHTML = '';
  setHidden(contextCard, true);
}

function updatePublicTournamentUi(sport) {
  const subtitle = document.getElementById('public-subtitle');
  const standingTitle = document.getElementById('standing-title');
  const matchesTitle = document.getElementById('matches-title');
  const contextCard = document.getElementById('sport-context-card');
  const contextContent = document.getElementById('sport-context-content');

  if (!sport) {
    resetPublicTournamentUi();
    return;
  }

  const typeLabel = getSportTypeLabel(sport.sport_type);
  const formatLabel = getFormatLabel(sport.format);

  if (contextContent) {
    contextContent.innerHTML = `
      <div class="sport-context">
        <span class="badge badge-info">${escapeHtml(typeLabel)}</span>
        <span class="badge badge-warning">${escapeHtml(formatLabel)}</span>
        <span class="badge badge-success">${escapeHtml(sport.year)}° anno</span>
      </div>
    `;
  }
  setHidden(contextCard, false);

  if (sport.format === 'eliminazione') {
    if (standingTitle) {
      standingTitle.innerHTML = '<i class="fa-solid fa-sitemap"></i> Quadro Eliminazione';
    }
    if (matchesTitle) {
      matchesTitle.innerHTML = '<i class="fa-solid fa-calendar-check"></i> Match Conclusi';
    }
    return;
  }

  if (standingTitle) {
    standingTitle.innerHTML = '<i class="fa-solid fa-list-ol"></i> Classifica';
  }
  if (matchesTitle) {
    matchesTitle.innerHTML = `<i class="fa-solid fa-calendar-check"></i> Partite ${escapeHtml(
      typeLabel
    )}`;
  }
}

function renderStandingsTable(standings) {
  const container = document.getElementById('standings-container');

  if (!standings.length) {
    container.innerHTML = '<div class="empty-state">Nessuna classifica disponibile.</div>';
    return;
  }

  container.innerHTML = `
    <div class="table-wrap">
      <table class="standings-table">
        <thead>
          <tr>
            <th>Pos</th>
            <th class="team-td">Squadra</th>
            <th class="text-center">G</th>
            <th class="text-center">V</th>
            <th class="text-center">N</th>
            <th class="text-center">P</th>
            <th class="text-center">DR</th>
            <th class="text-center points-col">PT</th>
          </tr>
        </thead>
        <tbody>
          ${standings
            .map(
              (row, index) => `
            <tr>
              <td>${medalByRank(index)}</td>
              <td class="team-td"><strong>${escapeHtml(row.name)}</strong></td>
              <td class="text-center">${row.played}</td>
              <td class="text-center">${row.wins}</td>
              <td class="text-center">${row.draws}</td>
              <td class="text-center">${row.losses}</td>
              <td class="text-center">${row.goalDiff}</td>
              <td class="text-center points-col"><strong>${row.points}</strong></td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderKnockoutOverview(matches) {
  const container = document.getElementById('standings-container');
  const rows = [...(matches ?? [])].sort((a, b) => {
    const byRound = String(a.round_name ?? '').localeCompare(String(b.round_name ?? ''), 'it', {
      sensitivity: 'base',
    });
    if (byRound !== 0) return byRound;
    return Number(a.id) - Number(b.id);
  });

  if (!rows.length) {
    container.innerHTML = '<div class="empty-state">Nessun match presente nel tabellone.</div>';
    return;
  }

  const finishedCount = rows.filter((match) => Boolean(match.is_finished)).length;
  const roundsCount = new Set(rows.map((match) => String(match.round_name ?? '-'))).size;

  container.innerHTML = `
    <div class="sport-context" style="margin-bottom: 12px;">
      <span class="badge badge-info">Round: ${roundsCount}</span>
      <span class="badge badge-success">Conclusi: ${finishedCount}</span>
      <span class="badge badge-warning">Da giocare: ${rows.length - finishedCount}</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Fase</th>
            <th>Incontro</th>
            <th class="text-center">Esito</th>
            <th class="text-center">Stato</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (match) => `
            <tr>
              <td>${escapeHtml(match.round_name ?? '-')}</td>
              <td><strong>
                ${escapeHtml(match.home?.name || (match.round_name?.toLowerCase().includes('finale') ? '1° Classif.' : 'non c\'è 6 senza 7'))} 
                vs 
                ${escapeHtml(match.away?.name || (match.round_name?.toLowerCase().includes('finale') ? '2° Classif.' : 'non c\'è 6 senza 7'))}
              </strong></td>
              <td class="text-center">${match.is_finished ? `${match.home_score ?? 0} - ${match.away_score ?? 0}` : '- -'}</td>
              <td class="text-center">${match.is_finished ? 'Finale' : 'Da giocare'}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function openMatchDetails(matchId) {
  const content = document.getElementById('match-details-content');

  openModal('match-details-modal');
  content.innerHTML = '<div class="empty-state">Caricamento dettagli...</div>';

  try {
    const [matchResult, statsResult] = await Promise.all([
      run(
        db
          .from('matches')
          .select('*, sport:sports(sport_type), home:teams!home_team_id(name), away:teams!away_team_id(name)')
          .eq('id', Number(matchId))
          .single(),
        'Dettaglio match'
      ),
      run(
        db
          .from('match_stats')
          .select('player_id, played, fouls, is_mvp_vote, points_scored, yellow_cards, red_cards')
          .eq('match_id', Number(matchId)),
        'Dettaglio statistiche match'
      ),
    ]);

    const match = matchResult.data;
    let maxFouls = 3;
    if (Number(match?.sport_id) > 0) {
      try {
        const config = await loadSportConfig(Number(match.sport_id));
        maxFouls = Number(config?.max_fouls ?? 3);
      } catch (_error) {
        maxFouls = 3;
      }
    }
    maxFouls = Math.max(1, Math.min(12, Math.round(maxFouls)));

    const dbStats = statsResult.data ?? [];
    const payloadStats = Array.isArray(match?.live_payload?.stats_snapshot)
      ? match.live_payload.stats_snapshot
      : [];
    const stats = dbStats.length ? dbStats : payloadStats;
    const isSoccer = String(match?.sport?.sport_type ?? '').toLowerCase() === 'calcio';
    const showFouls = !isSoccer;
    const showCards = isSoccer;

    const playerIds = [...new Set(stats.map((row) => Number(row.player_id)).filter((id) => Number.isFinite(id) && id > 0))];
    let players = [];
    if (playerIds.length) {
      try {
        const playersResult = await run(
          db.from('players').select('id, full_name, team_id').in('id', playerIds),
          'Dettaglio giocatori match'
        );
        players = playersResult.data ?? [];
      } catch (_error) {
        players = [];
      }
    }

    const playerById = new Map(
      players.map((player) => [
        Number(player.id),
        {
          full_name: player.full_name,
          team_id: Number(player.team_id),
        },
      ])
    );

    const byTeam = (teamId) =>
      stats
        .filter((row) => {
          const resolvedTeamId =
            Number(playerById.get(Number(row.player_id))?.team_id) ||
            Number(row.team_id ?? 0);
          return resolvedTeamId === Number(teamId);
        })
        .map((row) => {
          const fouls = Math.max(0, Number(row.fouls ?? 0));
          const yellowCards = Math.max(0, Number(row.yellow_cards ?? 0));
          const redCards = Math.max(0, Number(row.red_cards ?? 0));
          const foulDots = Array.from({ length: maxFouls })
            .map(
              (_, index) =>
                `<span class="match-foul-dot ${index < fouls ? 'active' : ''}" aria-hidden="true"></span>`
            )
            .join('');

          const playerLabel =
            playerById.get(Number(row.player_id))?.full_name ??
            row.player_name ??
            `Giocatore #${Number(row.player_id)}`;

          return `<div class="match-player-row">
          <span class="match-player-left">
            <span class="match-player-name">${escapeHtml(playerLabel)}</span>
            ${
              row.is_mvp_vote
                ? '<i class="fa-solid fa-star match-player-mvp" title="MVP"></i>'
                : ''
            }
            ${
              showCards
                ? `<span class="match-card-pills">
                    <span class="match-card-pill yellow">Y ${yellowCards}</span>
                    <span class="match-card-pill red">R ${redCards}</span>
                  </span>`
                : ''
            }
          </span>
          ${
            showFouls
              ? `<span class="match-player-fouls" title="Falli ${fouls}/${maxFouls}">
                  ${foulDots}
                </span>`
              : ''
          }
        </div>`;
        });

    content.innerHTML = `
      <div class="match-details-summary">
        <h2 class="match-details-score">${match.home_score ?? 0} - ${match.away_score ?? 0}</h2>
        <div class="muted">
          ${escapeHtml(match.home?.name || (match.round_name?.toLowerCase().includes('finale') ? '1° Classif.' : 'non c\'è 6 senza 7'))} 
          vs 
          ${escapeHtml(
      match.away?.name || (match.round_name?.toLowerCase().includes('finale') ? '2° Classif.' : 'non c\'è 6 senza 7')
    )}</div>
        <div class="match-details-updated muted">Aggiornato: ${formatDateTime(match.updated_at)}</div>
      </div>
      <div class="match-details-stats-grid">
        <section class="match-details-team-panel">
          <div class="badge badge-info">${escapeHtml(match.home?.name ?? 'Casa')}</div>
          <div class="match-details-player-list">${
            byTeam(match.home_team_id).join('') || '<div class="muted match-details-empty">Nessuna statistica.</div>'
          }</div>
        </section>
        <section class="match-details-team-panel">
          <div class="badge badge-warning">${escapeHtml(match.away?.name ?? 'Ospite')}</div>
          <div class="match-details-player-list">${
            byTeam(match.away_team_id).join('') || '<div class="muted match-details-empty">Nessuna statistica.</div>'
          }</div>
        </section>
      </div>
    `;
  } catch (error) {
    content.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function renderPlayedMatches(matches, emptyMessage = 'Nessun match programmato.') {
  const container = document.getElementById('matches-container');

  if (!matches.length) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(emptyMessage)}</div>`;
    return;
  }

  container.innerHTML = matches
    .map(
      (match) => {
        const dateStr = match.scheduled_at ? formatDateTime(match.scheduled_at) : 'Orario da definire';
        return `
      <button class="match-item" data-match-id="${match.id}" style="display: flex; flex-direction: column; align-items: center; padding: 20px; border-radius: 16px; margin-bottom: 16px; border: 1px solid rgba(0,0,0,0.06); box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); background: white; width: 100%; cursor: pointer; transition: all 0.2s ease; font-family: inherit;">
        <div style="font-size: 0.85rem; color: #6b7280; font-weight: 600; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.05em;">${dateStr}</div>
        <div style="font-size: 1.25rem; font-weight: 800; color: #111827; text-transform: uppercase; letter-spacing: -0.02em; line-height: 1.2; text-align: center;">${escapeHtml(match.home?.name || (match.round_name?.toLowerCase().includes('finale') ? '1° Classif.' : 'non c\'è 6 senza 7'))}</div>
        <div style="display: flex; align-items: center; justify-content: center; margin: 16px 0; width: 100%;">
          <div style="height: 1px; flex-grow: 1; background: linear-gradient(to right, transparent, #e5e7eb);"></div>
          <div style="padding: 6px 20px; background: #f9fafb; border: 1px solid #f3f4f6; border-radius: 9999px; font-size: 0.9rem; font-weight: 800; color: var(--color-primary); margin: 0 20px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); min-width: 80px; text-align: center;">
             ${match.is_finished ? (match.home_score + ' - ' + match.away_score) : 'VS'}
          </div>
          <div style="height: 1px; flex-grow: 1; background: linear-gradient(to left, transparent, #e5e7eb);"></div>
        </div>
        <div style="font-size: 1.25rem; font-weight: 800; color: #111827; text-transform: uppercase; letter-spacing: -0.02em; line-height: 1.2; text-align: center;">${escapeHtml(match.away?.name || (match.round_name?.toLowerCase().includes('finale') ? '2° Classif.' : 'non c\'è 6 senza 7'))}</div>
      </button>
    `}
    )
    .join('');

  container.querySelectorAll('[data-match-id]').forEach((button) => {
    button.addEventListener('click', () => {
      openMatchDetails(button.dataset.matchId);
    });
  });
}

async function loadTournamentData() {
  // Get the single tournament ID
  const sportId = await getFirstActiveSportId();
  state.selectedSportId = sportId;

  if (state.unsubscribe) { // Unsubscribe from previous if any
    state.unsubscribe();
    state.unsubscribe = null;
  }

  const standingsCard = document.getElementById('standings-card');
  const matchesCard = document.getElementById('matches-card');

  if (!sportId) {
    resetPublicTournamentUi();
    document.getElementById('standings-container').innerHTML = '<div class="empty-state">Nessun torneo attivo.</div>';
    document.getElementById('matches-container').innerHTML = '<div class="empty-state">Nessun torneo attivo.</div>';
    setHidden(standingsCard, false);
    setHidden(matchesCard, false);
    return;
  }

  const [sport, teams, matches, config] = await Promise.all([
    loadSportById(sportId),
    loadTeamsBySport(sportId),
    loadMatchesBySport(sportId, { includeUnfinished: true }),
    loadSportConfig(sportId),
  ]);

  const sortedMatches = (matches ?? []).sort((a, b) => {
    // 1. Priorità allo stato: Live (0) > Programmate (1) > Concluse (2)
    const getPriority = (m) => {
      if (m.status === 'live') return 0;
      if (!m.is_finished) return 1;
      return 2;
    };
    const prioA = getPriority(a);
    const prioB = getPriority(b);
    if (prioA !== prioB) return prioA - prioB;

    const timeA = a.scheduled_at ? new Date(a.scheduled_at).getTime() : (prioA === 2 ? 0 : Infinity);
    const timeB = b.scheduled_at ? new Date(b.scheduled_at).getTime() : (prioB === 2 ? 0 : Infinity);

    // 2. Se da giocare/live: ordine cronologico (la più vicina nel futuro prima)
    // 3. Se concluse: ordine cronologico inverso (la più recente prima)
    if (prioA < 2) {
      if (timeA !== timeB) return timeA - timeB;
    } else {
      if (timeA !== timeB) return timeB - timeA;
    }
    return a.id - b.id;
  });

  state.selectedSport = sport;
  updatePublicTournamentUi(sport);

  const isKnockout = sport?.format === 'eliminazione';

  if (isKnockout) {
    renderKnockoutOverview(sortedMatches);
    renderPlayedMatches(sortedMatches, 'Nessun risultato disponibile nel tabellone.');
  } else {
    const standings = computeStandings(teams, sortedMatches, config);
    renderStandingsTable(standings);
    renderPlayedMatches(sortedMatches);
  }

  state.unsubscribe = subscribeTable({
    channelName: `public-sport-${sportId}`,
    table: 'matches',
    event: '*',
    onChange: () => {
      loadTournamentData().catch((error) => showToast(error.message, 'error'));
    },
  });
}

function bindLogin() {
  document.getElementById('admin-access-btn')?.addEventListener('click', () => {
    openModal('modal-login');
  });

  document.getElementById('login-cancel-btn')?.addEventListener('click', () => {
    closeModal('modal-login');
  });

  document.getElementById('login-cancel-btn-2')?.addEventListener('click', () => {
    closeModal('modal-login');
  });

  document.getElementById('login-submit-btn')?.addEventListener('click', async () => {
    const email = document.getElementById('login-email')?.value?.trim();
    const password = document.getElementById('login-pass')?.value;

    if (!email || !password) {
      showToast('Inserisci email e password.', 'error');
      return;
    }

    try {
      await signInAdmin(email, password);
      window.location.href = 'admin.html';
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
}

async function init() {
  bindLogin();

  // Load tournament data directly, no selection needed
  document.getElementById('main-content')?.addEventListener('load', () => { // Use a dummy event listener for initial load
    loadTournamentData().catch((error) => showToast(error.message, 'error'));
  });

  document.getElementById('match-details-close-btn')?.addEventListener('click', () => {
    closeModal('match-details-modal');
  });

  document.getElementById('match-details-modal')?.addEventListener('click', (event) => {
    if (event.target.id === 'match-details-modal') {
      closeModal('match-details-modal');
    }
  });

  await loadTournamentData();
}

init().catch((error) => {
  showToast(error.message, 'error');
});
