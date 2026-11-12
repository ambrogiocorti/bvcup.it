import { APP_CONFIG } from './app-config.js';
import { db, run, runRpc, subscribeTable } from './db.js';
import { loadSportConfig } from './matches.js';

function normalizeRpcResult(result) {
  if (Array.isArray(result)) {
    return result[0] ?? null;
  }
  return result ?? null;
}

function isMissingRpcError(error) {
  return /function .* does not exist|Could not find the function|schema cache/i.test(
    String(error?.message ?? '')
  );
}

function isRecoverableRpcError(error) {
  return (
    isMissingRpcError(error) ||
    /column reference .* is ambiguous/i.test(
    String(error?.message ?? '')
    )
  );
}

export async function loadLiveMatch(matchId) {
  const { data } = await run(
    db
      .from('matches')
      .select('*, sport:sports(*), home:teams!home_team_id(*), away:teams!away_team_id(*)')
      .eq('id', Number(matchId))
      .single(),
    'Caricamento match live'
  );

  const config = await loadSportConfig(data.sport_id);
  const isSoccer = String(data?.sport?.sport_type ?? '').toLowerCase() === 'calcio';
  const untouchedConfig =
    String(config?.created_at ?? '') !== '' &&
    String(config?.created_at ?? '') === String(config?.updated_at ?? '');
  if (
    isSoccer &&
    untouchedConfig &&
    config?.allow_yellow_cards === false &&
    config?.allow_red_cards === false
  ) {
    config.allow_yellow_cards = true;
    config.allow_red_cards = true;
  }

  const [homePlayersResult, awayPlayersResult] = await Promise.all([
    run(
      db.from('players').select('*').eq('team_id', Number(data.home_team_id)).order('full_name', {
        ascending: true,
      }),
      'Caricamento rosa casa'
    ),
    run(
      db.from('players').select('*').eq('team_id', Number(data.away_team_id)).order('full_name', {
        ascending: true,
      }),
      'Caricamento rosa ospite'
    ),
  ]);

  return {
    match: data,
    config,
    homePlayers: homePlayersResult.data ?? [],
    awayPlayers: awayPlayersResult.data ?? [],
  };
}

async function fallbackAcquireLock(matchId) {
  const {
    data: { user },
  } = await db.auth.getUser();

  if (!user) {
    throw new Error('Sessione non valida');
  }

  const now = new Date();
  const expires = new Date(now.getTime() + APP_CONFIG.lockTtlSeconds * 1000).toISOString();

  const { data } = await run(
    db
      .from('matches')
      .update({
        lock_owner: user.id,
        lock_expires_at: expires,
        status: 'live',
      })
      .eq('id', Number(matchId))
      .select('id, lock_owner, lock_expires_at, lock_version, status')
      .single(),
    'Acquisizione lock fallback'
  );

  return {
    success: true,
    lock_owner: data.lock_owner,
    lock_expires_at: data.lock_expires_at,
    lock_version: data.lock_version ?? 0,
    status: data.status,
    message: 'fallback',
  };
}

export async function startLiveSession(matchId, ttlSeconds = APP_CONFIG.lockTtlSeconds) {
  try {
    const result = await runRpc(
      'acquire_match_lock',
      { match_id: Number(matchId), ttl_seconds: Number(ttlSeconds) },
      'Acquisizione lock live'
    );

    return normalizeRpcResult(result);
  } catch (error) {
    if (!isRecoverableRpcError(error)) {
      throw error;
    }
    return fallbackAcquireLock(matchId);
  }
}

export async function refreshLiveLock(matchId) {
  try {
    const result = await runRpc(
      'refresh_match_lock',
      { match_id: Number(matchId), ttl_seconds: Number(APP_CONFIG.lockTtlSeconds) },
      'Refresh lock live'
    );
    return normalizeRpcResult(result);
  } catch (error) {
    if (!isRecoverableRpcError(error)) {
      throw error;
    }

    const {
      data: { user },
    } = await db.auth.getUser();
    if (!user) {
      throw new Error('Sessione non valida');
    }

    const { data } = await run(
      db
        .from('matches')
        .update({
          lock_expires_at: new Date(
            Date.now() + APP_CONFIG.lockTtlSeconds * 1000
          ).toISOString(),
        })
        .eq('id', Number(matchId))
        .select('lock_owner, lock_expires_at, lock_version, status')
        .single(),
      'Refresh lock fallback'
    );

    return {
      success: true,
      lock_owner: data.lock_owner,
      lock_expires_at: data.lock_expires_at,
      lock_version: data.lock_version ?? 0,
      status: data.status,
      message: 'fallback',
    };
  }
}

export async function releaseLiveSession(matchId) {
  try {
    const result = await runRpc(
      'release_match_lock',
      { match_id: Number(matchId) },
      'Rilascio lock live'
    );
    return normalizeRpcResult(result);
  } catch (error) {
    if (!isMissingRpcError(error)) {
      throw error;
    }

    await run(
      db
        .from('matches')
        .update({ lock_owner: null, lock_expires_at: null })
        .eq('id', Number(matchId)),
      'Rilascio lock fallback'
    );
    return { success: true, message: 'fallback' };
  }
}

export async function commitLiveUpdate({
  matchId,
  payload,
  expectedVersion,
}) {
  try {
    const result = await runRpc(
      'save_live_snapshot',
      {
        match_id: Number(matchId),
        payload,
        expected_version: Number(expectedVersion),
      },
      'Salvataggio snapshot live'
    );
    return normalizeRpcResult(result);
  } catch (error) {
    if (!isMissingRpcError(error)) {
      throw error;
    }

    const {
      data: { user },
    } = await db.auth.getUser();
    if (!user) {
      throw new Error('Sessione non valida');
    }

    const { data } = await run(
      db
        .from('matches')
        .update({
          home_score: Number(payload.home_score ?? 0),
          away_score: Number(payload.away_score ?? 0),
          duration: Number(payload.duration ?? 0),
          status: 'live',
          live_payload: payload,
          lock_version: Number(expectedVersion) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', Number(matchId))
        .eq('lock_owner', user.id)
        .eq('lock_version', Number(expectedVersion))
        .select('lock_version, updated_at')
        .maybeSingle(),
      'Salvataggio snapshot fallback'
    );

    if (!data) {
      return {
        success: false,
        new_version: null,
        message: 'Versione lock non valida o lock scaduto',
      };
    }

    return {
      success: true,
      new_version: data.lock_version,
      message: 'fallback',
      updated_at: data.updated_at,
    };
  }
}

export async function finalizeLiveMatch({
  matchId,
  payload,
  statsPayload,
  expectedVersion,
}) {
  try {
    const result = await runRpc(
      'finalize_match',
      {
        match_id: Number(matchId),
        payload,
        stats_payload: statsPayload,
        expected_version: Number(expectedVersion),
      },
      'Finalizzazione match live'
    );

    return normalizeRpcResult(result);
  } catch (error) {
    if (!isRecoverableRpcError(error)) {
      throw error;
    }

    const {
      data: { user },
    } = await db.auth.getUser();
    if (!user) {
      throw new Error('Sessione non valida');
    }

    const { data: updatedMatch } = await run(
      db
        .from('matches')
        .update({
          home_score: Number(payload.home_score ?? 0),
          away_score: Number(payload.away_score ?? 0),
          duration: Number(payload.duration ?? 0),
          quarter: Number(payload.quarter ?? 1),
          status: 'finished',
          is_finished: true,
          live_payload: payload,
          lock_owner: null,
          lock_expires_at: null,
          finished_at: new Date().toISOString(),
          lock_version: Number(expectedVersion) + 1,
        })
        .eq('id', Number(matchId))
        .eq('lock_owner', user.id)
        .eq('lock_version', Number(expectedVersion))
        .select('lock_version')
        .maybeSingle(),
      'Finalizzazione fallback'
    );

    if (!updatedMatch) {
      return {
        success: false,
        new_version: null,
        message: 'Finalizzazione fallita: lock/version non validi',
      };
    }

    if (Array.isArray(statsPayload) && statsPayload.length) {
      const normalizedStats = statsPayload.map((item) => ({
        match_id: Number(matchId),
        player_id: Number(item.player_id),
        played: Boolean(item.played),
        fouls: Number(item.fouls ?? 0),
        is_mvp_vote: Boolean(item.is_mvp_vote),
        points_scored: Number(item.points_scored ?? 0),
        yellow_cards: Number(item.yellow_cards ?? 0),
        red_cards: Number(item.red_cards ?? 0),
      }));

      await run(
        db.from('match_stats').upsert(normalizedStats, {
          onConflict: 'match_id,player_id',
        }),
        'Upsert statistiche fallback'
      );
    }

    return {
      success: true,
      new_version: Number(updatedMatch.lock_version ?? Number(expectedVersion) + 1),
      message: 'fallback',
    };
  }
}

export function subscribeLiveMatch(matchId, callback) {
  const cleanMatch = subscribeTable({
    channelName: `live-match-${matchId}`,
    table: 'matches',
    event: 'UPDATE',
    filter: `id=eq.${Number(matchId)}`,
    onChange: callback,
  });

  const cleanStats = subscribeTable({
    channelName: `live-match-stats-${matchId}`,
    table: 'match_stats',
    event: '*',
    filter: `match_id=eq.${Number(matchId)}`,
    onChange: callback,
  });

  return () => {
    cleanMatch?.();
    cleanStats?.();
  };
}
