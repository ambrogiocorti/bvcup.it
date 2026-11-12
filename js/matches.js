﻿import { db, run } from './db.js';
import { TEAM_SPORTS } from './app-config.js';

const DEFAULT_CONFIG = {
  points_win: 3,
  points_draw: 1,
  points_loss: 0,
  max_fouls: 3,
  quarters_count: 4,
  quarter_duration_sec: 600,
  timeouts_per_team: 2,
  min_players: 5,
  allow_mvp: true,
  allow_yellow_cards: true,
  ranking_weight_presence: 70,
  ranking_weight_fairplay: 30,
};

const CONFIG_COLUMNS_WITH_SCHEMA_FALLBACK = [
  'allow_mvp',
  'ranking_weight_presence',
  'ranking_weight_fairplay',
];

function isMissingSchemaColumn(error, columnName) {
  const message = String(error?.cause?.message ?? error?.message ?? '').toLowerCase();
  return (
    message.includes(`'${String(columnName).toLowerCase()}'`) &&
    message.includes('schema cache')
  );
}

export async function loadSports({ includeInactive = false } = {}) {
  let query = db
    .from('sports')
    .select('*')
    .order('year', { ascending: true })
    .order('name', { ascending: true });

  if (!includeInactive) {
    query = query.eq('is_active', true);
  }

  const { data } = await run(query, 'Caricamento tornei');
  return data ?? [];
}

export async function loadSportById(sportId) {
  const { data } = await run(
    db.from('sports').select('*').eq('id', sportId).maybeSingle(),
    'Caricamento torneo'
  );
  return data;
}

export async function getFirstActiveSportId() {
  const sports = await loadSports({ includeInactive: false });
  if (sports.length > 0) {
    return Number(sports[0].id);
  }
  const allSports = await loadSports({ includeInactive: true });
  if (allSports.length > 0) {
    return Number(allSports[0].id);
  }
  return null;
}

export async function loadSportConfig(sportId) {
  const { data } = await run(
    db
      .from('sport_config')
      .select('*')
      .eq('sport_id', sportId)
      .maybeSingle(),
    'Caricamento configurazione sport'
  );

  return {
    ...DEFAULT_CONFIG,
    ...(data ?? {}),
  };
}

export async function upsertSportConfig(sportId, payload) {
  const basePayload = {
    sport_id: sportId,
    ...payload,
    updated_at: new Date().toISOString(),
  };

  const unsupportedColumns = new Set();
  let payloadToSave = { ...basePayload };

  while (true) {
    try {
      const { data } = await run(
        db
          .from('sport_config')
          .upsert(payloadToSave, { onConflict: 'sport_id' })
          .select()
          .single(),
        'Salvataggio configurazione sport'
      );

      if (!unsupportedColumns.size) {
        return data;
      }

      return {
        ...(data ?? {}),
        allow_mvp: unsupportedColumns.has('allow_mvp')
          ? DEFAULT_CONFIG.allow_mvp
          : Boolean((data ?? {}).allow_mvp ?? DEFAULT_CONFIG.allow_mvp),
        __allowMvpUnsupported: unsupportedColumns.has('allow_mvp'),
        ranking_weight_presence: unsupportedColumns.has('ranking_weight_presence')
          ? DEFAULT_CONFIG.ranking_weight_presence
          : Number((data ?? {}).ranking_weight_presence ?? DEFAULT_CONFIG.ranking_weight_presence),
        ranking_weight_fairplay: unsupportedColumns.has('ranking_weight_fairplay')
          ? DEFAULT_CONFIG.ranking_weight_fairplay
          : Number((data ?? {}).ranking_weight_fairplay ?? DEFAULT_CONFIG.ranking_weight_fairplay),
        __unsupportedConfigColumns: [...unsupportedColumns],
      };
    } catch (error) {
      const missingColumns = CONFIG_COLUMNS_WITH_SCHEMA_FALLBACK.filter(
        (column) =>
          Object.prototype.hasOwnProperty.call(payloadToSave, column) &&
          isMissingSchemaColumn(error, column)
      );

      if (!missingColumns.length) {
        throw error;
      }

      missingColumns.forEach((column) => {
        unsupportedColumns.add(column);
        delete payloadToSave[column];
      });
    }
  }
}

export async function loadTeamsBySport(sportId) {
  const { data } = await run(
    db.from('teams').select('*').eq('sport_id', sportId).order('name', { ascending: true }),
    'Caricamento squadre'
  );
  return data ?? [];
}

export async function loadPlayersByTeam(teamId) {
  const { data } = await run(
    db.from('players').select('*').eq('team_id', teamId).order('full_name', { ascending: true }),
    'Caricamento giocatori'
  );
  return data ?? [];
}

export async function loadMatchesBySport(sportId, { includeUnfinished = true } = {}) {
  let query = db
    .from('matches')
    .select('*, home:teams!home_team_id(name), away:teams!away_team_id(name), sport:sports(*)')
    .eq('sport_id', sportId)
    .order('id', { ascending: true });

  if (!includeUnfinished) {
    query = query.eq('is_finished', true);
  }

  const { data } = await run(query, 'Caricamento partite');
  return data ?? [];
}

export async function listMatchesForAdmin(filters = {}) {
  let query = db
    .from('matches')
    .select('*, sport:sports(name, sport_type), home:teams!home_team_id(name), away:teams!away_team_id(name)')
    .order('id', { ascending: false });

  if (filters.sportId && filters.sportId !== 'all') {
    query = query.eq('sport_id', Number(filters.sportId));
  }
  if (filters.status === 'finished') {
    query = query.eq('is_finished', true);
  }
  if (filters.status === 'pending') {
    query = query.eq('is_finished', false);
  }

  const { data } = await run(query, 'Caricamento calendario admin');
  const needle = String(filters.teamSearch ?? '').trim().toLowerCase();
  const phase = String(filters.phase ?? 'all');

  return (data ?? []).filter((match) => {
    if (!TEAM_SPORTS.includes(String(match?.sport?.sport_type ?? '').trim().toLowerCase())) {
      return false;
    }

    const homeName = String(match.home?.name ?? '').toLowerCase();
    const awayName = String(match.away?.name ?? '').toLowerCase();

    if (needle && !homeName.includes(needle) && !awayName.includes(needle)) {
      return false;
    }
    if (phase !== 'all' && String(match.round_name ?? '') !== phase) {
      return false;
    }
    return true;
  });
}

export function generateRoundRobinMatches(teams, hasReturnMatch = false) {
  const normalizedTeams = (teams ?? []).map((team) => ({
    id: Number(team.id),
    name: team.name,
  }));

  const matches = [];
  for (let i = 0; i < normalizedTeams.length; i += 1) {
    for (let j = i + 1; j < normalizedTeams.length; j += 1) {
      matches.push({
        home_team_id: normalizedTeams[i].id,
        away_team_id: normalizedTeams[j].id,
        round_name: 'Girone (Andata)',
      });
      if (hasReturnMatch) {
        matches.push({
          home_team_id: normalizedTeams[j].id,
          away_team_id: normalizedTeams[i].id,
          round_name: 'Girone (Ritorno)',
        });
      }
    }
  }

  return matches;
}

export function computeStandings(teams, matches, config = DEFAULT_CONFIG) {
  const table = {};

  for (const team of teams ?? []) {
    table[team.id] = {
      id: team.id,
      name: team.name,
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      points: 0,
    };
  }

  for (const match of matches ?? []) {
    if (!match?.is_finished) continue;
    const home = table[match.home_team_id];
    const away = table[match.away_team_id];
    if (!home || !away) continue;

    const homeScore = Number(match.home_score ?? 0);
    const awayScore = Number(match.away_score ?? 0);

    home.played += 1;
    away.played += 1;
    home.goalsFor += homeScore;
    home.goalsAgainst += awayScore;
    away.goalsFor += awayScore;
    away.goalsAgainst += homeScore;

    if (homeScore > awayScore) {
      home.wins += 1;
      away.losses += 1;
      home.points += Number(config.points_win ?? 3);
      away.points += Number(config.points_loss ?? 0);
    } else if (awayScore > homeScore) {
      away.wins += 1;
      home.losses += 1;
      away.points += Number(config.points_win ?? 3);
      home.points += Number(config.points_loss ?? 0);
    } else {
      home.draws += 1;
      away.draws += 1;
      home.points += Number(config.points_draw ?? 1);
      away.points += Number(config.points_draw ?? 1);
    }
  }

  return Object.values(table)
    .map((row) => ({
      ...row,
      goalDiff: row.goalsFor - row.goalsAgainst,
    }))
    .sort(
      (a, b) =>
        b.points - a.points ||
        b.goalDiff - a.goalDiff ||
        b.goalsFor - a.goalsFor ||
        a.name.localeCompare(b.name, 'it', { sensitivity: 'base' })
    );
}

function buildUniquePairKey(homeTeamId, awayTeamId, roundName) {
  const [a, b] = [homeTeamId, awayTeamId].sort((x, y) => x - y);
  return `${a}:${b}:${roundName}`;
}

export async function createManualMatch({
  sportId,
  homeTeamId,
  awayTeamId,
  roundName = 'Girone (Andata)',
  scheduledAt = null,
}) {
  const sport = await loadSportById(sportId);
  if (!sport) {
    throw new Error('Torneo non trovato');
  }
  if (!TEAM_SPORTS.includes(String(sport.sport_type ?? '').trim().toLowerCase())) {
    throw new Error('Le partite sono disponibili solo per sport di squadra');
  }

  const homeId = Number(homeTeamId);
  const awayId = Number(awayTeamId);

  if (!homeId || !awayId || homeId === awayId) {
    throw new Error('Seleziona due squadre differenti');
  }

  const existing = await loadMatchesBySport(sportId, { includeUnfinished: true });
  const uniqueKey = buildUniquePairKey(homeId, awayId, roundName);
  const duplicated = existing.some(
    (item) =>
      buildUniquePairKey(Number(item.home_team_id), Number(item.away_team_id), item.round_name) ===
      uniqueKey
  );

  if (duplicated) {
    throw new Error('Partita duplicata per la stessa fase');
  }

  const payload = {
    sport_id: Number(sportId),
    home_team_id: homeId,
    away_team_id: awayId,
    round_name: roundName,
    scheduled_at: scheduledAt,
    status: 'scheduled',
    is_finished: false,
  };

  const { data } = await run(
    db.from('matches').insert(payload).select().single(),
    'Creazione partita'
  );

  return data;
}

export async function generateMatchesForSport(sportId, hasReturnMatch = false) {
  const sport = await loadSportById(sportId);
  if (!sport) {
    throw new Error('Torneo non trovato');
  }
  if (!TEAM_SPORTS.includes(String(sport.sport_type ?? '').trim().toLowerCase())) {
    throw new Error('Generazione calendario disponibile solo per sport di squadra');
  }

  const teams = await loadTeamsBySport(sportId);
  if (teams.length < 2) {
    throw new Error('Servono almeno 2 squadre per generare il calendario');
  }

  const generated = generateRoundRobinMatches(teams, hasReturnMatch);
  const existingMatches = await loadMatchesBySport(sportId, { includeUnfinished: true });
  const existingKeys = new Set(
    existingMatches.map((item) =>
      buildUniquePairKey(
        Number(item.home_team_id),
        Number(item.away_team_id),
        String(item.round_name)
      )
    )
  );

  const payload = generated
    .filter(
      (entry) =>
        !existingKeys.has(
          buildUniquePairKey(entry.home_team_id, entry.away_team_id, entry.round_name)
        )
    )
    .map((entry) => ({
      ...entry,
      sport_id: Number(sportId),
      status: 'scheduled',
      is_finished: false,
    }));

  if (!payload.length) {
    return { inserted: 0 };
  }

  await run(db.from('matches').insert(payload), 'Generazione calendario');
  return { inserted: payload.length };
}

export async function generateSemifinals(sportId) {
  const sport = await loadSportById(sportId);
  if (!sport) {
    throw new Error('Torneo non trovato');
  }
  if (!TEAM_SPORTS.includes(String(sport.sport_type ?? '').trim().toLowerCase())) {
    throw new Error('Semifinali disponibili solo per sport di squadra');
  }

  const teams = await loadTeamsBySport(sportId);
  if (teams.length < 4) {
    throw new Error('Servono almeno 4 squadre per le semifinali');
  }

  const matches = await loadMatchesBySport(sportId, { includeUnfinished: true });
  const hasSemifinals = matches.some((match) =>
    String(match.round_name ?? '').toLowerCase().includes('semifinale')
  );

  if (hasSemifinals) {
    throw new Error('Semifinali già presenti per questo torneo');
  }

  const config = await loadSportConfig(sportId);
  const standings = computeStandings(teams, matches, config);
  if (standings.length < 4) {
    throw new Error('Classifica insufficiente per generare semifinali');
  }

  const payload = [
    {
      sport_id: Number(sportId),
      home_team_id: standings[0].id,
      away_team_id: standings[3].id,
      round_name: 'Semifinale 1',
      status: 'scheduled',
      is_finished: false,
    },
    {
      sport_id: Number(sportId),
      home_team_id: standings[1].id,
      away_team_id: standings[2].id,
      round_name: 'Semifinale 2',
      status: 'scheduled',
      is_finished: false,
    },
  ];

  await run(db.from('matches').insert(payload), 'Generazione semifinali');
  return payload.length;
}

export async function deleteMatch(matchId) {
  await run(db.from('matches').delete().eq('id', Number(matchId)), 'Eliminazione match');
}

export async function saveSport(payload) {
  const dataPayload = {
    name: payload.name,
    year: Number(payload.year),
    sport_type: payload.sport_type,
    format: payload.format,
    gender: payload.gender,
    has_return_match: Boolean(payload.has_return_match),
    is_active: payload.is_active !== false,
  };

  if (payload.id) {
    const { data } = await run(
      db.from('sports').update(dataPayload).eq('id', Number(payload.id)).select().single(),
      'Aggiornamento torneo'
    );
    return data;
  }

  const { data } = await run(
    db.from('sports').insert(dataPayload).select().single(),
    'Creazione torneo'
  );
  return data;
}

export async function deleteSport(sportId) {
  const numericSportId = Number(sportId);

  const { data: matches } = await run(
    db.from('matches').select('id').eq('sport_id', numericSportId),
    'Eliminazione torneo - caricamento match collegati'
  );
  const matchIds = (matches ?? []).map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0);

  if (matchIds.length) {
    await run(
      db.from('match_stats').delete().in('match_id', matchIds),
      'Eliminazione torneo - cancellazione statistiche match'
    );
  }

  await run(
    db.from('matches').delete().eq('sport_id', numericSportId),
    'Eliminazione torneo - cancellazione match'
  );

  const { data: events } = await run(
    db.from('events').select('id').eq('sport_id', numericSportId),
    'Eliminazione torneo - caricamento eventi atletica'
  );
  const eventIds = (events ?? []).map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0);

  if (eventIds.length) {
    await run(
      db.from('event_results').delete().in('event_id', eventIds),
      'Eliminazione torneo - cancellazione risultati atletica'
    );
  }

  await run(
    db.from('events').delete().eq('sport_id', numericSportId),
    'Eliminazione torneo - cancellazione eventi atletica'
  );

  const { data: teams } = await run(
    db.from('teams').select('id').eq('sport_id', numericSportId),
    'Eliminazione torneo - caricamento squadre'
  );
  const teamIds = (teams ?? []).map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0);

  if (teamIds.length) {
    await run(
      db.from('players').delete().in('team_id', teamIds),
      'Eliminazione torneo - cancellazione giocatori'
    );
  }

  await run(
    db.from('teams').delete().eq('sport_id', numericSportId),
    'Eliminazione torneo - cancellazione squadre'
  );

  await run(
    db.from('sport_config').delete().eq('sport_id', numericSportId),
    'Eliminazione torneo - cancellazione configurazione'
  );

  await run(
    db.from('sports').delete().eq('id', numericSportId),
    'Eliminazione torneo'
  );
}

export async function saveTeam({ id, name, sport_id, players }) {
  if (!name) {
    throw new Error('Nome squadra obbligatorio');
  }
  if (!sport_id) {
    throw new Error('Torneo non identificato (sport_id mancante)');
  }

  const teamPayload = {
    name: String(name).trim(),
    sport_id: Number(sport_id),
  };

  const normalizePlayerNameKey = (value) =>
    String(value ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();

  const requestedPlayerNames = [...new Set(
    (players ?? [])
      .map((nameValue) => String(nameValue ?? '').trim().replace(/\s+/g, ' '))
      .filter(Boolean)
  )];
  const requestedByKey = new Map(
    requestedPlayerNames.map((fullName) => [normalizePlayerNameKey(fullName), fullName])
  );

  let teamId = Number(id);
  if (teamId) {
    await run(
      db.from('teams').update(teamPayload).eq('id', teamId),
      'Aggiornamento squadra'
    );
  } else {
    const { data } = await run(
      db.from('teams').insert(teamPayload).select().single(),
      'Creazione squadra'
    );
    teamId = Number(data.id);
  }

  const { data: existingPlayers } = await run(
    db
      .from('players')
      .select('id, full_name')
      .eq('team_id', teamId),
    'Caricamento giocatori squadra'
  );

  const existingRows = existingPlayers ?? [];
  const existingByKey = new Map();
  existingRows.forEach((row) => {
    const key = normalizePlayerNameKey(row.full_name);
    if (!existingByKey.has(key)) {
      existingByKey.set(key, row);
    }
  });

  const playersToInsert = [];
  const playersToRename = [];
  requestedByKey.forEach((displayName, key) => {
    const existing = existingByKey.get(key);
    if (!existing) {
      playersToInsert.push({ team_id: teamId, full_name: displayName });
      return;
    }
    if (String(existing.full_name) !== displayName) {
      playersToRename.push({ id: Number(existing.id), full_name: displayName });
    }
  });

  for (const row of playersToRename) {
    await run(
      db.from('players').update({ full_name: row.full_name }).eq('id', row.id),
      'Aggiornamento nome studente'
    );
  }

  if (playersToInsert.length) {
    await run(
      db.from('players').insert(playersToInsert),
      'Inserimento nuovi studenti squadra'
    );
  }

  const removablePlayers = existingRows.filter(
    (row) => !requestedByKey.has(normalizePlayerNameKey(row.full_name))
  );
  const removableIds = removablePlayers
    .map((row) => Number(row.id))
    .filter((playerId) => Number.isFinite(playerId) && playerId > 0);

  if (removableIds.length) {
    const [{ data: athleticsRefs }, { data: matchRefs }] = await Promise.all([
      run(
        db.from('event_results').select('player_id').in('player_id', removableIds),
        'Verifica riferimenti atletica studenti'
      ),
      run(
        db.from('match_stats').select('player_id').in('player_id', removableIds),
        'Verifica riferimenti match studenti'
      ),
    ]);

    const referencedIds = new Set(
      [...(athleticsRefs ?? []), ...(matchRefs ?? [])]
        .map((row) => Number(row.player_id))
        .filter((playerId) => Number.isFinite(playerId) && playerId > 0)
    );

    const deletableIds = removableIds.filter((playerId) => !referencedIds.has(playerId));
    if (deletableIds.length) {
      await run(
        db.from('players').delete().in('id', deletableIds),
        'Rimozione studenti non referenziati'
      );
    }
  }

  return teamId;
}

export async function deleteTeam(teamId) {
  await run(db.from('teams').delete().eq('id', Number(teamId)), 'Eliminazione squadra');
}

export async function loadPlayersBySport(sportId) {
  const { data } = await run(
    db
      .from('players')
      .select('*, teams!inner(id, name, sport_id)')
      .eq('teams.sport_id', Number(sportId))
      .order('full_name', { ascending: true }),
    'Caricamento giocatori per sport'
  );
  return data ?? [];
}

export async function loadMatchStatsBySport(sportId) {
  const { data } = await run(
    db
      .from('match_stats')
      .select('*, matches!inner(sport_id)')
      .eq('matches.sport_id', Number(sportId)),
    'Caricamento statistiche match'
  );
  return data ?? [];
}
