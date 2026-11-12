﻿export const APP_CONFIG = {
  supabaseUrl: 'https://clgdqfxvibpfntascncb.supabase.co',
  supabaseAnonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNsZ2RxZnh2aWJwZm50YXNjbmNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1Mzc0OTMsImV4cCI6MjA5NzExMzQ5M30.H_tdQfV8QYtNw87_iWyuEfwVqviyKVHYr-21YyldJrU',
  lockTtlSeconds: 90,
  lockRefreshSeconds: 30,
  liveAutosaveDebounceMs: 800,
};

export const ROLES = {
  SUPER_ADMIN: 'super_admin',
  MATCH_MANAGER: 'match_manager',  
};

export const TEAM_SPORTS = ['pallavolo'];

export const SPORT_LABELS = {
  pallavolo: 'Beach Volley',
};

export const TOURNAMENT_FORMATS = {
  gironi: 'Gironi',
  eliminazione: 'Eliminazione Diretta',
};
