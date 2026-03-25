#!/usr/bin/env node
/**
 * Prints a production-safe SESSION_SECRET for Railway/host env (paste only; never commit).
 * Run: node scripts/generate-session-secret.mjs
 */
import crypto from 'crypto';

const secret = crypto.randomBytes(48).toString('base64url');
console.log('Paste into your host (Railway Variables, etc.):');
console.log('');
console.log(`SESSION_SECRET=${secret}`);
console.log('');
