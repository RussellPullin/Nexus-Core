#!/usr/bin/env node
/**
 * List users in the database. Usage: node server/scripts/list-users.js
 */
import { config } from 'dotenv';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
config({ path: join(projectRoot, '.env') });

import Database from 'better-sqlite3';
const dbPath = resolve(projectRoot, process.env.DATABASE_PATH || 'data/schedule.db');

let db;
try {
  db = new Database(dbPath);
} catch (e) {
  console.error('Cannot open DB at', dbPath, '-', e.message);
  process.exit(1);
}

try {
  const users = db.prepare('SELECT id, email, name, created_at FROM users').all();
  console.log('Users:', users.length);
  users.forEach((u) => console.log('  -', u.email, u.name ? `(${u.name})` : ''));
} finally {
  db.close();
}
