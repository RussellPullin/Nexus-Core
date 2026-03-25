#!/usr/bin/env node
/**
 * Clear all NDIS line items and shift line items.
 * Run from project root: npm run clear-ndis
 * Or from server: node scripts/clear-ndis-line-items.js
 */
import { db } from '../src/db/index.js';

const shiftResult = db.prepare('DELETE FROM shift_line_items').run();
const ndisResult = db.prepare('DELETE FROM ndis_line_items').run();

console.log(`Cleared ${ndisResult.changes} NDIS line items and ${shiftResult.changes} shift line items.`);
