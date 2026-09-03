import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import {
  normalizeManifestPacks,
  validateLibraryPacks,
  extractPolicySections
} from './documentLibrary.service.js';
import {
  mergeSectionsWithOverrides,
  renderFlatTokens,
  resolveOverrideStrategy
} from './documentLibraryRender.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDocxPath = join(__dirname, '../../templates/library/choice-advocacy-and-control-policy/template.docx');

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

describe('extractPolicySections', () => {
  test('splits a real policy docx into named top-level sections, keeping tables atomic', async (t) => {
    if (!existsSync(fixtureDocxPath)) {
      t.skip('DOCX policy fixtures were replaced by tokenised PDF masters');
      return;
    }
    const sections = await extractPolicySections(fixtureDocxPath, []);
    const headings = sections.map((s) => s.heading);

    // Named blocks split correctly whether the source docx used H1 directly (Policy Statement,
    // Procedure) or H1-wrapping-H2 (Introduction -> Purpose/Policy Aims/...).
    assert.ok(headings.includes('Policy Statement'), 'Policy Statement should be its own section');
    assert.ok(headings.includes('Procedure'), 'Procedure should be its own section');
    assert.ok(headings.includes('Purpose'), 'Purpose should be its own section');

    // The Procedure table's row/column headers (e.g. "Responsibility") must NOT be split out as
    // their own top-level sections — that would shred the table.
    assert.ok(!headings.includes('Responsibility'), 'table header cells must not become sections');

    const procedure = sections.find((s) => s.heading === 'Procedure');
    assert.ok(procedure.content_html.includes('<table'), 'Procedure section should contain its table');

    // Every key is unique.
    const keys = sections.map((s) => s.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  test('reuses section keys across a re-sync when heading text matches, even out of order', async (t) => {
    if (!existsSync(fixtureDocxPath)) {
      t.skip('DOCX policy fixtures were replaced by tokenised PDF masters');
      return;
    }
    const first = await extractPolicySections(fixtureDocxPath, []);
    const second = await extractPolicySections(fixtureDocxPath, first);
    assert.deepEqual(second.map((s) => s.key), first.map((s) => s.key));

    const shuffled = [...first].reverse();
    shuffled[0] = { ...shuffled[0], heading: 'Some heading that will not match anything' };
    const third = await extractPolicySections(fixtureDocxPath, shuffled);
    const policyStatementBefore = first.find((s) => s.heading === 'Policy Statement').key;
    const policyStatementAfter = third.find((s) => s.heading === 'Policy Statement').key;
    assert.equal(policyStatementAfter, policyStatementBefore);
  });
});

describe('mergeSectionsWithOverrides', () => {
  const sections = [
    { key: 'intro', heading: 'Introduction', content_html: '<h1>Introduction</h1>' },
    { key: 'policy-aims', heading: 'Policy Aims', content_html: '<h2>Policy Aims</h2><p>master text</p>' }
  ];

  test('passes master content through untouched when there are no overrides', () => {
    const merged = mergeSectionsWithOverrides(sections, []);
    assert.ok(merged.includes('master text'));
    assert.ok(!merged.includes('override text'));
  });

  test('substitutes only the matching section, leaving others as master content', () => {
    const merged = mergeSectionsWithOverrides(sections, [
      { section_key: 'policy-aims', content_html: '<h2>Policy Aims</h2><p>override text</p>' }
    ]);
    assert.ok(merged.includes('<h1>Introduction</h1>'), 'untouched section stays as master content');
    assert.ok(merged.includes('override text'));
    assert.ok(!merged.includes('master text'));
  });
});

describe('renderFlatTokens', () => {
  test('substitutes known single-brace tokens and HTML-escapes the value', () => {
    const out = renderFlatTokens('<p>{org.name} & co</p>', { 'org.name': 'A <B> Co' });
    assert.equal(out, '<p>A &lt;B&gt; Co & co</p>');
  });

  test('leaves unknown tokens untouched instead of blanking them', () => {
    const out = renderFlatTokens('<p>{org.name} {not.a.real.token}</p>', { 'org.name': 'Acme' });
    assert.equal(out, '<p>Acme {not.a.real.token}</p>');
  });
});

describe('resolveOverrideStrategy', () => {
  test('full_upload wins once a file has actually been uploaded', () => {
    assert.equal(
      resolveOverrideStrategy({ overrideMode: 'full_upload', hasSectionsJson: true, hasFullUpload: true, hasSectionOverrides: true }),
      'full_upload'
    );
  });

  test('full_upload mode with nothing uploaded yet falls back to default', () => {
    assert.equal(
      resolveOverrideStrategy({ overrideMode: 'full_upload', hasSectionsJson: true, hasFullUpload: false, hasSectionOverrides: false }),
      'default'
    );
  });

  test('sections mode with zero saved overrides renders identically to inherit (default)', () => {
    assert.equal(
      resolveOverrideStrategy({ overrideMode: 'sections', hasSectionsJson: true, hasFullUpload: false, hasSectionOverrides: false }),
      'default'
    );
  });

  test('sections mode with at least one override uses the stitched render', () => {
    assert.equal(
      resolveOverrideStrategy({ overrideMode: 'sections', hasSectionsJson: true, hasFullUpload: false, hasSectionOverrides: true }),
      'sections'
    );
  });

  test('plain inherit mode always uses default rendering', () => {
    assert.equal(
      resolveOverrideStrategy({ overrideMode: 'inherit', hasSectionsJson: true, hasFullUpload: true, hasSectionOverrides: true }),
      'default'
    );
  });
});
