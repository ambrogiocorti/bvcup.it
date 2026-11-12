﻿import { requireAdmin, signOutAdmin, canEditMatches, canManageAll } from './auth.js';
import {
  createManualMatch,
  deleteMatch,
  deleteTeam,
  generateMatchesForSport,
  generateSemifinals,
  listMatchesForAdmin,
  loadPlayersByTeam,
  loadSportById,
  loadSportConfig,
  loadSports,
  loadTeamsBySport,
  saveTeam,
  upsertSportConfig,
  getFirstActiveSportId,
} from './matches.js'; // Added getFirstActiveSportId
import {
  applyCsvImport,
  downloadCsvTemplate,
  getCsvModeInfo,
  previewCsvImport,
} from './csv-import.js';
import { TEAM_SPORTS } from './app-config.js';
import { db, run } from './db.js';
import { escapeHtml, getEl, medalByRank, showToast, formatDateTime } from './utils.js';
const state = {
  admin: null,
  sports: [],
  singleTournamentId: null,
  cachedPlayersRanking: [],
  selectedEventId: null,
  csvPreview: null,
  athleticsReport: null,
  reportColumnPrefs: {},
};
const MOBILE_MENU_BREAKPOINT = 1024;

const CSV_MODE_META = {
  teams_players: {
    successMessage: 'Import CSV team/giocatori completato.',
    sportType: 'any',
  },
};

const SPORT_TYPE_LABELS = {
  pallavolo: 'Pallavolo',
};

const FORMAT_LABELS = {
  gironi: 'Gironi',
  eliminazione: 'Eliminazione diretta',
};

function openModal(id) {
  getEl(id)?.classList.add('open');
}

function closeModal(id) {
  getEl(id)?.classList.remove('open');
}

function resetFormValues(form) {
  if (!form) return;
  form.reset();
  form.querySelectorAll('input[type="hidden"]').forEach((input) => {
    input.value = '';
  });
}

function getCsvMode() {
  return getEl('csv-import-mode')?.value ?? '';
}

function resetCsvImportUi() {
  state.csvPreview = null;

  const fileInput = getEl('input-csv-file');
  if (fileInput) fileInput.value = '';

  getEl('csv-import-file-name').textContent = 'Nessun file selezionato.';
  getEl('csv-import-summary').textContent =
    'Carica un file CSV e clicca Anteprima per vedere validazioni e righe importabili.';
  getEl('csv-import-report').innerHTML = '';
  getEl('btn-csv-confirm-import').disabled = true;
  getEl('btn-csv-preview').disabled = false;

  const previewHead = document.querySelector('#csv-preview-table thead');
  const previewBody = document.querySelector('#csv-preview-table tbody');
  if (previewHead) previewHead.innerHTML = '';
  if (previewBody) previewBody.innerHTML = '';
}

function renderCsvPreviewTable(preview) {
  const previewHead = document.querySelector('#csv-preview-table thead');
  const previewBody = document.querySelector('#csv-preview-table tbody');
  if (!previewHead || !previewBody) return;

  const headerHtml = [
    '<th class="text-center">Riga</th>',
    ...(preview.headers ?? []).map((header) => `<th>${escapeHtml(header)}</th>`),
  ].join('');
  previewHead.innerHTML = `<tr>${headerHtml}</tr>`;

  const rowsHtml = (preview.previewRows ?? [])
    .map((row) => {
      const values = (row.values ?? []).map((value) => `<td>${escapeHtml(value)}</td>`).join('');
      return `<tr><td class="text-center">${row.rowNumber}</td>${values}</tr>`;
    })
    .join('');

  previewBody.innerHTML = rowsHtml || '<tr><td colspan="99" class="empty-state">Nessuna riga disponibile.</td></tr>';
}

function renderCsvValidationReport(validation) {
  const report = getEl('csv-import-report');
  if (!report) return;

  const cards = [];
  const errors = validation?.errors ?? [];
  const warnings = validation?.warnings ?? [];

  if (errors.length) {
    const list = errors
      .slice(0, 12)
      .map((err) => `<div>Riga ${err.row ?? '-'}: ${escapeHtml(err.message)}</div>`)
      .join('');
    cards.push(`<div class="report-card error"><strong>Errori (${errors.length})</strong>${list}</div>`);
  }

  if (warnings.length) {
    const list = warnings
      .slice(0, 8)
      .map((warn) => `<div>${warn.row ? `Riga ${warn.row}: ` : ''}${escapeHtml(warn.message)}</div>`)
      .join('');
    cards.push(`<div class="report-card warning"><strong>Avvisi (${warnings.length})</strong>${list}</div>`);
  }

  if (!cards.length) {
    cards.push('<div class="report-card">Nessun errore bloccante rilevato.</div>');
  }

  report.innerHTML = cards.join('');
}

function renderCsvSummary(preview) {
  const summaryEl = getEl('csv-import-summary');
  if (!summaryEl) return;

  const stats = preview.validation?.stats ?? {};
  const validRows = Number(stats.validRows ?? 0);
  const invalidRows = Number(stats.invalidRows ?? 0);
  const totalRows = Number(preview.totalRows ?? 0);

  summaryEl.innerHTML = `
    File: <strong>${escapeHtml(preview.fileName ?? '-')}</strong> · Delimitatore: <strong>${escapeHtml(preview.delimiter ?? ';')}</strong><br>
    Righe dati: <strong>${totalRows}</strong> · Valide: <strong>${validRows}</strong> · Scartate: <strong>${invalidRows}</strong>
  `;
}

function getCsvSportsForMode(mode) {
  if (CSV_MODE_META[mode]?.sportType === 'atletica') {
    return state.sports.filter((sport) => sport.sport_type === 'atletica');
  }
  return [...state.sports];
}

function getDefaultCsvSportId(mode, sports) {
  if (!sports.length) return '';
  if (mode === 'teams_players') {
    return (
      getEl('select-sport-team')?.value ||
      getEl('settings-sport-select')?.value ||
      getEl('report-sport-select')?.value ||
      String(sports[0].id)
    );
  }
  return (
    getEl('athletics-sport-select')?.value ||
    getEl('event-sport-select')?.value ||
    String(sports[0].id)
  );
}

function openCsvImportModal(mode) {
  const modeMeta = CSV_MODE_META[mode];
  if (!modeMeta) return;
  const modeInfo = getCsvModeInfo(mode);

  const sports = getCsvSportsForMode(mode);
  const sportSelect = getEl('csv-import-sport-select');
  const titleEl = getEl('csv-import-title');

  if (titleEl) titleEl.textContent = modeInfo.title;
  getEl('csv-import-mode').value = mode;

  sportSelect.innerHTML =
    '<option value="">-- Seleziona --</option>' +
    sports.map((sport) => `<option value="${sport.id}">${escapeHtml(sport.name)}</option>`).join('');

  const defaultSportId = getDefaultCsvSportId(mode, sports);
  if (defaultSportId) {
    sportSelect.value = String(defaultSportId);
  }

  resetCsvImportUi();
  getEl('csv-import-summary').textContent = `Formato atteso: ${modeInfo.allFields.join('; ')}. Carica un CSV e clicca Anteprima.`;
  openModal('modal-csv-import');
}
function getCsvImportContext() {
  return {
    mode: getCsvMode(),
    sportId: state.singleTournamentId, // Use the single tournament ID
  };
}
async function handleCsvPreview() {
  const file = getEl('input-csv-file')?.files?.[0];
  const context = getCsvImportContext();
  const mode = context.mode;

  if (!mode) throw new Error('Modalità import non impostata.');
  if (!context.sportId) throw new Error('Seleziona un torneo prima di proseguire.');

  getEl('btn-csv-preview').disabled = true;
  try {
    const preview = await previewCsvImport(mode, file, context);
    state.csvPreview = { ...preview, sportId: context.sportId, mode };
    renderCsvPreviewTable(preview);
    renderCsvSummary(preview);
    renderCsvValidationReport(preview.validation);

    const canConfirm =
      Number(preview.validation?.stats?.validRows ?? 0) > 0 &&
      Number(preview.validation?.stats?.errors ?? 0) === 0;
    getEl('btn-csv-confirm-import').disabled = !canConfirm;
  } finally {
    getEl('btn-csv-preview').disabled = false;
  }
}
async function handleCsvConfirmImport() {
  const context = getCsvImportContext();
  const mode = context.mode;
  if (!mode) throw new Error('Modalità import non impostata.');
  if (!context.sportId) throw new Error('Seleziona un torneo prima di confermare.');
  if (!state.csvPreview) throw new Error('Esegui prima l\'anteprima del file CSV.');
  if (state.csvPreview.mode !== mode || Number(state.csvPreview.sportId) !== context.sportId) {
    throw new Error('Hai cambiato torneo o tipo import: rifai l\'anteprima prima di confermare.');
  }

  const validRows = state.csvPreview.validation?.validRows ?? [];
  if (!validRows.length) throw new Error('Nessuna riga valida da importare.');

  getEl('btn-csv-confirm-import').disabled = true;
  const result = await applyCsvImport(mode, validRows, context);

  await Promise.all([
    loadTeamsTable(), // Refresh teams table
    // loadEventsSection() removed as athletics is removed
  ]);

  const msg = CSV_MODE_META[mode]?.successMessage ?? 'Import CSV completato.';
  showToast(
    `${msg} Inseriti: ${result.inserted ?? 0}, aggiornati: ${result.updated ?? 0}, saltati: ${result.skipped ?? 0}.`,
    'success'
  );

  closeModal('modal-csv-import');
}
function switchView(viewId) {
  document.querySelectorAll('.view-section').forEach((section) => section.classList.remove('active'));
  document.querySelectorAll('.sidebar-link').forEach((link) => link.classList.remove('active'));
  getEl(`view-${viewId}`)?.classList.add('active');
  document.querySelector(`.sidebar-link[data-view="${viewId}"]`)?.classList.add('active');

  if (viewId === 'matches') loadMatchesTable();
  if (viewId === 'teams') loadTeamsTable();
  if (viewId === 'settings') loadSettingsForSelectedSport();
}

function getSportById(sportId) {
  return state.sports.find((item) => Number(item.id) === Number(sportId));
}

function formatRoleLabel(role) {
  if (role === 'super_admin') return 'Super Admin';
  if (role === 'match_manager') return 'Match Manager';
  if (role === 'report_viewer') return 'Report Viewer';
  return 'Ruolo non assegnato';
}

function formatAdminDisplayName(admin) {
  const explicitName = String(admin?.nome ?? '').trim();
  if (explicitName) return explicitName;

  const email = String(admin?.email ?? '').trim();
  if (!email) return 'Amministratore';

  return email.split('@')[0];
}

const isMobileLayout = () => {
  return window.matchMedia(`(max-width: ${MOBILE_MENU_BREAKPOINT}px)`).matches;
}

function setSidebarOpen(open) {
  const shell = document.querySelector('.admin-shell');
  const toggle = getEl('btn-mobile-menu');
  if (!shell) return;

  const shouldOpen = Boolean(open) && isMobileLayout();
  shell.classList.toggle('menu-open', shouldOpen);
  document.body.classList.toggle('no-scroll', shouldOpen);

  if (toggle) {
    toggle.setAttribute('aria-expanded', String(shouldOpen));
    const icon = toggle.querySelector('i');
    icon?.classList.toggle('fa-bars', !shouldOpen);
    icon?.classList.toggle('fa-xmark', shouldOpen);
  }
}

function bindMobileSidebar() {
  const shell = document.querySelector('.admin-shell');
  const toggle = getEl('btn-mobile-menu');
  const backdrop = getEl('sidebar-backdrop');
  if (!shell || !toggle || !backdrop) return;

  toggle.addEventListener('click', () => {
    const currentlyOpen = shell.classList.contains('menu-open');
    setSidebarOpen(!currentlyOpen);
  });

  backdrop.addEventListener('click', () => setSidebarOpen(false));

  window.addEventListener('resize', () => {
    if (!isMobileLayout()) {
      setSidebarOpen(false);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setSidebarOpen(false);
  });
}

function applyRolePermissions() {
  const role = state.admin?.ruolo;
  const matchWrite = canEditMatches(role);
  const fullWrite = canManageAll(role);

  document.querySelectorAll('[data-requires-match-write]').forEach((el) => {
    el.classList.toggle('hidden', !matchWrite); // Match managers can write matches
  });
  document.querySelectorAll('[data-requires-admin-write]').forEach((el) => { // Super admins can do everything else
    el.classList.toggle('hidden', !fullWrite);
  });

  if (!fullWrite) {
    ['teams', 'settings'].forEach((view) => {
      document.querySelector(`.sidebar-link[data-view="${view}"]`)?.classList.add('hidden');
    });
  }
  if (!matchWrite && !fullWrite) { // If not match manager or super admin, hide matches too
    document.querySelector('.sidebar-link[data-view="matches"]')?.classList.add('hidden');
  }
}

function bindSidebar() {
  document.querySelectorAll('.sidebar-link[data-view]').forEach((button) => {
    button.addEventListener('click', () => {
      const view = button.dataset.view;
      if (view) switchView(view);
      if (isMobileLayout()) setSidebarOpen(false);
    });
  });
}

function getTeamSports() {
  return state.sports.filter((sport) =>
    TEAM_SPORTS.includes(String(sport?.sport_type ?? '').trim().toLowerCase())
  );
}

function updateSingleTournamentUI(tournamentId, tournamentName) {
  // IDs che necessitano del valore dell'unico torneo
  const ids = ['select-sport-team', 'select-sport-match', 'playoff-sport-select', 'settings-sport-select', 'csv-import-sport-select'];
  ids.forEach(id => {
    const el = getEl(id);
    if (el) el.value = tournamentId;
  });

  // Update visible labels/placeholders if needed
  const playoffLabel = document.querySelector('label[for="playoff-sport-select"]');
  if (playoffLabel) {
    playoffLabel.textContent = `Torneo: ${tournamentName}`;
  }

  const sportTypeEl = getEl('settings-selected-sport-type');
  if (sportTypeEl) sportTypeEl.value = SPORT_TYPE_LABELS['pallavolo'];

  const formatEl = getEl('settings-selected-format');
  if (formatEl) formatEl.value = FORMAT_LABELS['gironi']; // Formato di default

  // For the match filter, we can just set the value and disable it
  const filterMatchSport = getEl('filter-match-sport');
  if (filterMatchSport) {
    filterMatchSport.innerHTML = `<option value="${tournamentId}">${escapeHtml(tournamentName)}</option>`;
    filterMatchSport.value = tournamentId;
    filterMatchSport.disabled = true;
  }
}

async function refreshSportsState() {
  state.sports = await loadSports({ includeInactive: true });
}

async function loadTeamsTable() {
  let query = db.from('teams').select('*, sports(name)').order('name', { ascending: true });
  
  if (state.singleTournamentId) {
    query = query.eq('sport_id', state.singleTournamentId);
  }

  const { data: teams } = await run(query, 'Caricamento tabella squadre');

  const body = getEl('table-teams-body');
  if (!body) return;

  body.innerHTML = (teams ?? [])
    .map(
      (team) => `
      <tr>
        <td><strong>${escapeHtml(team.name)}</strong></td>
        <td>${escapeHtml(team.sports?.name ?? '-')}</td>
        <td>
          <div class="table-actions" ${canManageAll(state.admin?.ruolo) ? '' : 'style="display:none"'}>
            <button class="icon-btn edit" data-action="edit-team" data-id="${team.id}" data-name="${escapeHtml(team.name)}" data-sport-id="${team.sport_id}"><i class="fa-solid fa-pen"></i></button>
            <button class="icon-btn delete" data-action="delete-team" data-id="${team.id}"><i class="fa-solid fa-trash"></i></button>
          </div>
        </td>
      </tr>
    `
    )
    .join('');
}

function renderMatchesTableRows(rows) {
  const body = getEl('table-matches-list');
  if (!body) return;

  body.innerHTML = rows
    .map((match) => {
      const isFinished = Boolean(match.is_finished);
      const dateStr = match.scheduled_at ? formatDateTime(match.scheduled_at) : '<span class="muted">Da definire</span>';
      const actions = [];

      if (!isFinished && canEditMatches(state.admin?.ruolo)) {
        actions.push(`<button class="icon-btn live" data-action="start-live" data-id="${match.id}" title="Apri live"><i class="fa-solid fa-play"></i></button>`);
      }
      if (canEditMatches(state.admin?.ruolo)) {
        actions.push(`<button class="icon-btn delete" data-action="delete-match" data-id="${match.id}" title="Elimina"><i class="fa-solid fa-trash"></i></button>`);
      }

      return `
      <tr>
        <td><div style="font-size:0.85rem; font-weight:600">${dateStr}</div></td>
        <td>
          <strong>
            ${escapeHtml(match.home?.name || (match.round_name?.toLowerCase().includes('finale') ? '1° Classif.' : 'non c\'è 6 senza 7'))} 
            vs 
            ${escapeHtml(match.away?.name || (match.round_name?.toLowerCase().includes('finale') ? '2° Classif.' : 'non c\'è 6 senza 7'))}
          </strong>
          <div class="muted" style="font-size:0.8rem;">${escapeHtml(match.round_name ?? '-')}</div>
        </td>
        <td><span class="score-chip">${isFinished ? `${match.home_score ?? 0} - ${match.away_score ?? 0}` : '- -'}</span></td>
        <td>${isFinished ? '<span class="badge badge-success">Finale</span>' : '<span class="badge badge-info">Da giocare</span>'}</td>
        <td><div class="table-actions">${actions.join('')}</div></td>
      </tr>`;
    })
    .join('');
}

async function loadMatchesTable() {
  const filters = {
    teamSearch: getEl('filter-match-team')?.value ?? '',
    sportId: getEl('filter-match-sport')?.value ?? 'all',
    phase: getEl('filter-match-phase')?.value ?? 'all',
    status: getEl('filter-match-status')?.value ?? 'all',
  };

  const rows = await listMatchesForAdmin(filters);
  renderMatchesTableRows(rows);
}

function renderPlayerRankingTable(rows) {
  const body = document.querySelector('#report-table-students tbody');
  if (!body) return;

  body.innerHTML = rows.map((player, index) => `
      <tr>
        <td data-col-group="team_students" data-col="rank">${index + 1}</td>
        <td data-col-group="team_students" data-col="student"><strong>${escapeHtml(player.name)}</strong></td>
        <td data-col-group="team_students" data-col="class">${escapeHtml(player.team)}</td>
        <td class="text-center" data-col-group="team_students" data-col="presence">${player.presencePct}%</td>
        <td class="text-center" data-col-group="team_students" data-col="fouls">${player.fouls}</td>
        <td class="text-center" data-col-group="team_students" data-col="mvp">${player.mvpVotes}</td>
        <td class="text-center" data-col-group="team_students" data-col="score"><span class="score-chip">${player.score}</span></td>
      </tr>
    `).join('');

  applyReportColumnVisibility();
}

function renderTeamReportTable(rows) {
  const body = document.querySelector('#report-table-teams tbody');
  if (!body) return;

  body.innerHTML = rows.map((row) => `
      <tr>
        <td data-col-group="team_standings" data-col="position">${medalByRank(row.rank - 1)}</td>
        <td data-col-group="team_standings" data-col="team"><strong>${escapeHtml(row.name)}</strong></td>
        <td class="text-center" data-col-group="team_standings" data-col="points">${row.points}</td>
        <td class="text-center" data-col-group="team_standings" data-col="played">${row.played}</td>
        <td class="text-center" data-col-group="team_standings" data-col="wins">${row.wins}</td>
        <td class="text-center" data-col-group="team_standings" data-col="draws">${row.draws}</td>
        <td class="text-center" data-col-group="team_standings" data-col="losses">${row.losses}</td>
        <td class="text-center" data-col-group="team_standings" data-col="goal_diff">${row.goalDiff}</td>
      </tr>
    `).join('');

  applyReportColumnVisibility();
}

function isCurrentReportAthletics() {
  const sportId = state.singleTournamentId;
  if (!sportId) return false;
  const sport = getSportById(sportId);
  return sport?.sport_type === 'atletica';
}

function getAthleticsReportFilters() {
  const selectedPlayerValue = String(getEl('rep-ath-player-select')?.value ?? 'all');
  const selectedPlayerId = selectedPlayerValue !== 'all' ? Number(selectedPlayerValue) : null;
  const searchTerm = String(getEl('rep-ath-player-search')?.value ?? '').trim().toLowerCase();
  const selectedEventId = String(getEl('rep-ath-event-select')?.value ?? 'all');
  const selectedTeam = String(getEl('rep-ath-team-select')?.value ?? 'all');

  return {
    selectedPlayerId: Number.isFinite(selectedPlayerId) && Number(selectedPlayerId) > 0
      ? Number(selectedPlayerId)
      : null,
    searchTerm,
    selectedEventId: selectedEventId !== 'all' ? Number(selectedEventId) : null,
    selectedTeam,
  };
}

function playerMatchesAthleticsFilters(row, filters) {
  if (!row) return false;
  if (filters.selectedTeam !== 'all' && row.teamName !== filters.selectedTeam) return false;
  if (filters.selectedPlayerId) return Number(row.playerId) === filters.selectedPlayerId;
  if (filters.searchTerm) {
    return String(row.playerName ?? '').toLowerCase().includes(filters.searchTerm);
  }
  return true;
}

function buildAthleticsAggregation(events, config, filters) {
  const minEvents = Math.max(0, Number(config?.athletics_min_events_per_player ?? 1));
  const maxEvents = Math.max(minEvents || 1, Number(config?.athletics_max_events_per_player ?? 99));
  const byPlayer = new Map();
  const allEvents = events ?? [];
  const filteredEvents = allEvents.filter((eventItem) => {
    if (!filters.selectedEventId) return true;
    return Number(eventItem.id) === filters.selectedEventId;
  });
  const selectedEventPlayerIds = new Set();

  const eventCards = filteredEvents.map((eventItem) => {
    const baseRows = [...(eventItem.results ?? [])].sort(
      (a, b) => Number(a.rank ?? 0) - Number(b.rank ?? 0)
    );
    baseRows.forEach((row) => {
      const playerId = Number(row.playerId);
      if (playerId > 0) selectedEventPlayerIds.add(playerId);
    });

    const filteredRows = baseRows
      .filter((row) => playerMatchesAthleticsFilters(row, filters))
      .slice(0, 3);

    return {
      ...eventItem,
      filteredRows,
    };
  });

  allEvents.forEach((eventItem) => {
    const baseRows = [...(eventItem.results ?? [])].sort(
      (a, b) => Number(a.rank ?? 0) - Number(b.rank ?? 0)
    );

    baseRows.forEach((row) => {
      const key = Number(row.playerId);
      if (!Number.isFinite(key) || key <= 0) return;

      const existing = byPlayer.get(key) ?? {
        playerId: key,
        playerName: row.playerName,
        teamName: row.teamName,
        events: 0,
        score: 0,
        medals: { gold: 0, silver: 0, bronze: 0 },
      };

      existing.events += 1;

      const eventRank = Number(row.rank ?? 0);
      if (eventRank === 1) {
        existing.score += 3;
        existing.medals.gold += 1;
      } else if (eventRank === 2) {
        existing.score += 2;
        existing.medals.silver += 1;
      } else if (eventRank === 3) {
        existing.score += 1;
        existing.medals.bronze += 1;
      }

      byPlayer.set(key, existing);
    });
  });

  const rankingAll = [...byPlayer.values()]
    .map((row) => ({
      ...row,
      isQualified: row.events >= minEvents && row.events <= maxEvents,
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.medals.gold - a.medals.gold ||
        b.medals.silver - a.medals.silver ||
        b.medals.bronze - a.medals.bronze ||
        a.playerName.localeCompare(b.playerName, 'it', { sensitivity: 'base' })
    )
    .map((row, index) => ({
      ...row,
      rank: index + 1,
    }));

  const rankingQualified = rankingAll
    .filter((row) => row.isQualified)
    .map((row, index) => ({
      ...row,
      rank: index + 1,
    }));

  const rankingFiltered = rankingQualified.filter((row) => {
    if (!playerMatchesAthleticsFilters(row, filters)) return false;
    if (filters.selectedEventId && !selectedEventPlayerIds.has(Number(row.playerId))) return false;
    return true;
  });

  return {
    eventCards,
    rankingAll,
    rankingQualified,
    rankingFiltered,
    minEvents,
    maxEvents,
  };
}

function renderAthleticsEventsCards(eventCards) {
  const container = getEl('report-ath-events-container');
  if (!container) return;

  if (!(eventCards ?? []).length) {
    container.innerHTML = '<div class="empty-state">Nessun evento disponibile con i filtri selezionati.</div>';
    return;
  }

  container.innerHTML = `
    <div class="ath-report-events-grid">
      ${eventCards
        .map((eventItem) => {
          const topRowsHtml = (eventItem.filteredRows ?? []).length
            ? eventItem.filteredRows
                .map(
                  (row) => `
                    <div class="ath-report-top-row">
                      <span>${medalByRank(Math.max(Number(row.rank ?? 1) - 1, 0))} ${escapeHtml(row.playerName)}</span>
                      <span class="muted">(${Number(row.value ?? 0).toFixed(2)})</span>
                    </div>
                  `
                )
                .join('')
            : '<div class="muted">Nessun risultato per i filtri correnti.</div>';

          return `
            <article class="ath-report-event-card">
              <h4 class="ath-report-event-title">${escapeHtml(eventItem.name)}</h4>
              <div class="ath-report-event-meta">
                Unità: ${escapeHtml(eventItem.unit)} · Ordinamento: ${eventItem.sort_order === 'asc' ? 'minore è migliore' : 'maggiore è migliore'}
              </div>
              <div class="ath-report-top-list">
                ${topRowsHtml}
              </div>
            </article>
          `;
        })
        .join('')}
    </div>
  `;
}

function renderAthleticsRankingTable(rankingRows) {
  const body = getEl('report-ath-ranking-body');
  if (!body) return;

  if (!(rankingRows ?? []).length) {
    body.innerHTML = '<tr><td colspan="6" class="empty-state">Nessun atleta trovato per i filtri selezionati.</td></tr>';
    applyReportColumnVisibility();
    return;
  }

  body.innerHTML = rankingRows
    .map((row) => `
      <tr>
        <td data-col-group="athletics" data-col="position">${medalByRank(Math.max(Number(row.rank ?? 1) - 1, 0))}</td>
        <td data-col-group="athletics" data-col="student"><strong>${escapeHtml(row.playerName)}</strong></td>
        <td data-col-group="athletics" data-col="class">${escapeHtml(row.teamName)}</td>
        <td class="text-center" data-col-group="athletics" data-col="events">${row.events}</td>
        <td class="text-center" data-col-group="athletics" data-col="medals">O ${row.medals.gold} · A ${row.medals.silver} · B ${row.medals.bronze}</td>
        <td class="text-center" data-col-group="athletics" data-col="points"><strong>${row.score}</strong></td>
      </tr>
    `)
    .join('');

  applyReportColumnVisibility();
}

function applyAthleticsReportFilters() {
  if (!state.athleticsReport) return;
  const filters = getAthleticsReportFilters();
  const aggregation = buildAthleticsAggregation(state.athleticsReport.events, state.athleticsReport.config, filters);
  renderAthleticsEventsCards(aggregation.eventCards);
  renderAthleticsRankingTable(aggregation.rankingFiltered);
}

function applyReportFilters() {
  if (isCurrentReportAthletics()) {
    applyAthleticsReportFilters();
    return;
  }

  const teamFilter = getEl('rep-filter-team')?.value ?? 'all';
  const presenceFilter = getEl('rep-filter-pres')?.value ?? 'all';
  const foulsFilter = getEl('rep-filter-fouls')?.value ?? 'all';
  const scoreFilter = getEl('rep-filter-score')?.value ?? 'all';

  const filtered = state.cachedPlayersRanking.filter((row) => {
    if (teamFilter !== 'all' && row.team !== teamFilter) return false;
    if (presenceFilter !== 'all') {
      const [min, max] = presenceFilter.split('-').map(Number);
      if (row.presencePct < min || row.presencePct > max) return false;
    }
    if (foulsFilter !== 'all') {
      if (foulsFilter === '3' && row.fouls < 3) return false;
      if (foulsFilter !== '3' && row.fouls !== Number(foulsFilter)) return false;
    }
    if (scoreFilter !== 'all') {
      const [min, max] = scoreFilter.split('-').map(Number);
      if (row.score < min || row.score > max) return false;
    }
    return true;
  }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));

  renderPlayerRankingTable(filtered);
}

function renderAthleticsReportFilterOptions(reportDataset) {
  const playerSelect = getEl('rep-ath-player-select');
  const eventSelect = getEl('rep-ath-event-select');
  const teamSelect = getEl('rep-ath-team-select');

  const players = [...(reportDataset?.players ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name, 'it', { sensitivity: 'base' })
  );
  const events = [...(reportDataset?.events ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name, 'it', { sensitivity: 'base' })
  );
  const teams = [...(reportDataset?.teams ?? [])].sort((a, b) =>
    a.localeCompare(b, 'it', { sensitivity: 'base' })
  );

  if (playerSelect) {
    playerSelect.innerHTML =
      '<option value="all">Tutti</option>' +
      players
        .map((player) => `<option value="${player.id}">${escapeHtml(player.name)} · ${escapeHtml(player.teamName)}</option>`)
        .join('');
    playerSelect.value = 'all';
  }

  if (eventSelect) {
    eventSelect.innerHTML =
      '<option value="all">Tutti</option>' +
      events.map((eventItem) => `<option value="${eventItem.id}">${escapeHtml(eventItem.name)}</option>`).join('');
    eventSelect.value = 'all';
  }

  if (teamSelect) {
    teamSelect.innerHTML =
      '<option value="all">Tutte</option>' +
      teams.map((teamName) => `<option value="${escapeHtml(teamName)}">${escapeHtml(teamName)}</option>`).join('');
    teamSelect.value = 'all';
  }

  const playerSearch = getEl('rep-ath-player-search');
  if (playerSearch) playerSearch.value = '';
}

async function loadReportData() {
  // Rimosso per pulizia report.
}
function getSportFormData() {
  return {
    id: getEl('edit-sport-id').value || null,
    name: getEl('input-sport-name').value.trim(),
    year: Number(getEl('input-sport-year').value || 0),
    sport_type: getEl('input-sport-type').value,
    format: getEl('input-sport-format').value,
    gender: getEl('input-sport-gender').value,
    has_return_match: getEl('input-sport-return').checked,
    is_active: getEl('input-sport-active').checked,
  };
}

function openSportModal(sport = null) {
  resetFormValues(getEl('form-sport'));
  if (sport) {
    getEl('title-modal-sport').textContent = 'Modifica Torneo';
    getEl('edit-sport-id').value = sport.id;
    getEl('input-sport-name').value = sport.name ?? '';
    getEl('input-sport-year').value = sport.year ?? new Date().getFullYear();
    getEl('input-sport-type').value = sport.sport_type ?? 'calcio';
    getEl('input-sport-format').value = sport.format ?? 'gironi';
    getEl('input-sport-gender').value = sport.gender ?? 'Misto';
    getEl('input-sport-return').checked = Boolean(sport.has_return_match);
    getEl('input-sport-active').checked = Boolean(sport.is_active);
  } else {
    getEl('title-modal-sport').textContent = 'Nuovo Torneo';
    getEl('input-sport-type').value = 'pallavolo'; // Default to Beach Volley
    getEl('input-sport-year').value = new Date().getFullYear(); // Default to current year
    getEl('input-sport-active').checked = true;
  }
  openModal('modal-sport');
}

async function handleSaveSport(event) {
  event.preventDefault();
  const payload = getSportFormData();
  if (!payload.name || !payload.year || !payload.sport_type || !payload.format) {
    showToast('Compila tutti i campi obbligatori del torneo.', 'error');
    return;
  }
  await saveSport(payload);
  closeModal('modal-sport');
  await refreshSportsState();
  await loadSportsTable();
  showToast('Torneo salvato.', 'success');
}

async function handleDeleteSport(sportId) {
  if (!confirm('Confermi eliminazione torneo?')) return;
  await deleteSport(sportId);
  await refreshSportsState();
  await loadSportsTable();
  showToast('Torneo eliminato.', 'success');
}

async function openTeamModal(team = null) {
  resetFormValues(getEl('form-team'));
  if (team) {
    getEl('title-modal-team').textContent = 'Modifica Squadra';
    getEl('edit-team-id').value = team.id;
    getEl('input-team-name').value = team.name ?? '';
    getEl('select-sport-team').value = String(team.sport_id);
    const players = await loadPlayersByTeam(team.id);
    getEl('input-players-list').value = players.map((item) => item.full_name).join(', ');
  } else {
    getEl('title-modal-team').textContent = 'Nuova Squadra';
  }
  openModal('modal-team');
}

async function handleSaveTeam(event) {
  event.preventDefault();
  const players = getEl('input-players-list').value.split(/,|\n/g).map((item) => item.trim()).filter(Boolean);
  await saveTeam({
    id: getEl('edit-team-id').value || null,
    name: getEl('input-team-name').value,
    sport_id: state.singleTournamentId,
    players,
  });
  closeModal('modal-team');
  await loadTeamsTable();
  showToast('Squadra salvata.', 'success');
}

async function handleDeleteTeam(teamId) {
  if (!confirm('Confermi eliminazione squadra?')) return;
  await deleteTeam(teamId);
  await loadTeamsTable();
  showToast('Squadra eliminata.', 'success');
}

async function populateMatchTeams(sportId) {
  const currentSportId = sportId || state.singleTournamentId;
  const homeSelect = getEl('select-home-team');
  const awaySelect = getEl('select-away-team');
  if (!currentSportId) {
    homeSelect.innerHTML = '<option value="">-- Nessun torneo --</option>';
    awaySelect.innerHTML = '<option value="">-- Nessun torneo --</option>';
    homeSelect.disabled = true;
    awaySelect.disabled = true;
    return;
  }
  const teams = await loadTeamsBySport(currentSportId);
  const options = '<option value="">-- Seleziona --</option>' + teams.map((team) => `<option value="${team.id}">${escapeHtml(team.name)}</option>`).join('');
  homeSelect.innerHTML = options;
  awaySelect.innerHTML = options;
  homeSelect.disabled = false;
  awaySelect.disabled = false;
}

async function handleSaveMatch(event) {
  event.preventDefault();
  await createManualMatch({
    sportId: state.singleTournamentId, // Use the single tournament ID
    homeTeamId: Number(getEl('select-home-team').value || 0),
    awayTeamId: Number(getEl('select-away-team').value || 0),
    roundName: getEl('select-match-phase').value,
    scheduledAt: getEl('input-match-time').value || null,
  });
  closeModal('modal-match');
  await loadMatchesTable();
  showToast('Partita creata.', 'success');
}

async function handleGenerateMatches() {
  if (!state.singleTournamentId) return showToast('Nessun torneo selezionato per la generazione.', 'error');
  const sport = getSportById(state.singleTournamentId);
  const inserted = await generateMatchesForSport(state.singleTournamentId, Boolean(sport?.has_return_match));
  showToast(`Partite generate: ${inserted.inserted}.`, 'success');
  await loadMatchesTable();
}

async function handleGenerateSemifinals() {
  if (!state.singleTournamentId) return showToast('Nessun torneo selezionato.', 'error');
  const sportId = state.singleTournamentId;
  const count = await generateSemifinals(sportId); // This function uses the sportId
  showToast(`Semifinali create: ${count}.`, 'success');
  await loadMatchesTable();
}

async function handleDeleteMatch(matchId) {
  if (!confirm('Confermi eliminazione match?')) return;
  await deleteMatch(matchId);
  await loadMatchesTable();
  showToast('Match eliminato.', 'success');
}

function goToLive(matchId) {
  window.location.href = `live.html?match=${encodeURIComponent(matchId)}`;
}

function getSettingsVisibility(sportType, format) {
  // With only Beach Volley, these are always true
  return {
    comuni_team: true,
    classifica_gironi: format === 'gironi',
    pallavolo_live: true,
  };
}

function applySettingsVisibility(sport) {
  const sportType = sport?.sport_type ?? '';
  const format = sport?.format ?? '';
  const visibility = getSettingsVisibility(sportType, format);

  document
    .querySelectorAll('[data-settings-group]')
    .forEach((section) => section.classList.toggle('hidden', !visibility[section.dataset.settingsGroup]));
    
  // These will now reflect the single tournament's type and format
  const sportTypeEl = getEl('settings-selected-sport-type');
  if (sportTypeEl) sportTypeEl.value = SPORT_TYPE_LABELS[sportType] ?? '-';

  const formatEl = getEl('settings-selected-format');
  if (formatEl) formatEl.value = FORMAT_LABELS[format] ?? '-';
}

function buildSettingsPayloadForSport(sport) {
  const sportType = sport?.sport_type ?? '';
  const format = sport?.format ?? '';
  const visibility = getSettingsVisibility(sportType, format);
  const payload = {};

  if (visibility.comuni_team) {
    payload.max_fouls = Number(getEl('set-max-fouls').value || 3);
    payload.min_players = Number(getEl('set-min-players').value || 5);
    payload.ranking_weight_presence = Number(getEl('set-weight-pres').value || 70);
    payload.ranking_weight_fairplay = Number(getEl('set-weight-fair').value || 30);
    payload.allow_mvp = getEl('set-allow-mvp').checked;
  }

  if (visibility.classifica_gironi) {
    payload.points_win = Number(getEl('set-pts-win').value || 3);
    payload.points_draw = Number(getEl('set-pts-draw').value || 1);
    payload.points_loss = Number(getEl('set-pts-loss').value || 0);
  }

  if (visibility.pallavolo_live) {
    payload.volley_sets = Number(getEl('set-volley-sets').value || 3);
  }

  return payload;
}

function fillSettingsForm(config) {
  const setVal = (id, val) => {
    const el = getEl(id);
    if (el) el.value = val;
  };
  setVal('set-pts-win', config.points_win);
  setVal('set-pts-draw', config.points_draw);
  setVal('set-pts-loss', config.points_loss);
  setVal('set-max-fouls', config.max_fouls);
  setVal('set-min-players', config.min_players);
  setVal('set-weight-pres', config.ranking_weight_presence);
  setVal('set-weight-fair', config.ranking_weight_fairplay);
  setVal('set-volley-sets', config.volley_sets);

  const mvpEl = getEl('set-allow-mvp');
  if (mvpEl) mvpEl.checked = Boolean(config.allow_mvp ?? true);
}

async function loadSettingsForSelectedSport() {
  const sport = getSportById(state.singleTournamentId);
  applySettingsVisibility(sport);
  if (!state.singleTournamentId || !sport) return;
  const config = await loadSportConfig(state.singleTournamentId);
  fillSettingsForm(config);
  getEl('settings-selected-sport-type').value = SPORT_TYPE_LABELS['pallavolo']; // Ensure it's always Beach Volley
}

async function saveSettingsForSport() {
  const sportId = state.singleTournamentId;
  if (!sportId) return showToast('Impossibile salvare: nessun torneo caricato.', 'error');
  const sport = getSportById(sportId);
  if (!sport) return showToast('Torneo non trovato.', 'error');

  const payload = buildSettingsPayloadForSport(sport);
  const savedConfig = await upsertSportConfig(sportId, payload);
  const unsupportedColumns = savedConfig?.__unsupportedConfigColumns ?? [];
  if (unsupportedColumns.length) {
    showToast(
      `Impostazioni salvate con compatibilità. Aggiorna schema/cache per colonne: ${unsupportedColumns.join(', ')}.`,
      'error'
    );
    return;
  }
  showToast('Impostazioni salvate.', 'success');
}
function bindCoreActions() {
  getEl('btn-logout').addEventListener('click', async () => {
    await signOutAdmin();
    window.location.href = 'index.html';
  });

  document.querySelectorAll('[data-open-team-modal]').forEach((btn) => btn.addEventListener('click', () => openTeamModal(null)));
  document.querySelectorAll('[data-open-match-modal]').forEach((btn) => btn.addEventListener('click', () => openModal('modal-match')));
  getEl('btn-csv-teams-players')?.addEventListener('click', () => openCsvImportModal('teams_players'));

  getEl('btn-generate-matches')?.addEventListener('click', () => {
    handleGenerateMatches().catch((error) => showToast(error.message, 'error'));
  });

  getEl('btn-generate-semifinals')?.addEventListener('click', () => {
    handleGenerateSemifinals().catch((error) => showToast(error.message, 'error'));
  });

  getEl('btn-save-settings')?.addEventListener('click', () => {
    saveSettingsForSport().catch((error) => showToast(error.message, 'error'));
  });

  document.querySelectorAll('[data-modal-close]').forEach((button) => {
    button.addEventListener('click', () => {
      closeModal(button.dataset.modalClose);
    });
  });

  ['modal-team', 'modal-match', 'modal-csv-import'].forEach((modalId) => {
    getEl(modalId)?.addEventListener('click', (event) => {
      if (event.target.id === modalId) closeModal(modalId);
    });
  });

  getEl('input-csv-file')?.addEventListener('change', (event) => {
    const file = event.target?.files?.[0];
    getEl('csv-import-file-name').textContent = file?.name
      ? `File selezionato: ${file.name}`
      : 'Nessun file selezionato.';
    getEl('btn-csv-confirm-import').disabled = true;
    state.csvPreview = null;
  });

  getEl('btn-csv-preview')?.addEventListener('click', () => {
    handleCsvPreview().catch((error) => showToast(error.message, 'error'));
  });

  getEl('btn-csv-confirm-import')?.addEventListener('click', () => {
    handleCsvConfirmImport().catch((error) => {
      getEl('btn-csv-confirm-import').disabled = false;
      showToast(error.message, 'error');
    });
  });

  getEl('form-team')?.addEventListener('submit', (event) => {
    handleSaveTeam(event).catch((error) => showToast(error.message, 'error'));
  });

  getEl('form-match')?.addEventListener('submit', (event) => {
    handleSaveMatch(event).catch((error) => showToast(error.message, 'error'));
  });

  ['filter-match-team', 'filter-match-sport', 'filter-match-phase', 'filter-match-status'].forEach((id) => {
    getEl(id)?.addEventListener('input', () => {
      loadMatchesTable().catch((error) => showToast(error.message, 'error'));
    });
    getEl(id)?.addEventListener('change', () => {
      loadMatchesTable().catch((error) => showToast(error.message, 'error'));
    });
  });

  getEl('select-sport-match')?.addEventListener('change', (event) => {
    populateMatchTeams(event.target.value).catch((error) => showToast(error.message, 'error'));
  });

  getEl('btn-toggle-report-columns')?.addEventListener('click', () => {
    const panel = getEl('report-columns-panel');
    const button = getEl('btn-toggle-report-columns');
    if (!panel || !button || button.disabled) return;
    panel.classList.toggle('hidden');
    button.setAttribute('aria-expanded', String(!panel.classList.contains('hidden')));
  });

  getEl('report-columns-panel')?.addEventListener('change', (event) => {
    const checkbox = event.target.closest('input[type="checkbox"][data-action="toggle-report-column"]');
    if (!checkbox) return;

    const sportId = Number(getEl('report-sport-select')?.value || 0);
    if (!sportId) return;

    const groupKey = String(checkbox.dataset.group ?? '');
    const columnKey = String(checkbox.dataset.column ?? '');
    const prefs = ensureReportColumnPrefs(sportId);
    const groupPrefs = prefs[groupKey] ?? {};

    groupPrefs[columnKey] = checkbox.checked;
    const visibleCount = Object.values(groupPrefs).filter(Boolean).length;
    if (visibleCount === 0) {
      groupPrefs[columnKey] = true;
      checkbox.checked = true;
      showToast('Deve restare visibile almeno una colonna per sezione.', 'error');
      return;
    }

    prefs[groupKey] = groupPrefs;
    state.reportColumnPrefs[sportId] = prefs;
    persistReportColumnPrefs(sportId);
    applyReportColumnVisibility();
  });

  document.addEventListener('click', (event) => {
    const panel = getEl('report-columns-panel');
    const button = getEl('btn-toggle-report-columns');
    if (!panel || !button || panel.classList.contains('hidden')) return;
    if (panel.contains(event.target) || button.contains(event.target)) return;
    panel.classList.add('hidden');
    button.setAttribute('aria-expanded', 'false');
  });

  getEl('settings-sport-select')?.addEventListener('change', () => {
    loadSettingsForSelectedSport().catch((error) => showToast(error.message, 'error'));
  });

  getEl('table-teams-body')?.addEventListener('click', (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    const id = Number(actionEl.dataset.id);
    if (action === 'edit-team') {
      return openTeamModal({
        id,
        name: actionEl.dataset.name,
        sport_id: Number(actionEl.dataset.sportId),
      }).catch((error) => showToast(error.message, 'error'));
    }
    if (action === 'delete-team') {
      handleDeleteTeam(id).catch((error) => showToast(error.message, 'error'));
    }
  });

  getEl('table-matches-list')?.addEventListener('click', (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    const id = Number(actionEl.dataset.id);
    if (action === 'start-live') return goToLive(id);
    if (action === 'delete-match') {
      handleDeleteMatch(id).catch((error) => showToast(error.message, 'error'));
    }
  });
}

async function init() {
  const session = await requireAdmin({ redirectTo: 'index.html' });
  if (!session.allowed) return;

  state.admin = session.admin;
  getEl('admin-name').textContent = formatAdminDisplayName(state.admin);
  getEl('admin-role').textContent = formatRoleLabel(state.admin?.ruolo);

  bindSidebar();
  bindMobileSidebar();
  bindCoreActions();
  applyRolePermissions();

  state.singleTournamentId = await getFirstActiveSportId();
  if (!state.singleTournamentId) {
    showToast("Attenzione: Nessun torneo trovato nel database. Inserisci un torneo tramite SQL Editor.", "error");
  } else {
    const singleSport = await loadSportById(state.singleTournamentId);
    state.sports = [singleSport]; // Populate state.sports with the single tournament
    updateSingleTournamentUI(state.singleTournamentId, singleSport.name);
  }

  await refreshSportsState();

  if (state.singleTournamentId) {
    await populateMatchTeams(state.singleTournamentId);
    await loadSettingsForSelectedSport();
  }

  // Always default to matches view
  switchView('matches');
}

init().catch((error) => {
  showToast(error.message, 'error');
});
