import { APP_CONFIG } from './app-config.js';
import { canEditMatches, requireAdmin } from './auth.js';
import { db, run } from './db.js';
import {
  commitLiveUpdate,
  finalizeLiveMatch,
  loadLiveMatch,
  refreshLiveLock,
  releaseLiveSession,
  startLiveSession,
  subscribeLiveMatch,
} from './live.js';
import { debounce, escapeHtml, formatDuration, getEl, showToast } from './utils.js';

const state = {
  user: null,
  admin: null,
  matchId: null,
  match: null,
  config: null,
  homePlayers: [],
  awayPlayers: [],
  playerState: new Map(),
  homeScore: 0,
  awayScore: 0,
  timeouts: { home: 0, away: 0 },
  quarter: 1,
  duration: 0,
  timerInterval: null,
  lockRefreshInterval: null,
  lockVersion: 0,
  hasLock: false,
  editable: false,
  unsubscribe: null,
};

const autosaveSnapshot = debounce(() => {
  saveSnapshot().catch((error) => showToast(error.message, 'error'));
}, APP_CONFIG.liveAutosaveDebounceMs);

function getMatchIdFromQuery() {
  const params = new URLSearchParams(window.location.search);
  return Number(params.get('match') || 0);
}

function setEditable(enabled) {
  state.editable = enabled;
  document.querySelectorAll('[data-requires-edit]').forEach((el) => {
    el.disabled = !enabled;
    el.classList.toggle('hidden', !enabled && el.dataset.hideWhenReadonly === 'true');
  });

  // Rerender rosters so checkbox/star/foul buttons reflect current editable state.
  if (state.match) {
    renderHeader();
    renderRosters();
  }

  const lockStatus = getEl('live-lock-status');
  if (!lockStatus) return;

  if (enabled) {
    lockStatus.className = 'lock-banner editable';
    lockStatus.textContent = 'Sessione editabile: lock acquisito.';
  } else {
    lockStatus.className = 'lock-banner locked';
    lockStatus.textContent = 'Solo lettura: lock attivo su un altro admin.';
  }
}

function ensurePlayer(playerId) {
  if (!state.playerState.has(playerId)) {
    state.playerState.set(playerId, {
      player_id: playerId,
      played: false,
      fouls: 0,
      is_mvp_vote: false,
      points_scored: 0,
      yellow_cards: 0,
      red_cards: 0,
    });
  }
  return state.playerState.get(playerId);
}

function getSportType() {
  return String(state.match?.sport?.sport_type ?? '').trim().toLowerCase();
}

function isBasketMatch() {
  return getSportType() === 'basket';
}

function isVolleyMatch() {
  return getSportType() === 'pallavolo';
}

function isSoccerMatch() {
  return getSportType() === 'calcio';
}

function getMaxFouls() {
  return Math.max(1, Number(state.config?.max_fouls ?? 3));
}

function isPlayerExpelled(entry) {
  const fouls = Number(entry?.fouls ?? 0);
  const redCards = Number(entry?.red_cards ?? 0);
  if (isSoccerMatch()) {
    return redCards > 0;
  }
  return fouls >= getMaxFouls();
}

function getTimeoutLimit() {
  return Math.max(0, Number(state.config?.timeouts_per_team ?? 2));
}

function renderHeader() {
  getEl('live-home-name').textContent = state.match.home?.name ?? 'Casa';
  getEl('live-away-name').textContent = state.match.away?.name ?? 'Ospite';
  getEl('live-home-score').textContent = String(state.homeScore);
  getEl('live-away-score').textContent = String(state.awayScore);
  getEl('live-timer').textContent = formatDuration(state.duration);
  getEl('live-quarter').textContent = `Q${state.quarter}`;
  getEl('live-match-title').textContent = `${state.match.home?.name ?? 'Casa'} vs ${state.match.away?.name ?? 'Ospite'}`;
  getEl('live-match-meta').textContent = `${state.match.round_name ?? '-'} · ${state.match.sport?.name ?? '-'}`;
  const timeoutLimit = getTimeoutLimit();
  getEl('timeout-home-count').textContent = String(state.timeouts.home);
  getEl('timeout-away-count').textContent = String(state.timeouts.away);
  getEl('timeout-limit-label').textContent = `Limite timeout per squadra: ${timeoutLimit}`;
  const disableTimeoutHome = !state.editable || timeoutLimit <= 0 || Number(state.timeouts.home) >= timeoutLimit;
  const disableTimeoutAway = !state.editable || timeoutLimit <= 0 || Number(state.timeouts.away) >= timeoutLimit;
  const homeBtn = getEl('btn-timeout-home');
  const awayBtn = getEl('btn-timeout-away');
  if (homeBtn) homeBtn.disabled = disableTimeoutHome;
  if (awayBtn) awayBtn.disabled = disableTimeoutAway;
}

function renderRosterTable(tableId, players) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  if (!tbody) return;
  const useFouls = !isSoccerMatch();
  const useCards = isSoccerMatch();

  tbody.innerHTML = players
    .map((player) => {
      const rowState = ensurePlayer(player.id);
      const foulClass = rowState.fouls >= getMaxFouls() ? 'foul-pill max' : 'foul-pill';
      const mvpEnabled = Boolean(state.config?.allow_mvp ?? true);
      const allowYellow = Boolean(state.config?.allow_yellow_cards);
      const allowRed = Boolean(state.config?.allow_red_cards);
      const mvpActive = rowState.is_mvp_vote && mvpEnabled ? 'mvp-star active' : 'mvp-star';
      const expelled = isPlayerExpelled(rowState);
      const mvpDisabled = !state.editable || !mvpEnabled || expelled;
      const playedDisabled = !state.editable || expelled;
      const foulDisabled = !state.editable || expelled || rowState.fouls >= getMaxFouls();
      const yellowDisabled = !state.editable || expelled || !allowYellow;
      const redDisabled = !state.editable || expelled || !allowRed;

      return `
      <tr data-player-id="${player.id}" class="${expelled ? 'live-player-expelled' : ''}">
        <td class="text-center"><input type="checkbox" data-action="toggle-played" ${rowState.played ? 'checked' : ''} ${playedDisabled ? 'disabled' : ''}></td>
        <td><strong>${escapeHtml(player.full_name)}</strong></td>
        <td class="text-center ${useFouls ? '' : 'hidden'}" data-col="fouls"><span class="${foulClass}" id="foul-${player.id}">${rowState.fouls}</span></td>
        <td class="text-center"><button class="${mvpActive}" data-action="toggle-mvp" title="${mvpEnabled ? 'Vota MVP' : 'MVP disabilitato nelle impostazioni torneo'}" ${mvpDisabled ? 'disabled' : ''}><i class="fa-solid fa-star"></i></button></td>
        <td class="text-center ${useCards ? '' : 'hidden'}" data-col="cards">
          <div class="live-player-cards">
            <span class="card-pill yellow">Y ${rowState.yellow_cards}</span>
            <span class="card-pill red">R ${rowState.red_cards}</span>
          </div>
        </td>
        <td class="text-center">
          <div class="live-row-actions">
            ${useFouls ? `<button class="btn btn-ghost btn-compact" data-action="add-foul" ${foulDisabled ? 'disabled' : ''}>+F</button>` : ''}
            ${useCards && allowYellow ? `<button class="btn btn-ghost btn-compact" data-action="add-yellow" ${yellowDisabled ? 'disabled' : ''}>+Y</button>` : ''}
            ${useCards && allowRed ? `<button class="btn btn-ghost btn-compact" data-action="add-red" ${redDisabled ? 'disabled' : ''}>+R</button>` : ''}
          </div>
        </td>
      </tr>
      `;
    })
    .join('');
}

function renderRosters() {
  renderRosterTable('table-live-home', state.homePlayers);
  renderRosterTable('table-live-away', state.awayPlayers);
}


function applySportSpecificControls() {
  const isBasket = isBasketMatch();
  const isVolley = isVolleyMatch();
  const isSoccer = isSoccerMatch();

  const quarterVisible = isBasket;
  getEl('live-quarter')?.classList.toggle('hidden', !quarterVisible);
  getEl('quarter-controls')?.classList.toggle('hidden', !quarterVisible);
  getEl('timeouts-controls')?.classList.toggle('hidden', !isBasket);
  getEl('timeout-limit-label')?.classList.toggle('hidden', !isBasket);

  document.querySelectorAll('[data-score-delta="2"], [data-score-delta="3"]').forEach((btn) => {
    btn.classList.toggle('hidden', !isBasket);
  });
  document.querySelectorAll('[data-score-delta="-1"]').forEach((btn) => {
    btn.classList.toggle('hidden', false);
  });

  if (isVolley) {
    getEl('live-match-meta').textContent = `${state.match.round_name ?? '-'} · ${state.match.sport?.name ?? '-'} · Set`;
  } else if (isSoccer) {
    getEl('live-match-meta').textContent = `${state.match.round_name ?? '-'} · ${state.match.sport?.name ?? '-'} · Goal`;
  }

  const showFouls = !isSoccer;
  const showCards = isSoccer;
  document.querySelectorAll('[data-col="fouls"]').forEach((el) => el.classList.toggle('hidden', !showFouls));
  document.querySelectorAll('[data-col="cards"]').forEach((el) => el.classList.toggle('hidden', !showCards));

  const isFinished = Boolean(state.match?.is_finished);
  if (isFinished) {
    setEditable(false);
    getEl('live-lock-status').className = 'lock-banner locked';
    getEl('live-lock-status').textContent = 'Match già finalizzato: modalità sola lettura.';
  }
}
function buildLivePayload() {
  return {
    home_score: state.homeScore,
    away_score: state.awayScore,
    timeouts: {
      home: Number(state.timeouts.home ?? 0),
      away: Number(state.timeouts.away ?? 0),
    },
    duration: state.duration,
    quarter: state.quarter,
    stats_snapshot: buildStatsPayload(),
    updated_at: new Date().toISOString(),
  };
}

function buildStatsPayload() {
  const playersDirectory = new Map(
    [...state.homePlayers, ...state.awayPlayers].map((player) => [
      Number(player.id),
      {
        player_name: player.full_name ?? null,
        team_id: Number(player.team_id ?? 0) || null,
      },
    ])
  );

  return [...state.playerState.values()]
    .filter(
      (entry) =>
        entry.played ||
        entry.fouls > 0 ||
        entry.is_mvp_vote ||
        entry.points_scored > 0 ||
        Number(entry.yellow_cards ?? 0) > 0 ||
        Number(entry.red_cards ?? 0) > 0
    )
    .map((entry) => ({
      ...entry,
      ...(playersDirectory.get(Number(entry.player_id)) ?? {}),
    }));
}
async function saveSnapshot() {
  if (!state.editable) return;

  const result = await commitLiveUpdate({
    matchId: state.matchId,
    payload: buildLivePayload(),
    expectedVersion: state.lockVersion,
  });

  if (result?.success === false) {
    setEditable(false);
    showToast(result?.message || 'Lock perso durante il salvataggio.', 'error');
    return;
  }

  state.lockVersion = Number(result?.new_version ?? state.lockVersion + 1);
}

function applyRemoteMatchUpdate(nextMatch) {
  if (!nextMatch) return;

  const payload = nextMatch.live_payload ?? {};
  state.homeScore = Number(payload.home_score ?? nextMatch.home_score ?? state.homeScore);
  state.awayScore = Number(payload.away_score ?? nextMatch.away_score ?? state.awayScore);
  state.timeouts = {
    home: Number(payload?.timeouts?.home ?? state.timeouts.home ?? 0),
    away: Number(payload?.timeouts?.away ?? state.timeouts.away ?? 0),
  };
  state.duration = Number(payload.duration ?? nextMatch.duration ?? state.duration);
  state.quarter = Number(payload.quarter ?? nextMatch.quarter ?? state.quarter);
  state.lockVersion = Number(nextMatch.lock_version ?? state.lockVersion);
  const snapshotStats = Array.isArray(payload?.stats_snapshot) ? payload.stats_snapshot : [];
  snapshotStats.forEach((entry) => {
    state.playerState.set(Number(entry.player_id), {
      player_id: Number(entry.player_id),
      played: Boolean(entry.played),
      fouls: Number(entry.fouls ?? 0),
      is_mvp_vote: Boolean(entry.is_mvp_vote),
      points_scored: Number(entry.points_scored ?? 0),
      yellow_cards: Number(entry.yellow_cards ?? 0),
      red_cards: Number(entry.red_cards ?? 0),
    });
  });

  renderHeader();
  renderRosters();
}

function updateScore(team, delta) {
  if (!state.editable) return;

  if (team === 'home') {
    state.homeScore = Math.max(0, state.homeScore + delta);
  } else {
    state.awayScore = Math.max(0, state.awayScore + delta);
  }

  renderHeader();
  autosaveSnapshot();
}

function nextQuarter() {
  if (!state.editable || !isBasketMatch()) return;
  state.quarter = Math.min(Number(state.config.quarters_count ?? 4), state.quarter + 1);
  renderHeader();
  autosaveSnapshot();
}

function prevQuarter() {
  if (!state.editable || !isBasketMatch()) return;
  state.quarter = Math.max(1, state.quarter - 1);
  renderHeader();
  autosaveSnapshot();
}

function startTimer() {
  if (!state.editable || state.timerInterval) return;
  const quarterLimit = Math.max(0, Number(state.config?.quarter_duration_sec ?? 0));
  state.timerInterval = window.setInterval(() => {
    if (isBasketMatch() && quarterLimit > 0 && state.duration >= quarterLimit) {
      stopTimer();
      showToast('Tempo del quarto terminato.', 'success');
      return;
    }
    state.duration += 1;
    getEl('live-timer').textContent = formatDuration(state.duration);
    autosaveSnapshot();
  }, 1000);
}

function stopTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
}

function resetTimer() {
  if (!state.editable) return;
  stopTimer();
  state.duration = 0;
  getEl('live-timer').textContent = formatDuration(0);
  autosaveSnapshot();
}

function togglePlayed(playerId, checked) {
  if (!state.editable) return;
  const entry = ensurePlayer(playerId);
  if (isPlayerExpelled(entry)) return;
  entry.played = checked;
  autosaveSnapshot();
}

function toggleMvp(playerId) {
  if (!state.editable || !Boolean(state.config?.allow_mvp ?? true)) return;

  const currentEntry = ensurePlayer(playerId);
  if (isPlayerExpelled(currentEntry)) return;
  const shouldUnset = currentEntry.is_mvp_vote === true;

  for (const value of state.playerState.values()) {
    value.is_mvp_vote = false;
  }

  if (!shouldUnset) {
    currentEntry.is_mvp_vote = true;
  }

  renderRosters();
  autosaveSnapshot();
}

function addFoul(playerId) {
  if (!state.editable) return;
  if (!(isBasketMatch() || isVolleyMatch())) return;

  const entry = ensurePlayer(playerId);
  const maxFouls = getMaxFouls();
  if (isPlayerExpelled(entry) || entry.fouls >= maxFouls) return;

  entry.fouls += 1;
  if (entry.fouls >= maxFouls) {
    entry.played = false;
    entry.is_mvp_vote = false;
  }
  renderRosters();

  if (entry.fouls >= maxFouls) {
    showToast('Giocatore espulso per limite falli.', 'error');
  }

  autosaveSnapshot();
}

function addYellowCard(playerId) {
  if (!isSoccerMatch()) return;
  if (!state.editable || !Boolean(state.config?.allow_yellow_cards)) return;
  const entry = ensurePlayer(playerId);
  if (isPlayerExpelled(entry)) return;
  entry.yellow_cards = Number(entry.yellow_cards ?? 0) + 1;
  renderRosters();
  autosaveSnapshot();
}

function addRedCard(playerId) {
  if (!isSoccerMatch()) return;
  if (!state.editable || !Boolean(state.config?.allow_red_cards)) return;
  const entry = ensurePlayer(playerId);
  if (isPlayerExpelled(entry)) return;
  entry.red_cards = Number(entry.red_cards ?? 0) + 1;
  entry.played = false;
  entry.is_mvp_vote = false;
  renderRosters();
  showToast('Giocatore espulso per cartellino rosso.', 'error');
  autosaveSnapshot();
}

function useTimeout(team) {
  if (!state.editable || !isBasketMatch()) return;
  const limit = getTimeoutLimit();
  if (limit <= 0) return;
  const current = Number(state.timeouts?.[team] ?? 0);
  if (current >= limit) {
    showToast('Timeout esauriti per questa squadra.', 'error');
    return;
  }
  state.timeouts[team] = current + 1;
  renderHeader();
  autosaveSnapshot();
}

async function finalizeMatch() {
  if (!state.editable) return;

  if (['calcio', 'basket', 'pallavolo'].includes(getSportType())) {
    const minPlayers = Math.max(1, Number(state.config?.min_players ?? 1));
    const homePresences = state.homePlayers.filter((player) => Boolean(ensurePlayer(player.id).played)).length;
    const awayPresences = state.awayPlayers.filter((player) => Boolean(ensurePlayer(player.id).played)).length;
    if (homePresences < minPlayers || awayPresences < minPlayers) {
      showToast(`Servono almeno ${minPlayers} presenze per squadra (${homePresences}-${awayPresences}).`, 'error');
      return;
    }
  }

  if (isVolleyMatch()) {
    const totalSets = Math.max(1, Number(state.config?.volley_sets ?? 3));
    const setsToWin = Math.floor(totalSets / 2) + 1;
    const homeSets = Number(state.homeScore ?? 0);
    const awaySets = Number(state.awayScore ?? 0);
    if (homeSets < setsToWin && awaySets < setsToWin) {
      showToast(`Per chiudere il match servono almeno ${setsToWin} set vinti da una squadra.`, 'error');
      return;
    }
    if (homeSets === awaySets) {
      showToast('Impossibile chiudere il match con set in parità.', 'error');
      return;
    }
  }

  if (!confirm('Confermi chiusura e salvataggio definitivo del match?')) {
    return;
  }

  stopTimer();

  const result = await finalizeLiveMatch({
    matchId: state.matchId,
    payload: {
      ...buildLivePayload(),
      home_score: state.homeScore,
      away_score: state.awayScore,
    },
    statsPayload: buildStatsPayload(),
    expectedVersion: state.lockVersion,
  });

  if (result?.success === false) {
    showToast(result?.message || 'Errore finalizzazione match.', 'error');
    return;
  }

  state.lockVersion = Number(result?.new_version ?? state.lockVersion + 1);
  showToast('Match finalizzato con successo.', 'success');
  setTimeout(() => {
    window.location.href = 'admin.html';
  }, 900);
}

function bindLiveControls() {
  getEl('btn-back-admin')?.addEventListener('click', () => {
    window.location.href = 'admin.html';
  });

  document.querySelectorAll('[data-score-team]').forEach((button) => {
    button.addEventListener('click', () => {
      updateScore(button.dataset.scoreTeam, Number(button.dataset.scoreDelta || 0));
    });
  });

  getEl('btn-quarter-next')?.addEventListener('click', nextQuarter);
  getEl('btn-quarter-prev')?.addEventListener('click', prevQuarter);
  getEl('btn-timer-start')?.addEventListener('click', startTimer);
  getEl('btn-timer-stop')?.addEventListener('click', stopTimer);
  getEl('btn-timer-reset')?.addEventListener('click', resetTimer);
  getEl('btn-save-snapshot')?.addEventListener('click', () => {
    saveSnapshot().catch((error) => showToast(error.message, 'error'));
  });
  getEl('btn-finalize-match')?.addEventListener('click', () => {
    finalizeMatch().catch((error) => showToast(error.message, 'error'));
  });
  getEl('btn-timeout-home')?.addEventListener('click', () => useTimeout('home'));
  getEl('btn-timeout-away')?.addEventListener('click', () => useTimeout('away'));

  ['table-live-home', 'table-live-away'].forEach((tableId) => {
    getEl(tableId)?.addEventListener('change', (event) => {
      const row = event.target.closest('tr[data-player-id]');
      if (!row) return;

      const playerId = Number(row.dataset.playerId);
      if (event.target.matches('[data-action="toggle-played"]')) {
        togglePlayed(playerId, event.target.checked);
      }
    });

    getEl(tableId)?.addEventListener('click', (event) => {
      const actionEl = event.target.closest('[data-action]');
      const row = event.target.closest('tr[data-player-id]');
      if (!actionEl || !row) return;

      const playerId = Number(row.dataset.playerId);
      const action = actionEl.dataset.action;

      if (action === 'toggle-mvp') toggleMvp(playerId);
      if (action === 'add-foul') addFoul(playerId);
      if (action === 'add-yellow') addYellowCard(playerId);
      if (action === 'add-red') addRedCard(playerId);
    });
  });
}
async function startLockFlow() {
  const lockResult = await startLiveSession(state.matchId, APP_CONFIG.lockTtlSeconds);
  const lockOwner = lockResult?.lock_owner;
  const currentUserId = state.user?.id;
  const isFinished = Boolean(state.match?.is_finished);

  state.hasLock = Boolean(lockResult?.success) && lockOwner === currentUserId && !isFinished;
  state.lockVersion = Number(lockResult?.lock_version ?? state.match.lock_version ?? 0);

  setEditable(state.hasLock && canEditMatches(state.admin?.ruolo));

  if (isFinished) {
    setEditable(false);
    getEl('live-lock-status').className = 'lock-banner locked';
    getEl('live-lock-status').textContent = 'Match già finalizzato: modalità sola lettura.';
    if (lockOwner === currentUserId) {
      releaseLiveSession(state.matchId).catch(() => undefined);
    }
    return;
  }

  if (!state.editable && lockResult?.message) {
    showToast(lockResult.message, 'error');
  }

  if (state.editable) {
    state.lockRefreshInterval = window.setInterval(() => {
      refreshLiveLock(state.matchId)
        .then((result) => {
          if (result?.success === false) {
            setEditable(false);
          }
        })
        .catch((error) => {
          setEditable(false);
          showToast(error.message, 'error');
        });
    }, APP_CONFIG.lockRefreshSeconds * 1000);
  }
}

async function hydrateFromDatabase() {
  const { match, config, homePlayers, awayPlayers } = await loadLiveMatch(state.matchId);
  const payload = match.live_payload ?? {};
  state.match = match;
  state.config = config;
  state.homePlayers = homePlayers;
  state.awayPlayers = awayPlayers;
  state.homeScore = Number(payload.home_score ?? match.home_score ?? 0);
  state.awayScore = Number(payload.away_score ?? match.away_score ?? 0);
  state.duration = Number(payload.duration ?? match.duration ?? 0);
  state.quarter = Number(payload.quarter ?? match.quarter ?? 1);
  state.timeouts = {
    home: Number(payload?.timeouts?.home ?? 0),
    away: Number(payload?.timeouts?.away ?? 0),
  };
  state.lockVersion = Number(match.lock_version ?? 0);

  const snapshotStats = Array.isArray(payload?.stats_snapshot) ? payload.stats_snapshot : [];
  snapshotStats.forEach((entry) => {
    state.playerState.set(Number(entry.player_id), {
      player_id: Number(entry.player_id),
      played: Boolean(entry.played),
      fouls: Number(entry.fouls ?? 0),
      is_mvp_vote: Boolean(entry.is_mvp_vote),
      points_scored: Number(entry.points_scored ?? 0),
      yellow_cards: Number(entry.yellow_cards ?? 0),
      red_cards: Number(entry.red_cards ?? 0),
    });
  });

  const { data: stats } = await run(
    db.from('match_stats').select('*').eq('match_id', state.matchId),
    'Caricamento statistiche esistenti'
  );

  (stats ?? []).forEach((entry) => {
    state.playerState.set(Number(entry.player_id), {
      player_id: Number(entry.player_id),
      played: Boolean(entry.played),
      fouls: Number(entry.fouls ?? 0),
      is_mvp_vote: Boolean(entry.is_mvp_vote),
      points_scored: Number(entry.points_scored ?? 0),
      yellow_cards: Number(entry.yellow_cards ?? 0),
      red_cards: Number(entry.red_cards ?? 0),
    });
  });

  for (const value of state.playerState.values()) {
    if (isPlayerExpelled(value)) {
      value.played = false;
      value.is_mvp_vote = false;
    }
  }

  if (!Boolean(state.config?.allow_mvp ?? true)) {
    for (const value of state.playerState.values()) {
      value.is_mvp_vote = false;
    }
  }

  renderHeader();
  renderRosters();
  applySportSpecificControls();
}

function setupRealtime() {
  state.unsubscribe = subscribeLiveMatch(state.matchId, (payload) => {
    if (payload?.new?.id && Number(payload.new.id) === Number(state.matchId)) {
      applyRemoteMatchUpdate(payload.new);
    }
  });
}

function setupUnloadRelease() {
  window.addEventListener('beforeunload', () => {
    if (state.hasLock) {
      releaseLiveSession(state.matchId).catch(() => undefined);
    }
  });
}

async function init() {
  const guard = await requireAdmin({ redirectTo: 'index.html' });
  if (!guard.allowed) return;

  state.user = guard.user;
  state.admin = guard.admin;

  state.matchId = getMatchIdFromQuery();
  if (!state.matchId) {
    throw new Error('ID match mancante. Apri live da Dashboard Admin.');
  }

  bindLiveControls();
  await hydrateFromDatabase();
  await startLockFlow();
  setupRealtime();
  setupUnloadRelease();
}

init().catch((error) => {
  showToast(error.message, 'error');
});
