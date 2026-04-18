#!/usr/bin/env node
/**
 * Online backup of the Nexus SQLite database (better-sqlite3 backup API).
 * Writes timestamped files under DATA_DIR/backups/ and prunes old copies.
 *
 * Production (Fly): DATABASE_PATH=/data/schedule.db DATA_DIR=/data
 * Local: defaults to data/schedule.db and data/
 *
 * Usage:
 *   node server/scripts/backup-sqlite.mjs
 *   fly ssh console -a nexus-core-crm -C "env DATABASE_PATH=/data/schedule.db DATA_DIR=/data NODE_ENV=production node /app/server/scripts/backup-sqlite.mjs"
 */
import { config } from 'dotenv';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
config({ path: join(projectRoot, '.env') });

const KEEP = Math.max(1, Number(process.env.SQLITE_BACKUP_KEEP || 30) || 30);

function resolveDbPath() {
  const raw = process.env.DATABASE_PATH || 'data/schedule.db';
  return raw.startsWith('/') ? raw : resolve(projectRoot, raw);
}

function resolveBackupDir() {
  const dbPath = resolveDbPath();
  const fromEnv = process.env.DATA_DIR?.trim();
  const base = fromEnv
    ? fromEnv.startsWith('/')
      ? fromEnv
      : resolve(projectRoot, fromEnv)
    : dirname(dbPath);
  return join(base, 'backups');
}

function prune(backupDir, keep) {
  const prefix = 'schedule-';
  const suffix = '.db';
  let files = [];
  try {
    files = readdirSync(backupDir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
      .map((name) => ({
        name,
        mtime: statSync(join(backupDir, name)).mtimeMs
      }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return;
  }
  for (let i = keep; i < files.length; i++) {
    try {
      unlinkSync(join(backupDir, files[i].name));
      console.log('[backup-sqlite] removed old backup', files[i].name);
    } catch (e) {
      console.warn('[backup-sqlite] could not remove', files[i].name, e?.message || e);
    }
  }
}

async function main() {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    console.warn('[backup-sqlite] database not found, skipping:', dbPath);
    process.exit(0);
  }

  const backupDir = resolveBackupDir();
  mkdirSync(backupDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = join(backupDir, `schedule-${stamp}.db`);

  const db = new Database(dbPath);
  try {
    await db.backup(outFile);
  } finally {
    db.close();
  }

  console.log('[backup-sqlite] wrote', outFile);
  prune(backupDir, KEEP);
}

main().catch((e) => {
  console.error('[backup-sqlite] failed:', e?.message || e);
  process.exit(1);
});
