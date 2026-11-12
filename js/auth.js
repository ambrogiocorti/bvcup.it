import { db, run } from './db.js';
import { ROLES } from './app-config.js';
import { showToast } from './utils.js';

export async function getSession() {
  const {
    data: { session },
    error,
  } = await db.auth.getSession();
  if (error) {
    throw new Error(`Errore sessione: ${error.message}`);
  }
  return session;
}

export async function getCurrentUser() {
  const {
    data: { user },
    error,
  } = await db.auth.getUser();
  if (error) {
    throw new Error(`Errore utente: ${error.message}`);
  }
  return user;
}

export async function getAdminProfile(userId) {
  if (!userId) return null;
  const { data } = await run(
    db
      .from('admins')
      .select('id, nome, email, ruolo')
      .eq('id', userId)
      .maybeSingle(),
    'Caricamento profilo admin'
  );
  return data;
}

export async function requireAdmin({
  redirectTo = 'index.html',
  allowedRoles = [ROLES.SUPER_ADMIN, ROLES.MATCH_MANAGER, ROLES.REPORT_VIEWER],
} = {}) {
  const user = await getCurrentUser();
  if (!user) {
    window.location.href = redirectTo;
    return { user: null, admin: null, allowed: false };
  }

  const admin = await getAdminProfile(user.id);
  const allowed = Boolean(admin && allowedRoles.includes(admin.ruolo));

  if (!allowed) {
    if (!admin) {
      showToast("Accesso negato: Profilo amministratore non trovato nel database.", "error");
    } else {
      showToast("Accesso negato: Ruolo non autorizzato.", "error");
    }
    // Aspetta un secondo per permettere all'utente di leggere il toast prima del redirect
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.auth.signOut();
    window.location.href = redirectTo;
    return { user, admin, allowed: false };
  }

  return { user, admin, allowed: true };
}

export async function signInAdmin(email, password) {
  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(error.message);
  }
  return true;
}

export async function signOutAdmin() {
  const { error } = await db.auth.signOut();
  if (error) {
    throw new Error(error.message);
  }
}

export function canEditMatches(role) {
  return role === ROLES.SUPER_ADMIN || role === ROLES.MATCH_MANAGER;
}

export function canManageAll(role) {
  return role === ROLES.SUPER_ADMIN;
}

export function canViewReports(role) {
  return (
    role === ROLES.SUPER_ADMIN ||
    role === ROLES.MATCH_MANAGER ||
    role === ROLES.REPORT_VIEWER
  );
}
