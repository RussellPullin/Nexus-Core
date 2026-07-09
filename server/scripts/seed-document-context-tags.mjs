#!/usr/bin/env node
/**
 * Seed participant_service_types and staff_roles on library manifest.json files.
 * Conservative defaults: most docs get ["all"]; specific titles/slugs get targeted tags.
 *
 * Usage: node server/scripts/seed-document-context-tags.mjs
 */
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libraryRoot = process.env.DOCUMENT_LIBRARY_DIR || join(__dirname, '../templates/library');

function inferParticipantServiceTypes(slug, displayName, pack) {
  const text = `${slug} ${displayName}`.toLowerCase();
  if (pack !== 'participant_onboarding' && pack !== 'policy_library') return null;

  if (/\bsil\b|supported.independent.living|services-agreement-sil/.test(text)) {
    return ['sil'];
  }
  if (/\bsda\b|specialist.disability.accommodation|home modifications and sda/.test(text)) {
    if (/sil/.test(text)) return ['sil', 'sda'];
    return ['sda'];
  }
  if (/support.coord/.test(text)) {
    return ['support_coordination'];
  }
  if (pack === 'participant_onboarding') {
    return ['all'];
  }
  return null;
}

function inferStaffRoles(slug, displayName, pack) {
  const text = `${slug} ${displayName}`.toLowerCase();
  if (pack !== 'staff_onboarding') return null;

  if (/support.coordinator|support-coordinator/.test(text)) {
    return ['support_coordinator'];
  }
  if (/disability.support.worker|support.worker/.test(text)) {
    return ['disability_support_worker'];
  }
  if (/administration|business.development|\badmin\b|director/.test(text)) {
    return ['admin'];
  }
  if (/independent.contractor|subcontractor/.test(text)) {
    return ['disability_support_worker'];
  }
  return ['all'];
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

const entries = readdirSync(libraryRoot).filter((name) => {
  try {
    return statSync(join(libraryRoot, name)).isDirectory();
  } catch {
    return false;
  }
});

let updated = 0;
let scanned = 0;

for (const dirName of entries) {
  const manifestPath = join(libraryRoot, dirName, 'manifest.json');
  if (!existsSync(manifestPath)) continue;
  scanned += 1;

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    console.warn(`Skip invalid JSON: ${manifestPath}`);
    continue;
  }

  const pack = manifest.pack || null;
  const participantTypes = inferParticipantServiceTypes(manifest.slug || dirName, manifest.display_name || '', pack);
  const staffRoles = inferStaffRoles(manifest.slug || dirName, manifest.display_name || '', pack);

  let changed = false;
  if (participantTypes && !arraysEqual(manifest.participant_service_types, participantTypes)) {
    manifest.participant_service_types = participantTypes;
    changed = true;
  }
  if (staffRoles && !arraysEqual(manifest.staff_roles, staffRoles)) {
    manifest.staff_roles = staffRoles;
    changed = true;
  }

  if (changed) {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    updated += 1;
    console.log(`Updated ${manifest.slug || dirName}:`, {
      participant_service_types: manifest.participant_service_types,
      staff_roles: manifest.staff_roles
    });
  }
}

console.log(`Scanned ${scanned} manifests, updated ${updated}. Run document library sync to push to DB.`);
