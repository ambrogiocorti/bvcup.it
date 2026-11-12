import {
  loadTeamsBySport,
  loadMatchesBySport,
  loadPlayersBySport,
  loadMatchStatsBySport,
  loadSportConfig,
  computeStandings,
} from './matches.js';

function normalizeStatEntry(entry, fallbackMatchId = null) {
  const playerId = Number(entry?.player_id);
  if (!Number.isFinite(playerId) || playerId <= 0) return null;

  const matchId = Number(entry?.match_id ?? fallbackMatchId);
  return {
    match_id: Number.isFinite(matchId) && matchId > 0 ? matchId : null,
    player_id: playerId,
    played: Boolean(entry?.played),
    fouls: Number(entry?.fouls ?? 0),
    is_mvp_vote: Boolean(entry?.is_mvp_vote),
  };
}

function buildEffectiveStats(stats, matches) {
  const merged = new Map();

  (stats ?? []).forEach((entry) => {
    const normalized = normalizeStatEntry(entry);
    if (!normalized || !normalized.match_id) return;
    merged.set(`${normalized.match_id}:${normalized.player_id}`, normalized);
  });

  (matches ?? []).forEach((match) => {
    const snapshot = Array.isArray(match?.live_payload?.stats_snapshot)
      ? match.live_payload.stats_snapshot
      : [];
    snapshot.forEach((entry) => {
      const normalized = normalizeStatEntry(entry, match.id);
      if (!normalized || !normalized.match_id) return;
      const key = `${normalized.match_id}:${normalized.player_id}`;
      if (!merged.has(key)) {
        merged.set(key, normalized);
      }
    });
  });

  return [...merged.values()];
}

export async function loadReportDataset(sportId) {
  const [teams, matches, players, stats, config] = await Promise.all([
    loadTeamsBySport(sportId),
    loadMatchesBySport(sportId, { includeUnfinished: true }),
    loadPlayersBySport(sportId),
    loadMatchStatsBySport(sportId),
    loadSportConfig(sportId),
  ]);

  return {
    teams,
    matches,
    players,
    stats,
    config,
  };
}

export function computePlayerRanking({ players, stats, matches, config }) {
  const finishedMatches = (matches ?? []).filter((match) => match.is_finished);
  const teamFinishedMatches = new Map();
  finishedMatches.forEach((match) => {
    const homeId = Number(match.home_team_id);
    const awayId = Number(match.away_team_id);
    if (homeId > 0) {
      teamFinishedMatches.set(homeId, Number(teamFinishedMatches.get(homeId) ?? 0) + 1);
    }
    if (awayId > 0) {
      teamFinishedMatches.set(awayId, Number(teamFinishedMatches.get(awayId) ?? 0) + 1);
    }
  });

  const totalFinished = Math.max(finishedMatches.length, 1);
  const effectiveStats = buildEffectiveStats(stats, finishedMatches);
  const weightPresence = Number(config.ranking_weight_presence ?? 70);
  const weightFairplay = Number(config.ranking_weight_fairplay ?? 30);
  const mvpEnabled = Boolean(config.allow_mvp ?? true);

  const ranking = (players ?? []).map((player) => {
    const playerLogs = effectiveStats.filter((entry) => Number(entry.player_id) === Number(player.id));
    const fouls = playerLogs.reduce((sum, row) => sum + Number(row.fouls ?? 0), 0);
    const presences = playerLogs.filter((row) => Boolean(row.played)).length;
    const mvpVotes = mvpEnabled
      ? playerLogs.filter((row) => Boolean(row.is_mvp_vote)).length
      : 0;
    const teamId = Number(player.team_id ?? player.teams?.id ?? 0);
    const teamMatchCount = Math.max(Number(teamFinishedMatches.get(teamId) ?? totalFinished), 1);

    const presencePct = Math.round((presences / teamMatchCount) * 100);
    const fairplayScore = Math.max(0, 100 - fouls * 12);
    const weightedScore = Math.round(
      (presencePct * weightPresence + fairplayScore * weightFairplay) / 100 + mvpVotes * 8
    );

    return {
      playerId: player.id,
      name: player.full_name,
      team: player.teams?.name ?? '-',
      presences,
      presencePct,
      fouls,
      mvpVotes,
      score: Math.max(0, weightedScore),
    };
  });

  return ranking.sort(
    (a, b) =>
      b.score - a.score ||
      b.mvpVotes - a.mvpVotes ||
      a.fouls - b.fouls ||
      a.name.localeCompare(b.name, 'it', { sensitivity: 'base' })
  );
}

export function pickMvpWinner(playersRanking) {
  if (!playersRanking?.length) {
    return null;
  }

  const byVotes = [...playersRanking].sort(
    (a, b) =>
      b.mvpVotes - a.mvpVotes ||
      b.score - a.score ||
      a.name.localeCompare(b.name, 'it', { sensitivity: 'base' })
  );

  const winner = byVotes[0];
  if (!winner || winner.mvpVotes <= 0) {
    return null;
  }

  return winner;
}

export function computeTeamStandingsForReport(teams, matches, config) {
  const standings = computeStandings(teams, matches, config);
  return standings.map((row, index) => ({
    ...row,
    rank: index + 1,
  }));
}
