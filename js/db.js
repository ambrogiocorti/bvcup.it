import { APP_CONFIG } from './app-config.js';

if (!window.supabase) {
  throw new Error('Supabase SDK non trovata. Verifica lo script CDN in pagina.');
}

export const db = window.supabase.createClient(
  APP_CONFIG.supabaseUrl,
  APP_CONFIG.supabaseAnonKey,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);

export async function run(queryPromise, context = 'Operazione DB') {
  const { data, error, count } = await queryPromise;
  if (error) {
    const err = new Error(`${context}: ${error.message}`);
    err.cause = error;
    throw err;
  }
  return { data, count };
}

export async function runRpc(fnName, args = {}, context = 'Operazione RPC') {
  const { data, error } = await db.rpc(fnName, args);
  if (error) {
    const err = new Error(`${context}: ${error.message}`);
    err.cause = error;
    throw err;
  }
  return data;
}

export function subscribeTable({
  channelName,
  table,
  event = '*',
  filter,
  onChange,
  schema = 'public',
}) {
  const channel = db
    .channel(channelName)
    .on(
      'postgres_changes',
      {
        event,
        schema,
        table,
        ...(filter ? { filter } : {}),
      },
      (payload) => {
        onChange?.(payload);
      }
    )
    .subscribe();

  return () => {
    db.removeChannel(channel);
  };
}

