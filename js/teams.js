import { db, run } from './db.js';
import { deleteTeam, loadPlayersByTeam, loadTeamsBySport, saveTeam } from './matches.js';

export { loadTeamsBySport, loadPlayersByTeam, saveTeam, deleteTeam };

export async function loadTeamsWithSport() {
  const { data } = await run(
    db.from('teams').select('*, sports(name)').order('name', { ascending: true }),
    'Caricamento squadre con torneo'
  );
  return data ?? [];
}

export async function loadPlayersBySport(sportId) {
  const { data } = await run(
    db
      .from('players')
      .select('*, teams!inner(id, name, sport_id)')
      .eq('teams.sport_id', Number(sportId))
      .order('full_name', { ascending: true }),
    'Caricamento giocatori per torneo'
  );
  return data ?? [];
}
