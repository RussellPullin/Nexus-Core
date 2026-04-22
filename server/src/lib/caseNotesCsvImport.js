/**
 * Parse case-note CSV exports (flexible column names) and map rows for admin import.
 */
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { isParticipantInRequesterTenant } from './orgScopeSql.js';

function decodeCsvBuffer(buffer) {
  let text = buffer.toString('utf-8').replace(/^\uFEFF/, '');
  if (text.includes('\uFFFD')) {
    text = buffer.toString('latin1');
  }
  return text;
}

function detectCsvDelimiter(firstLine) {
  if (!firstLine) return ',';
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semicolonCount = (firstLine.match(/;/g) || []).length;
  return semicolonCount > commaCount ? ';' : ',';
}

function parseCSVLine(line, delimiter = ',') {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === delimiter && !inQuotes) {
      result.push(current.trim().replace(/^"|"$/g, ''));
      current = '';
    } else {
      current += c;
    }
  }
  result.push(current.trim().replace(/^"|"$/g, ''));
  return result;
}

export function fileToRows(buffer) {
  const text = decodeCsvBuffer(buffer);
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const delimiter = detectCsvDelimiter(lines[0]);
  return lines.map((line) => parseCSVLine(line, delimiter));
}

function normHeader(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

const PARTICIPANT_ID_ALIASES = new Set([
  'participant_id',
  'client_id',
  'nexus_participant_id',
  'nexus_id',
  'p_id',
  'participantid'
]);
const NDIS_ALIASES = new Set(['ndis_number', 'ndis', 'ndis_#', 'ndis_no', 'ndisno', 'participant_ndis', 'ndisnum']);
const DATE_ALIASES = new Set([
  'contact_date',
  'date',
  'note_date',
  'session_date',
  'created',
  'created_at',
  'log_date',
  'dt'
]);
const NOTES_ALIASES = new Set([
  'notes',
  'note',
  'text',
  'body',
  'description',
  'content',
  'case_note',
  'casenote',
  'details',
  'comment',
  'comments'
]);
const TYPE_ALIASES = new Set(['contact_type', 'type', 'method', 'category', 'mode']);

function firstMatchingColumnIndex(headersNorm, aliasSets) {
  for (const set of aliasSets) {
    for (let i = 0; i < headersNorm.length; i++) {
      const h = headersNorm[i];
      if (set.has(h)) return i;
    }
  }
  for (const set of aliasSets) {
    for (let i = 0; i < headersNorm.length; i++) {
      const h = headersNorm[i];
      for (const alias of set) {
        if (h === alias) return i;
        if (h.includes(alias) && alias.length > 3) return i;
      }
    }
  }
  return -1;
}

function findParticipantIdColumn(headersNorm) {
  const idxPid = firstMatchingColumnIndex(headersNorm, [PARTICIPANT_ID_ALIASES]);
  if (idxPid >= 0) return { kind: 'participant_id', index: idxPid };
  const idxNdis = firstMatchingColumnIndex(headersNorm, [NDIS_ALIASES]);
  if (idxNdis >= 0) return { kind: 'ndis_number', index: idxNdis };
  return null;
}

function findNotesColumn(headersNorm) {
  let i = firstMatchingColumnIndex(headersNorm, [NOTES_ALIASES]);
  if (i >= 0) return i;
  for (let j = 0; j < headersNorm.length; j++) {
    if (headersNorm[j] === 'note' || headersNorm[j].endsWith('_notes')) return j;
  }
  return -1;
}

export function detectCaseNotesColumnMap(rawHeaders) {
  const headers = rawHeaders.map((h) => String(h || '').trim());
  const headersNorm = headers.map(normHeader);
  const participant = findParticipantIdColumn(headersNorm);
  const dateIdx = firstMatchingColumnIndex(headersNorm, [DATE_ALIASES]);
  const notesIdx = findNotesColumn(headersNorm);
  const typeIdx = firstMatchingColumnIndex(headersNorm, [TYPE_ALIASES]);
  return {
    headers,
    headersNorm,
    participant_col: participant
      ? { kind: participant.kind, index: participant.index, name: headers[participant.index] }
      : null,
    contact_date_idx: dateIdx,
    contact_date_name: dateIdx >= 0 ? headers[dateIdx] : null,
    notes_idx: notesIdx,
    notes_name: notesIdx >= 0 ? headers[notesIdx] : null,
    contact_type_idx: typeIdx,
    contact_type_name: typeIdx >= 0 ? headers[typeIdx] : null
  };
}

function normalizedNdisKey(raw) {
  if (raw == null) return '';
  return String(raw).replace(/[\s\-_]/g, '').trim();
}

function findParticipantByNdis(ndisRaw) {
  const trimmed = ndisRaw != null ? String(ndisRaw).trim() : '';
  if (!trimmed) return null;
  const norm = normalizedNdisKey(trimmed);
  if (!norm) return null;
  return db
    .prepare(
      `SELECT id FROM participants
       WHERE ndis_number = ?
          OR replace(replace(replace(trim(ndis_number), ' ', ''), '-', ''), '_', '') = ?`
    )
    .get(trimmed, norm);
}

/**
 * @param {string} raw
 * @returns {string|null} YYYY-MM-DD
 */
export function parseContactDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    let y = +m[3];
    if (y < 100) y += 2000;
    if (a > 12) {
      return `${y}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
    }
    if (b > 12) {
      return `${y}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`;
    }
    return `${y}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function getCell(row, idx) {
  if (idx < 0 || idx >= row.length) return '';
  const v = row[idx];
  return v == null ? '' : String(v);
}

/**
 * @param {string[][]} rows — includes header as rows[0]
 * @param {string | null} defaultParticipantId
 * @param {string} userId
 * @param {{ dryRun: boolean, maxRows?: number }} options
 * @returns {{ imported: number, skipped: number, dry_run: boolean, column_map: object, errors: Array<{ line: number, message: string }>, preview: object[] }}
 */
export function importCaseNotesFromRows(rows, defaultParticipantId, userId, options = {}) {
  const { dryRun = false, maxRows = 10000 } = options;
  const result = {
    imported: 0,
    skipped: 0,
    dry_run: dryRun,
    column_map: null,
    errors: [],
    preview: []
  };

  if (!rows || rows.length < 2) {
    result.errors.push({ line: 0, message: 'CSV must include a header row and at least one data row' });
    return result;
  }

  const map = detectCaseNotesColumnMap(rows[0].map((c) => String(c || '')));
  result.column_map = {
    participant: map.participant_col,
    contact_date: map.contact_date_name,
    notes: map.notes_name,
    contact_type: map.contact_type_name
  };

  if (map.notes_idx < 0) {
    result.errors.push({ line: 0, message: 'Could not detect a notes column. Name a column notes, note, text, description, or content.' });
    return result;
  }
  if (map.contact_date_idx < 0) {
    result.errors.push({ line: 0, message: 'Could not detect a date column. Name a column contact_date, date, note_date, or created_at.' });
    return result;
  }
  if (!map.participant_col && !defaultParticipantId) {
    result.errors.push({
      line: 0,
      message: 'No participant column found (e.g. participant_id or ndis_number) and no default participant is selected. Map your CSV or choose a default participant above.'
    });
    return result;
  }

  if (defaultParticipantId && !isParticipantInRequesterTenant(defaultParticipantId, userId)) {
    result.errors.push({ line: 0, message: 'Default participant is not in your organisation or is not accessible.' });
    return result;
  }

  const ins = db.prepare(`
    INSERT INTO case_notes (id, participant_id, contact_type, notes, contact_date, goal_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const dataStart = 1;
  const totalData = rows.length - dataStart;
  if (totalData > maxRows) {
    result.errors.push({ line: 0, message: `Too many rows (max ${maxRows}). Split the file or trim extra lines.` });
    return result;
  }

  for (let i = dataStart; i < rows.length; i++) {
    const lineNum = i + 1;
    const row = rows[i];
    if (!row || row.every((c) => String(c || '').trim() === '')) {
      result.skipped += 1;
      continue;
    }

    let participantId = defaultParticipantId || null;
    if (map.participant_col) {
      const rawP = getCell(row, map.participant_col.index).trim();
      if (!rawP && defaultParticipantId) {
        participantId = defaultParticipantId;
      } else if (map.participant_col.kind === 'participant_id') {
        participantId = rawP;
      } else {
        const found = findParticipantByNdis(rawP);
        participantId = found?.id || null;
        if (!participantId) {
          result.errors.push({ line: lineNum, message: `No participant found for NDIS "${rawP}"` });
          continue;
        }
      }
    }

    if (!participantId) {
      result.errors.push({ line: lineNum, message: 'Missing participant (row has no id/NDIS and no default participant)' });
      continue;
    }
    if (!isParticipantInRequesterTenant(participantId, userId)) {
      result.errors.push({ line: lineNum, message: 'Participant is not in your organisation or is not accessible' });
      continue;
    }

    const contactDate = parseContactDate(getCell(row, map.contact_date_idx));
    if (!contactDate) {
      result.errors.push({ line: lineNum, message: `Invalid or empty date: "${getCell(row, map.contact_date_idx)}"` });
      continue;
    }

    const notes = getCell(row, map.notes_idx);
    if (!notes.trim()) {
      result.errors.push({ line: lineNum, message: 'Notes column is empty' });
      continue;
    }

    let contactType = 'import';
    if (map.contact_type_idx >= 0) {
      const t = getCell(row, map.contact_type_idx).trim();
      if (t) {
        const slug = t
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '');
        contactType = slug || 'import';
      }
    }

    const record = { participant_id: participantId, contact_date: contactDate, contact_type: contactType, notes: notes.slice(0, 200) + (notes.length > 200 ? '…' : '') };
    if (result.preview.length < 5) {
      result.preview.push({ line: lineNum, ...record, notes: notes.length > 500 ? `${notes.slice(0, 500)}…` : notes });
    }

    if (!dryRun) {
      ins.run(uuidv4(), participantId, contactType, notes, contactDate, null);
    }
    result.imported += 1;
  }

  return result;
}
