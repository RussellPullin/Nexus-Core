import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  normalizeManifestPacks,
  validateLibraryPacks
} from './documentLibrary.service.js';

describe('documentLibrary packs', () => {
  test('normalizeManifestPacks prefers packs array over legacy pack', () => {
    assert.deepEqual(
      normalizeManifestPacks({ packs: ['participant_onboarding', 'staff_onboarding'], pack: 'policy_library' }),
      ['participant_onboarding', 'staff_onboarding']
    );
  });

  test('normalizeManifestPacks falls back to legacy pack string', () => {
    assert.deepEqual(normalizeManifestPacks({ pack: 'staff_onboarding' }), ['staff_onboarding']);
  });

  test('validateLibraryPacks allows both onboarding packs together', () => {
    assert.deepEqual(
      validateLibraryPacks(['participant_onboarding', 'staff_onboarding']),
      ['participant_onboarding', 'staff_onboarding']
    );
  });

  test('validateLibraryPacks rejects policy_library combined with onboarding', () => {
    assert.throws(
      () => validateLibraryPacks(['policy_library', 'staff_onboarding']),
      /policy_library cannot be combined/
    );
  });

  test('validateLibraryPacks allows empty array for unassigned', () => {
    assert.deepEqual(validateLibraryPacks([]), []);
  });
});

describe('listOnboardingLibraryMasters packs query', () => {
  test('doc with both onboarding packs appears in participant and staff lists', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE document_library_masters (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE,
        display_name TEXT,
        manifest_json TEXT,
        is_active INTEGER DEFAULT 1
      );
      CREATE TABLE document_library_org_clones (
        id TEXT PRIMARY KEY,
        master_id TEXT,
        org_id TEXT,
        is_active INTEGER DEFAULT 1
      );
    `);

    const orgId = 'org-1';
    const masterId = 'master-both';
    const manifest = {
      slug: 'privacy-policy',
      display_name: 'Privacy Policy',
      packs: ['participant_onboarding', 'staff_onboarding']
    };

    sqlite.prepare(`
      INSERT INTO document_library_masters (id, slug, display_name, manifest_json, is_active)
      VALUES (?, ?, ?, ?, 1)
    `).run(masterId, manifest.slug, manifest.display_name, JSON.stringify(manifest));

    sqlite.prepare(`
      INSERT INTO document_library_org_clones (id, master_id, org_id, is_active)
      VALUES ('clone-1', ?, ?, 1)
    `).run(masterId, orgId);

    const query = `
      SELECT m.id, m.slug, m.display_name, m.manifest_json
      FROM document_library_masters m
      JOIN document_library_org_clones c ON c.master_id = m.id AND c.org_id = ?
      WHERE c.is_active = 1
        AND m.is_active = 1
        AND (
          JSON_EXTRACT(m.manifest_json, '$.pack') = ?
          OR EXISTS (
            SELECT 1 FROM json_each(JSON_EXTRACT(m.manifest_json, '$.packs'))
            WHERE value = ?
          )
        )
      ORDER BY m.display_name COLLATE NOCASE
    `;

    const participant = sqlite.prepare(query).all(orgId, 'participant_onboarding', 'participant_onboarding');
    const staff = sqlite.prepare(query).all(orgId, 'staff_onboarding', 'staff_onboarding');

    assert.equal(participant.length, 1);
    assert.equal(staff.length, 1);
    assert.equal(participant[0].slug, 'privacy-policy');
    assert.equal(staff[0].slug, 'privacy-policy');

    sqlite.close();
  });
});
