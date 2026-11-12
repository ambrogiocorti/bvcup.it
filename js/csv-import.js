import { db, run } from './db.js';

const BATCH_SIZE = 250;
const PREVIEW_ROWS_LIMIT = 8;

const MODE_INFO = {
  teams_players: {
    title: 'Import Squadre e Studenti',
    templateName: 'template_squadre_studenti.csv',
    templateContent: 'team_name;student_full_name\n4A;Mario Rossi\n4A;Giulia Bianchi\n5B;Luca Verdi\n',
    requiredFields: ['team_name', 'student_full_name'],
    allFields: ['team_name', 'student_full_name'],
  },
};

const FIELD_ALIASES = {
  team_name: ['team_name', 'team', 'squadra', 'classe', 'class_name'],
  student_full_name: [
    'student_full_name',
    'full_name',
    'student_name',
    'studente',
    'nome_studente',
    'nome',
  ],
  event_name: ['event_name', 'evento', 'nome_evento'],
  unit: ['unit', 'unita', 'unita_evento'],
  sort_order: ['sort_order', 'ordinamento', 'ordine', 'order'],
  is_active: ['is_active', 'attivo', 'active'],
  value: ['value', 'valore', 'risultato', 'punteggio', 'tempo', 'misura'],
  notes: ['notes', 'note'],
};

function ensureMode(mode) {
  if (!MODE_INFO[mode]) {
    throw new Error('Modalità CSV non supportata');
  }
}

function normalizeValue(value) {
  return String(value ?? '').trim();
}

function normalizeKey(value) {
  return normalizeValue(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeHeader(value) {
  return normalizeKey(value)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function chunkArray(values, size = BATCH_SIZE) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

function countSeparatorInLine(line, separator) {
  let inQuotes = false;
  let count = 0;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && char === separator) {
      count += 1;
    }
  }
  return count;
}

function detectDelimiter(text) {
  const firstLine = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) return ';';

  const semicolons = countSeparatorInLine(firstLine, ';');
  const commas = countSeparatorInLine(firstLine, ',');

  if (semicolons === 0 && commas > 0) return ',';
  if (commas === 0 && semicolons > 0) return ';';
  return semicolons >= commas ? ';' : ',';
}

export function parseCsv(text) {
  const cleanText = String(text ?? '').replace(/^\uFEFF/, '');
  if (!cleanText.trim()) {
    throw new Error('Il file CSV è vuoto.');
  }

  const delimiter = detectDelimiter(cleanText);
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < cleanText.length; i += 1) {
    const char = cleanText[i];
    const next = cleanText[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      row.push(cell);
      cell = '';
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  row.push(cell);
  rows.push(row);

  if (inQuotes) {
    throw new Error('Virgolette non chiuse nel CSV.');
  }

  const nonEmptyRows = rows.filter((items) => items.some((item) => normalizeValue(item) !== ''));
  if (!nonEmptyRows.length) {
    throw new Error('Il CSV non contiene dati validi.');
  }

  const headers = nonEmptyRows[0].map((value) => normalizeValue(value));
  if (!headers.length || headers.every((item) => !item)) {
    throw new Error('Intestazione CSV mancante o non valida.');
  }

  const dataRows = nonEmptyRows.slice(1).map((items) => {
    const normalized = [];
    const len = Math.max(items.length, headers.length);
    for (let i = 0; i < len; i += 1) {
      normalized.push(normalizeValue(items[i]));
    }
    return normalized;
  });

  return { headers, rows: dataRows, delimiter };
}

function resolveHeaderIndexes(headers, fields) {
  const normalizedHeaders = headers.map((header) => normalizeHeader(header));
  const indexes = {};

  fields.forEach((field) => {
    const aliases = FIELD_ALIASES[field] ?? [field];
    const normalizedAliases = aliases.map((alias) => normalizeHeader(alias));
    const idx = normalizedHeaders.findIndex((header) => normalizedAliases.includes(header));
    indexes[field] = idx;
  });

  return indexes;
}

function createValidationResult() {
  return {
    errors: [],
    warnings: [],
    validRows: [],
    stats: {
      totalRows: 0,
      validRows: 0,
      invalidRows: 0,
      warnings: 0,
      errors: 0,
    },
  };
}

function parseBoolean(value, defaultValue = true) {
  const text = normalizeKey(value);
  if (!text) return defaultValue;
  if (['1', 'true', 'yes', 'y', 'si', 's'].includes(text)) return true;
  if (['0', 'false', 'no', 'n'].includes(text)) return false;
  return null;
}

function normalizeUnit(value) {
  const text = normalizeKey(value);
  if (['time', 'tempo'].includes(text)) return 'time';
  if (['distance', 'distanza'].includes(text)) return 'distance';
  if (['points', 'point', 'punteggio', 'punti'].includes(text)) return 'points';
  return null;
}

function normalizeSortOrder(value) {
  const text = normalizeKey(value);
  if (['asc', 'ascending', 'min', 'minore', 'tempo'].includes(text)) return 'asc';
  if (['desc', 'descending', 'max', 'maggiore'].includes(text)) return 'desc';
  return null;
}

function parsePositiveNumber(value) {
  const text = normalizeValue(value).replace(',', '.');
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

async function loadAthleticsLookups(sportId) {
  return null;
}

export async function validateCsv(mode, rows, context = {}) {
  ensureMode(mode);
  const info = MODE_INFO[mode];
  const result = createValidationResult();
  result.stats.totalRows = (rows ?? []).length;

  const headers = Array.isArray(context.headers) ? context.headers : [];
  if (!headers.length) {
    result.errors.push({ row: null, code: 'missing_headers', message: 'Intestazione CSV mancante.' });
    result.stats.errors = result.errors.length;
    result.stats.invalidRows = result.stats.totalRows;
    return result;
  }

  const headerIndexes = resolveHeaderIndexes(headers, info.allFields);
  const missingRequired = info.requiredFields.filter((field) => headerIndexes[field] < 0);
  if (missingRequired.length) {
    result.errors.push({
      row: null,
      code: 'missing_required_columns',
      message: `Colonne obbligatorie mancanti: ${missingRequired.join(', ')}`,
    });
    result.stats.errors = result.errors.length;
    result.stats.invalidRows = result.stats.totalRows;
    return result;
  }

  const usedIndexes = new Set(
    Object.values(headerIndexes).filter((index) => Number.isInteger(index) && index >= 0)
  );
  const unknownColumns = headers.filter((_, idx) => !usedIndexes.has(idx));
  if (unknownColumns.length) {
    result.warnings.push({
      row: null,
      code: 'unused_columns',
      message: `Colonne ignorate: ${unknownColumns.join(', ')}`,
    });
  }

  const seenKeys = new Set();

  (rows ?? []).forEach((rowValues, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const rowErrors = [];
    const extracted = {};

    info.allFields.forEach((field) => {
      const idx = headerIndexes[field];
      extracted[field] = idx >= 0 ? normalizeValue(rowValues[idx]) : '';
    });

    for (const field of info.requiredFields) {
      if (!normalizeValue(extracted[field])) {
        rowErrors.push(`Campo obbligatorio mancante: ${field}`);
      }
    }

    let normalizedRow = null;
    let duplicateKey = '';

    if (mode === 'teams_players') {
      duplicateKey = `${normalizeKey(extracted.team_name)}|${normalizeKey(extracted.student_full_name)}`;
      normalizedRow = {
        team_name: extracted.team_name,
        student_full_name: extracted.student_full_name,
      };
    }

    if (!rowErrors.length && duplicateKey) {
      if (seenKeys.has(duplicateKey)) {
        rowErrors.push('Riga duplicata nel CSV');
      } else {
        seenKeys.add(duplicateKey);
      }
    }

    if (rowErrors.length) {
      result.errors.push({
        row: rowNumber,
        code: 'row_invalid',
        message: rowErrors.join(' · '),
      });
      return;
    }

    result.validRows.push({
      rowNumber,
      ...normalizedRow,
    });
  });

  result.stats.validRows = result.validRows.length;
  result.stats.invalidRows = Math.max(result.stats.totalRows - result.validRows.length, 0);
  result.stats.errors = result.errors.length;
  result.stats.warnings = result.warnings.length;
  return result;
}

function buildPreviewRows(headers, rows) {
  return (rows ?? []).slice(0, PREVIEW_ROWS_LIMIT).map((row, index) => ({
    rowNumber: index + 2,
    values: headers.map((_, colIdx) => normalizeValue(row[colIdx])),
  }));
}

export async function previewCsvImport(mode, file, context = {}) {
  ensureMode(mode);
  if (!file) {
    throw new Error('Seleziona un file CSV prima di continuare.');
  }

  const text = await file.text();
  const parsed = parseCsv(text);
  const validation = await validateCsv(mode, parsed.rows, {
    ...context,
    headers: parsed.headers,
  });

  return {
    mode,
    fileName: file.name,
    delimiter: parsed.delimiter,
    headers: parsed.headers,
    totalRows: parsed.rows.length,
    previewRows: buildPreviewRows(parsed.headers, parsed.rows),
    validation,
  };
}

function isDuplicateError(error) {
  const code = String(error?.cause?.code ?? '');
  const message = String(error?.message ?? '');
  return code === '23505' || /duplicate key/i.test(message);
}

async function insertInBatches(table, rows, context, { ignoreDuplicates = false } = {}) {
  const chunks = chunkArray(rows, BATCH_SIZE);
  for (const chunk of chunks) {
    try {
      await run(
        db.from(table).insert(chunk),
        `${context} (${table})`
      );
    } catch (error) {
      if (!ignoreDuplicates || !isDuplicateError(error)) {
        throw error;
      }

      for (const row of chunk) {
        try {
          await run(
            db.from(table).insert(row),
            `${context} (${table} riga singola)`
          );
        } catch (rowError) {
          if (!isDuplicateError(rowError)) {
            throw rowError;
          }
        }
      }
    }
  }
}

async function applyTeamsPlayersImport(validRows, sportId) {
  const numericSportId = Number(sportId);
  const summary = {
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errorRows: [],
    meta: {
      teams_created: 0,
      players_created: 0,
    },
  };

  const { data: existingTeams } = await run(
    db.from('teams').select('id, name').eq('sport_id', numericSportId),
    'CSV squadre - caricamento squadre'
  );

  const teamByKey = new Map();
  (existingTeams ?? []).forEach((team) => {
    teamByKey.set(normalizeKey(team.name), { id: Number(team.id), name: team.name });
  });

  const uniqueTeamsMap = new Map();
  validRows.forEach((row) => {
    const key = normalizeKey(row.team_name);
    if (!teamByKey.has(key) && !uniqueTeamsMap.has(key)) {
      uniqueTeamsMap.set(key, {
        sport_id: numericSportId,
        name: row.team_name,
      });
    }
  });

  const teamsToCreate = [...uniqueTeamsMap.values()];
  if (teamsToCreate.length) {
    await insertInBatches(
      'teams',
      teamsToCreate,
      'CSV squadre - inserimento squadre',
      { ignoreDuplicates: true }
    );
  }

  const { data: teamsAfterUpsert } = await run(
    db.from('teams').select('id, name').eq('sport_id', numericSportId),
    'CSV squadre - ricaricamento squadre'
  );

  const finalTeamByKey = new Map();
  (teamsAfterUpsert ?? []).forEach((team) => {
    finalTeamByKey.set(normalizeKey(team.name), { id: Number(team.id), name: team.name });
  });

  const beforeTeamCount = (existingTeams ?? []).length;
  const afterTeamCount = (teamsAfterUpsert ?? []).length;
  summary.meta.teams_created = Math.max(afterTeamCount - beforeTeamCount, 0);

  const teamIds = (teamsAfterUpsert ?? []).map((team) => Number(team.id));
  const existingPlayersByKey = new Set();

  if (teamIds.length) {
    const { data: existingPlayers } = await run(
      db.from('players').select('team_id, full_name').in('team_id', teamIds),
      'CSV squadre - caricamento studenti esistenti'
    );

    (existingPlayers ?? []).forEach((player) => {
      const key = `${Number(player.team_id)}|${normalizeKey(player.full_name)}`;
      existingPlayersByKey.add(key);
    });
  }

  const playersToCreate = [];
  validRows.forEach((row) => {
    const teamRef = finalTeamByKey.get(normalizeKey(row.team_name));
    if (!teamRef) {
      summary.failed += 1;
      summary.errorRows.push({
        row: row.rowNumber,
        message: `Squadra non disponibile: ${row.team_name}`,
      });
      return;
    }

    const key = `${teamRef.id}|${normalizeKey(row.student_full_name)}`;
    if (existingPlayersByKey.has(key)) {
      summary.skipped += 1;
      return;
    }

    existingPlayersByKey.add(key);
    playersToCreate.push({
      team_id: teamRef.id,
      full_name: row.student_full_name,
    });
  });

  if (playersToCreate.length) {
    await insertInBatches(
      'players',
      playersToCreate,
      'CSV squadre - inserimento studenti',
      { ignoreDuplicates: true }
    );
  }

  if (teamIds.length) {
    const { data: playersAfterInsert } = await run(
      db.from('players').select('team_id, full_name').in('team_id', teamIds),
      'CSV squadre - ricaricamento studenti'
    );
    const afterPlayersCount = (playersAfterInsert ?? []).length;
    const beforePlayersCount = existingPlayersByKey.size - playersToCreate.length;
    summary.meta.players_created = Math.max(afterPlayersCount - beforePlayersCount, 0);
  } else {
    summary.meta.players_created = 0;
  }

  summary.inserted = summary.meta.teams_created + summary.meta.players_created;
  return summary;
}

async function applyAthleticsEventsImport(validRows, sportId) {
  const numericSportId = Number(sportId);
  const summary = {
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errorRows: [],
  };

  const { data: existingEvents } = await run(
    db.from('events').select('id, name').eq('sport_id', numericSportId),
    'CSV eventi - caricamento eventi'
  );
  const eventByKey = new Map(
    (existingEvents ?? []).map((event) => [normalizeKey(event.name), Number(event.id)])
  );

  const payload = validRows.map((row) => {
    const key = normalizeKey(row.event_name);
    if (eventByKey.has(key)) {
      summary.updated += 1;
    } else {
      summary.inserted += 1;
      eventByKey.set(key, -1);
    }
    return {
      sport_id: numericSportId,
      name: row.event_name,
      unit: row.unit,
      sort_order: row.sort_order,
      is_active: row.is_active,
    };
  });

  const updates = [];
  const inserts = [];
  payload.forEach((row) => {
    const existingId = eventByKey.get(normalizeKey(row.name));
    if (Number.isFinite(existingId) && existingId > 0) {
      updates.push({
        id: existingId,
        unit: row.unit,
        sort_order: row.sort_order,
        is_active: row.is_active,
      });
    } else {
      inserts.push(row);
    }
  });

  if (inserts.length) {
    await insertInBatches(
      'events',
      inserts,
      'CSV eventi - inserimento eventi',
      { ignoreDuplicates: true }
    );
  }

  for (const row of updates) {
    await run(
      db
        .from('events')
        .update({
          unit: row.unit,
          sort_order: row.sort_order,
          is_active: row.is_active,
        })
        .eq('id', Number(row.id)),
      'CSV eventi - aggiornamento eventi'
    );
  }

  return summary;
}

async function applyAthleticsResultsImport(validRows) {
  const summary = {
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errorRows: [],
  };

  const eventIds = [...new Set(validRows.map((row) => Number(row.event_id)).filter(Boolean))];
  const playerIds = [...new Set(validRows.map((row) => Number(row.player_id)).filter(Boolean))];
  const playerIdSet = new Set(playerIds);

  const existingResultKeys = new Set();
  if (eventIds.length && playerIds.length) {
    const { data: existingResults } = await run(
      db.from('event_results').select('event_id, player_id').in('event_id', eventIds),
      'CSV risultati - caricamento risultati esistenti'
    );

    (existingResults ?? []).forEach((result) => {
      const eventId = Number(result.event_id);
      const playerId = Number(result.player_id);
      if (playerIdSet.has(playerId)) {
        existingResultKeys.add(`${eventId}|${playerId}`);
      }
    });
  }

  const payload = validRows.map((row) => {
    const key = `${Number(row.event_id)}|${Number(row.player_id)}`;
    if (existingResultKeys.has(key)) summary.updated += 1;
    else summary.inserted += 1;

    return {
      event_id: Number(row.event_id),
      player_id: Number(row.player_id),
      value: Number(row.value),
      notes: row.notes ? row.notes : null,
    };
  });

  const inserts = [];
  const updates = [];
  payload.forEach((row) => {
    const key = `${Number(row.event_id)}|${Number(row.player_id)}`;
    if (existingResultKeys.has(key)) {
      updates.push(row);
    } else {
      inserts.push(row);
    }
  });

  if (inserts.length) {
    await insertInBatches(
      'event_results',
      inserts,
      'CSV risultati - inserimento risultati',
      { ignoreDuplicates: true }
    );
  }

  for (const row of updates) {
    await run(
      db
        .from('event_results')
        .update({
          value: Number(row.value),
          notes: row.notes ?? null,
        })
        .eq('event_id', Number(row.event_id))
        .eq('player_id', Number(row.player_id)),
      'CSV risultati - aggiornamento risultati'
    );
  }

  return summary;
}

export async function applyCsvImport(mode, validatedRows, context = {}) {
  ensureMode(mode);
  const rows = Array.isArray(validatedRows) ? validatedRows : [];
  if (!rows.length) {
    return {
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      errorRows: [],
    };
  }

  const sportId = Number(context.sportId || 0);
  if (!sportId) {
    throw new Error('Seleziona un torneo prima di confermare l\'import.');
  }

  if (mode === 'teams_players') {
    return applyTeamsPlayersImport(rows, sportId);
  }

  throw new Error('Modalità CSV non supportata');
}

export function downloadCsvTemplate(mode) {
  ensureMode(mode);
  const info = MODE_INFO[mode];
  const blob = new Blob([info.templateContent], {
    type: 'text/csv;charset=utf-8;',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = info.templateName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 400);
}

export function getCsvModeInfo(mode) {
  ensureMode(mode);
  return MODE_INFO[mode];
}
