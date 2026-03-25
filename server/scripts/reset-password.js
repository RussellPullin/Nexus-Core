#!/usr/bin/env node
/**
 * Reset a user's password. Usage:
 *   node server/scripts/reset-password.js <email> <new-password>
 * Example:
 *   node server/scripts/reset-password.js admin@example.com mynewpassword
 */
import { config } from 'dotenv';
import bcrypt from 'bcrypt';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
config({ path: join(projectRoot, '.env') });

import Database from 'better-sqlite3';
const dbPath = resolve(projectRoot, process.env.DATABASE_PATH || 'data/schedule.db');
const db = new Database(dbPath);

const [email, newPassword] = process.argv.slice(2);
if (!email || !newPassword) {
  console.error('Usage: node server/scripts/reset-password.js <email> <new-password>');
  process.exit(1);
}

const emailNorm = email.trim().toLowerCase();
const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(emailNorm);
if (!user) {
  console.error('User not found:', emailNorm);
  process.exit(1);
}

const hash = bcrypt.hashSync(newPassword.trim(), 10);
db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, user.id);
console.log('Password reset for', user.email);
process.exit(0);
