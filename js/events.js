import { db, run } from './db.js';
import { medalByRank } from './utils.js';

function uniqueNumericIds(values = []) {
  return [...new Set(values.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0))];
}

const DEFAULT_ATHLETICS_CONFIG = {
  athletics_attempts_per_event: 1,
  athletics_min_events_per_player: 1,
  athletics_max_events_per_player: 99,
};

function isMissingSchemaColumn(error, columnName) {
  const message = String(error?.cause?.message ?? error?.message ?? '').toLowerCase();
  return (
    message.includes(`'${String(columnName).toLowerCase()}'`) &&
    message.includes('schema cache')
  );
}

function normalizeAttemptValues(rawValues, fallbackValue) {
  const parsed = Array.isArray(rawValues)
    ? rawValues.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0)
    : [];

  if (parsed.length) return parsed;
  if (Number.isFinite(fallbackValue) && fallbackValue > 0) return [Number(fallbackValue)];
  return [];
}

function pickBestAttempt(attemptValues, orderRule, fallbackValue) {
  const values = normalizeAttemptValues(attemptValues, fallbackValue);
  if (!values.length) return Number(fallbackValue ?? 0);

  if (orderRule === 'asc') {
    return Math.min(...values);
  }

  return Math.max(...values);
}

export async function loadAthleticsConfigBySport(sportId) {
  try {
    const { data } = await run(
      db
        .from('sport_config')
        .select('athletics_attempts_per_event, athletics_min_events_per_player, athletics_max_events_per_player')
        .eq('sport_id', Number(sportId))
        .maybeSingle(),
      'Caricamento configurazione atletica'
    );

    return {
      ...DEFAULT_ATHLETICS_CONFIG,
      ...(data ?? {}),
    };
  } catch (_error) {
    return { ...DEFAULT_ATHLETICS_CONFIG };
  }
}

async function loadPlayersDirectory(playerIds, context = 'Caricamento anagrafica atleti') {
  const ids = uniqueNumericIds(playerIds);
  if (!ids.length) return new Map();

  const { data: players } = await run(
    db.from('players').select('id, full_name, team_id').in('id', ids),
    `${context} - giocatori`
  );

  const playerRows = players ?? [];
  const teamIds = uniqueNumericIds(playerRows.map((row) => row.team_id));
  const teamMap = new Map();

  if (teamIds.length) {
    const { data: teams } = await run(
      db.from('teams').select('id, name').in('id', teamIds),
      `${context} - squadre`
    );
    (teams ?? []).forEach((team) => {
      teamMap.set(Number(team.id), team.name);
    });
  }

  const playerMap = new Map();
  playerRows.forEach((player) => {
    playerMap.set(Number(player.id), {
      id: Number(player.id),
      full_name: player.full_name,
      team_id: Number(player.team_id),
      teams: {
        name: teamMap.get(Number(player.team_id)) ?? '-',
      },
    });
  });

  return playerMap;
}

export async function loadAthleticsSports() {
  const { data } = await run(
    db
      .from('sports')
      .select('*')
      .eq('sport_type', 'atletica')
      .eq('is_active', true)
      .order('year', { ascending: true })
      .order('name', { ascending: true }),
    'Caricamento tornei atletica'
  );
  return data ?? [];
}

export async function loadAthleticsEvents(sportId) {
  const { data } = await run(
    db
      .from('events')
      .select('*')
      .eq('sport_id', Number(sportId))
      .eq('is_active', true)
      .order('name', { ascending: true }),
    'Caricamento eventi atletica'
  );

  return data ?? [];
}

export async function saveAthleticsEvent(payload) {
  const eventPayload = {
    sport_id: Number(payload.sport_id),
    name: String(payload.name).trim(),
    unit: payload.unit,
    sort_order: payload.sort_order,
    is_active: payload.is_active !== false,
  };

  if (payload.id) {
    const { data } = await run(
      db.from('events').update(eventPayload).eq('id', Number(payload.id)).select().single(),
      'Aggiornamento evento atletica'
    );
    return data;
  }

  const { data } = await run(
    db.from('events').insert(eventPayload).select().single(),
    'Creazione evento atletica'
  );
  return data;
}

export async function deleteAthleticsEvent(eventId) {
  await run(
    db.from('events').update({ is_active: false }).eq('id', Number(eventId)),
    'Disattivazione evento atletica'
  );
}

export async function loadEventResults(eventId) {
  const { data } = await run(
    db
      .from('event_results')
      .select('*')
      .eq('event_id', Number(eventId)),
    'Caricamento risultati evento'
  );

  const rows = data ?? [];
  if (!rows.length) return [];

  const playersMap = await loadPlayersDirectory(
    rows.map((row) => row.player_id),
    'Caricamento risultati evento'
  );

  return rows
    .map((row) => {
    const attemptValues = normalizeAttemptValues(row.attempt_values, row.value);
    const rawAttemptCount = Number(row.attempt_count);
    const resolvedAttemptCount = Number.isFinite(rawAttemptCount) && rawAttemptCount > 0
      ? rawAttemptCount
      : Math.max(1, attemptValues.length || 1);
    const player = playersMap.get(Number(row.player_id)) ?? null;
    if (!player) return null;

    return {
      ...row,
      value: Number(row.value ?? 0),
      attempt_values: attemptValues,
      attempt_count: resolvedAttemptCount,
      player,
    };
    })
    .filter(Boolean);
}

export async function upsertEventResult({ event_id, player_id, value, notes }) {
  const numericEventId = Number(event_id);
  const numericPlayerId = Number(player_id);
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    throw new Error('Valore non valido per il risultato atletica.');
  }

  const { data: eventRow } = await run(
    db
      .from('events')
      .select('id, sport_id, sort_order')
      .eq('id', numericEventId)
      .single(),
    'Caricamento evento atletica per risultato'
  );

  const sportId = Number(eventRow?.sport_id ?? 0);
  if (!sportId) {
    throw new Error('Evento atletica non valido.');
  }

  const config = await loadAthleticsConfigBySport(sportId);
  const attemptsLimit = Math.max(1, Number(config.athletics_attempts_per_event ?? 1));
  const maxEventsPerPlayer = Math.max(1, Number(config.athletics_max_events_per_player ?? 99));

  const { data: existingRows } = await run(
    db
      .from('event_results')
      .select('*')
      .eq('event_id', numericEventId)
      .eq('player_id', numericPlayerId)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false }),
    'Verifica risultato atletica esistente'
  );

  const rows = existingRows ?? [];
  const latestExistingRow = rows[0] ?? null;

  if (!latestExistingRow) {
    const { data: playerResults } = await run(
      db
        .from('event_results')
        .select('event_id')
        .eq('player_id', numericPlayerId),
      'Verifica limiti partecipazione atleta'
    );

    const candidateEventIds = uniqueNumericIds((playerResults ?? []).map((row) => row.event_id));
    let participatedEventsCount = 0;

    if (candidateEventIds.length) {
      const { data: existingSportEvents } = await run(
        db
          .from('events')
          .select('id')
          .eq('sport_id', sportId)
          .in('id', candidateEventIds),
        'Verifica limiti partecipazione atleta'
      );
      participatedEventsCount = (existingSportEvents ?? []).length;
    }

    if (participatedEventsCount >= maxEventsPerPlayer) {
      throw new Error(`Questo atleta ha già raggiunto il massimo di ${maxEventsPerPlayer} eventi nel torneo.`);
    }
  }

  const previousAttempts = normalizeAttemptValues(
    latestExistingRow?.attempt_values,
    latestExistingRow?.value
  );
  if (previousAttempts.length >= attemptsLimit) {
    throw new Error(`Limite tentativi raggiunto (${attemptsLimit}) per questo atleta in questo evento.`);
  }

  const nextAttempts = [...previousAttempts, numericValue];
  const officialValue = pickBestAttempt(nextAttempts, eventRow.sort_order, numericValue);

  const payload = {
    event_id: numericEventId,
    player_id: numericPlayerId,
    value: officialValue,
    notes: notes ? String(notes) : null,
    attempt_count: nextAttempts.length,
    attempt_values: nextAttempts,
  };

  const warningPayload = {
    __legacyDuplicateRowsCount: Math.max(rows.length - 1, 0),
  };

  try {
    if (latestExistingRow) {
      const { data: updatedRows } = await run(
        db
          .from('event_results')
          .update(payload)
          .eq('event_id', numericEventId)
          .eq('player_id', numericPlayerId)
          .select('*'),
        'Salvataggio risultato atletica'
      );

      const updated = (updatedRows ?? []).sort(
        (a, b) =>
          Number(new Date(b.updated_at ?? b.created_at ?? 0)) -
            Number(new Date(a.updated_at ?? a.created_at ?? 0)) ||
          Number(b.id ?? 0) - Number(a.id ?? 0)
      )[0] ?? null;
      return {
        ...(updated ?? {}),
        value: officialValue,
        attempt_count: nextAttempts.length,
        attempt_values: nextAttempts,
        attempts_limit: attemptsLimit,
        __attemptColumnsUnsupported: false,
        ...warningPayload,
      };
    }

    const { data: inserted } = await run(
      db
        .from('event_results')
        .insert(payload)
        .select('*')
        .single(),
      'Salvataggio risultato atletica'
    );

    return {
      ...(inserted ?? {}),
      value: officialValue,
      attempt_count: nextAttempts.length,
      attempt_values: nextAttempts,
      attempts_limit: attemptsLimit,
      __attemptColumnsUnsupported: false,
      ...warningPayload,
    };
  } catch (error) {
    if (isMissingSchemaColumn(error, 'attempt_count') || isMissingSchemaColumn(error, 'attempt_values')) {
      const fallbackPayload = {
        event_id: numericEventId,
        player_id: numericPlayerId,
        value: officialValue,
        notes: notes ? String(notes) : null,
      };

      if (latestExistingRow) {
        const { data: fallbackUpdatedRows } = await run(
          db
            .from('event_results')
            .update({
              value: fallbackPayload.value,
              notes: fallbackPayload.notes,
            })
            .eq('event_id', numericEventId)
            .eq('player_id', numericPlayerId)
            .select('*'),
          'Salvataggio risultato atletica'
        );

        const fallbackUpdated = (fallbackUpdatedRows ?? []).sort(
          (a, b) =>
            Number(new Date(b.updated_at ?? b.created_at ?? 0)) -
              Number(new Date(a.updated_at ?? a.created_at ?? 0)) ||
            Number(b.id ?? 0) - Number(a.id ?? 0)
        )[0] ?? null;
        return {
          ...(fallbackUpdated ?? {}),
          value: officialValue,
          attempt_count: 1,
          attempt_values: [officialValue],
          attempts_limit: 1,
          __attemptColumnsUnsupported: true,
          ...warningPayload,
        };
      }

      const { data: fallbackInserted } = await run(
        db
          .from('event_results')
          .insert(fallbackPayload)
          .select('*')
          .single(),
        'Salvataggio risultato atletica'
      );

      return {
        ...(fallbackInserted ?? {}),
        value: officialValue,
        attempt_count: 1,
        attempt_values: [officialValue],
        attempts_limit: 1,
        __attemptColumnsUnsupported: true,
        ...warningPayload,
      };
    }

    throw error;
  }
}

export function computeAthleticsRanking(results, orderRule = 'desc') {
  const normalized = [...(results ?? [])].map((item) => ({
    ...item,
    value: Number(item.value ?? 0),
  }));

  normalized.sort((a, b) => {
    if (orderRule === 'asc') {
      return a.value - b.value;
    }
    return b.value - a.value;
  });

  return normalized.map((item, index) => ({
    ...item,
    rank: index + 1,
    medal: medalByRank(index),
  }));
}

export async function loadAthleticsLeaderboard(sportId) {
  const [events, config] = await Promise.all([
    loadAthleticsEvents(sportId),
    loadAthleticsConfigBySport(sportId),
  ]);
  if (!events.length) return [];

  const byPlayer = new Map();

  for (const event of events) {
    const results = await loadEventResults(event.id);
    const ranked = computeAthleticsRanking(results, event.sort_order);

    ranked.forEach((result, idx) => {
      const playerId = Number(result.player?.id ?? 0);
      if (!playerId) return;

      const current = byPlayer.get(playerId) ?? {
        playerId,
        playerName: result.player.full_name,
        teamName: result.player.teams?.name ?? '-',
        score: 0,
        events: 0,
        medals: { gold: 0, silver: 0, bronze: 0 },
      };

      current.events += 1;

      if (idx === 0) {
        current.score += 3;
        current.medals.gold += 1;
      } else if (idx === 1) {
        current.score += 2;
        current.medals.silver += 1;
      } else if (idx === 2) {
        current.score += 1;
        current.medals.bronze += 1;
      }

      byPlayer.set(playerId, current);
    });
  }

  const minEvents = Math.max(0, Number(config?.athletics_min_events_per_player ?? 1));
  const maxEvents = Math.max(minEvents || 1, Number(config?.athletics_max_events_per_player ?? 99));

  const rankingAll = [...byPlayer.values()].sort(
    (a, b) =>
      b.score - a.score ||
      b.medals.gold - a.medals.gold ||
      b.medals.silver - a.medals.silver ||
      b.medals.bronze - a.medals.bronze ||
      a.playerName.localeCompare(b.playerName, 'it', { sensitivity: 'base' })
  );

  return rankingAll.filter((row) => row.events >= minEvents && row.events <= maxEvents);
}
