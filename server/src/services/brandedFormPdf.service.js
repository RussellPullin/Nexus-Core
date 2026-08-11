/**
 * Generic branded PDF renderer for structured Nexus form templates.
 *
 * Master templates own document structure. Org templates may override variable values,
 * branding, and unlocked section copy; locked master sections always render from master.
 */
import PDFDocument from 'pdfkit';
import { existsSync } from 'fs';
import { join, resolve, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import {
  enrichVariablesFromOrgProfile,
  mergeBranding,
  mergeVariableValues,
  interpolateTemplate,
  parseJson
} from './nexusFormTemplateRuntime.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const dataUploadsDir = process.env.DATA_DIR
  ? join(process.env.DATA_DIR, 'uploads')
  : join(projectRoot, 'data', 'uploads');

const DEFAULT_LAYOUT = {
  paper: 'A4',
  margins: { top: 48, right: 48, bottom: 56, left: 48 },
  font_family: 'Helvetica',
  font_size: 9.5,
  header_height: 108
};

function validHex(value, fallback) {
  const raw = String(value || '').trim();
  if (/^#?[0-9a-fA-F]{6}$/.test(raw)) {
    return raw.startsWith('#') ? raw : `#${raw}`;
  }
  return fallback;
}

function marginBox(layout) {
  const m = layout?.margins || {};
  return {
    top: Number(m.top) || 48,
    right: Number(m.right) || 48,
    bottom: Number(m.bottom) || 56,
    left: Number(m.left) || 48
  };
}

function parseArray(value) {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function parseObject(value, fallback = {}) {
  const parsed = parseJson(value, fallback);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
}

function resolveLogoFullPath(branding, org) {
  // business_settings (org.business_logo_filename) first — that's what Settings actually
  // updates when an admin uploads a new logo. organisations.logo_path is only ever set once,
  // during initial org setup, and never updated again, so preferring it here meant a logo
  // change in Settings would silently never show up on rendered documents. Then template
  // branding as a last resort. Accept both snake_case (raw DB row) and camelCase (orgContext shape).
  const legacy = org?.business_logo_filename;
  if (legacy) {
    const file = String(legacy).trim().replace(/^.*[/\\]/, '');
    const candidates = [
      join(dataUploadsDir, file),
      join(projectRoot, 'data', 'uploads', file)
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  }

  if (org?.logo_path || org?.logoPath) {
    const raw = String(org.logo_path || org.logoPath || '').trim();
    if (raw) {
      const candidates = isAbsolute(raw)
        ? [raw]
        : [
            join(projectRoot, raw),
            join(dataUploadsDir, raw.replace(/^.*[/\\]/, '')),
            join(dataUploadsDir, raw)
          ];
      for (const p of candidates) {
        if (existsSync(p)) return p;
      }
    }
  }

  const rel = branding?.logo_relative_path;
  if (!rel) return null;
  const trimmed = String(rel).trim();
  const candidates = [
    join(projectRoot, trimmed),
    join(dataUploadsDir, trimmed.replace(/^.*[/\\]/, '')),
    join(dataUploadsDir, trimmed)
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/(p|div|h[1-6])\s*>/gi, '\n\n')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function slotValuesFromArray(slots) {
  const out = {};
  for (const slot of slots || []) {
    if (!slot?.key) continue;
    const value = slot.value ?? slot.current_value ?? slot.default_value;
    if (value !== undefined) out[slot.key] = value;
  }
  return out;
}

function mergeSections(masterSectionsJson, orgSectionsJson) {
  const masterSections = parseArray(masterSectionsJson);
  const orgSections = new Map(parseArray(orgSectionsJson).map((s) => [s.id, s]));
  return masterSections.map((masterSection) => {
    const orgSection = orgSections.get(masterSection.id) || {};
    if (masterSection.locked) {
      return { ...masterSection, locked: true };
    }
    return {
      ...masterSection,
      title: String(orgSection.title || masterSection.title || '').trim() || masterSection.title,
      body_html:
        typeof orgSection.body_html === 'string'
          ? orgSection.body_html
          : masterSection.body_html,
      locked: false
    };
  });
}

function loadIntakeFields(participantId, database) {
  if (!participantId) return {};
  const onboarding = database
    .prepare(
      `SELECT id FROM participant_onboarding WHERE participant_id = ? ORDER BY datetime(updated_at) DESC LIMIT 1`
    )
    .get(participantId);
  if (!onboarding) return {};
  const rows = database
    .prepare(`SELECT field_key, field_value FROM participant_intake_fields WHERE participant_onboarding_id = ?`)
    .all(onboarding.id);
  return Object.fromEntries(rows.map((row) => [row.field_key, row.field_value]));
}

function formatAusDate(iso) {
  if (!iso || typeof iso !== 'string') return '';
  const s = iso.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return iso;
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

function currentOrLatestPlan(participantId, database) {
  if (!participantId) return null;
  const today = new Date().toISOString().slice(0, 10);
  return (
    database
      .prepare(
        `SELECT * FROM ndis_plans WHERE participant_id = ? AND start_date <= ? AND end_date >= ?
         ORDER BY start_date DESC LIMIT 1`
      )
      .get(participantId, today, today) ||
    database
      .prepare(`SELECT * FROM ndis_plans WHERE participant_id = ? ORDER BY end_date DESC LIMIT 1`)
      .get(participantId) ||
    null
  );
}

export function buildBrandedFormRenderModel(orgTemplateId, participantId, database) {
  if (!orgTemplateId) throw new Error('orgTemplateId is required');
  if (!database) throw new Error('db is required');

  const row = database
    .prepare(
      `SELECT i.*,
              m.template_key,
              m.template_type,
              m.title AS master_title,
              m.version_label,
              m.definition_json AS master_definition_json,
              m.variable_schema_json AS master_variable_schema_json,
              m.branding_slots_json AS master_branding_slots_json,
              m.variable_slots_json AS master_variable_slots_json,
              m.sections_json AS master_sections_json,
              m.page_layout_json AS master_page_layout_json,
              m.category AS master_category
       FROM nexus_org_form_templates i
       JOIN nexus_form_template_masters m ON m.id = i.master_id
       WHERE i.id = ?`
    )
    .get(orgTemplateId);
  if (!row) throw new Error('Organisation template not found');

  const org = database.prepare('SELECT * FROM organisations WHERE id = ?').get(row.org_id);
  if (!org) throw new Error('Organisation not found');

  const participant = participantId
    ? database.prepare('SELECT * FROM participants WHERE id = ?').get(participantId)
    : null;
  if (participantId && !participant) throw new Error('Participant not found');

  const businessSettings = database.prepare('SELECT * FROM business_settings WHERE org_id = ?').get(row.org_id);
  const orgWithLogoFallback = { ...org, business_logo_filename: businessSettings?.logo_path || null };
  const adminUser = database
    .prepare(`SELECT name FROM users WHERE org_id = ? AND role = 'admin' ORDER BY created_at ASC LIMIT 1`)
    .get(row.org_id);

  const masterVariableSlots = parseArray(row.master_variable_slots_json);
  const orgVariableSlots = parseArray(row.variable_slots_json);
  let variableMap = {
    ...slotValuesFromArray(masterVariableSlots),
    ...mergeVariableValues(row.master_variable_schema_json, row.variable_values_json),
    ...slotValuesFromArray(orgVariableSlots)
  };
  variableMap = enrichVariablesFromOrgProfile(variableMap, org, businessSettings, adminUser?.name || '');

  const intake = loadIntakeFields(participantId, database);
  const plan = currentOrLatestPlan(participantId, database);
  const participantMap = participant
    ? {
        participant_name: participant.name || '',
        participant_phone: participant.phone || intake.phone || '',
        participant_email: participant.email || intake.email || '',
        participant_address: participant.address || intake.street_address || '',
        participant_dob: formatAusDate(participant.date_of_birth || intake.date_of_birth),
        participant_ndis_number: participant.ndis_number || intake.ndis_number || '',
        plan_start: formatAusDate(plan?.start_date || ''),
        plan_end: formatAusDate(plan?.end_date || '')
      }
    : {};

  const branding = mergeBranding(row.branding_json);
  const primaryColour = validHex(org.brand_primary_color || branding.primary_color, '#1e3a5f');
  const accentColour = validHex(org.brand_accent_color || branding.accent_color, '#2563eb');
  const pageLayout = {
    ...DEFAULT_LAYOUT,
    ...parseObject(row.page_layout_json, parseObject(row.master_page_layout_json, DEFAULT_LAYOUT))
  };
  const sections = mergeSections(row.master_sections_json, row.sections_json);
  // org_legal_name is the editable field in the SA template editor so it wins over
  // org_trading_name (which may be stale from a previous DB value).  Sync org_trading_name
  // so {{org_trading_name}} in clause body text resolves to the same correct value.
  const resolvedOrgName =
    variableMap.org_legal_name || variableMap.org_trading_name || org.legal_name || org.trading_name || org.name || '';
  const orgDerivedVariables = {
    org_name: resolvedOrgName,
    org_trading_name: resolvedOrgName,   // override stale saved value so clause text is correct
    abn: variableMap.org_abn || org.abn || '',
    address: variableMap.org_address || org.address || '',
    phone: variableMap.org_phone || org.phone || '',
    email: variableMap.org_email || org.email || '',
    today: formatAusDate(new Date().toISOString().slice(0, 10))
  };
  const resolvedVariables = { ...variableMap, ...participantMap, ...orgDerivedVariables };
  for (const [key, value] of Object.entries(resolvedVariables)) {
    if (typeof value === 'string' && value.includes('{{')) {
      resolvedVariables[key] = interpolateTemplate(value, resolvedVariables);
    }
  }

  return {
    org_template_id: row.id,
    master_id: row.master_id,
    template_key: row.template_key,
    title: row.label || row.master_title || 'Nexus Form',
    category: row.category || row.master_category || row.template_type || 'custom',
    version_label: row.version_label || '',
    branding_slots: parseArray(row.branding_slots_json).length
      ? parseArray(row.branding_slots_json)
      : parseArray(row.master_branding_slots_json),
    variable_slots: orgVariableSlots.length ? orgVariableSlots : masterVariableSlots,
    variables: resolvedVariables,
    org: orgWithLogoFallback,
    participant,
    branding: { ...branding, primary_color: primaryColour, accent_color: accentColour },
    page_layout: pageLayout,
    sections,
    generated_at_iso: new Date().toISOString()
  };
}

export async function renderBrandedForm(orgTemplateId, participantId, database) {
  const model = buildBrandedFormRenderModel(orgTemplateId, participantId, database);
  const margins = marginBox(model.page_layout);
  const primary = model.branding.primary_color;
  const accent = model.branding.accent_color;
  const font = model.page_layout.font_family === 'Helvetica' ? 'Helvetica' : 'Helvetica';
  const baseSize = Number(model.page_layout.font_size) || 9.5;

  return new Promise((resolvePromise, reject) => {
    const doc = new PDFDocument({
      size: model.page_layout.paper || 'A4',
      margins,
      bufferPages: true
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolvePromise(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width;
    const contentWidth = pageWidth - margins.left - margins.right;
    const footerReserve = margins.bottom;
    let y = margins.top;

    const drawContinuationHeader = () => {
      doc.save();
      doc.fillColor(primary).font('Helvetica-Bold').fontSize(9);
      doc.text(model.title, margins.left, margins.top - 18, { width: contentWidth / 2, lineBreak: false });
      doc.fillColor('#64748b').font(font).fontSize(8);
      doc.text(model.variables.org_name || '', margins.left + contentWidth / 2, margins.top - 18, {
        width: contentWidth / 2,
        align: 'right',
        lineBreak: false,
        ellipsis: true
      });
      doc.strokeColor(accent).lineWidth(1);
      doc.moveTo(margins.left, margins.top - 4).lineTo(pageWidth - margins.right, margins.top - 4).stroke();
      doc.restore();
    };

    const ensureSpace = (needed) => {
      if (y + needed > doc.page.height - footerReserve) {
        doc.addPage();
        drawContinuationHeader();
        y = margins.top + 18;
      }
    };

    const drawHeader = () => {
      doc.save();
      doc.rect(0, 0, pageWidth, model.page_layout.header_height || 108).fill('#f8fafc');
      const logoPath = resolveLogoFullPath(model.branding, model.org);
      if (logoPath) {
        try {
          doc.image(logoPath, margins.left, 18, { fit: [80, 44], align: 'left', valign: 'center' });
        } catch {
          /* corrupt logos are skipped */
        }
      }
      const orgName = model.variables.org_name || model.org.name || 'Organisation';
      doc.fillColor('#1f2937').font('Helvetica-Bold').fontSize(13);
      doc.text(model.title, margins.left + 96, 48, { width: contentWidth - 192, align: 'center', lineBreak: false });
      doc.fillColor(primary).font('Helvetica-Bold').fontSize(16);
      doc.text(orgName, margins.left + 96, 22, { width: contentWidth - 96, align: 'right', lineBreak: false });
      // version_label intentionally omitted — internal versioning is not shown to participants
      doc.strokeColor(accent).lineWidth(2);
      doc.moveTo(margins.left, (model.page_layout.header_height || 108) - 6).lineTo(pageWidth - margins.right, (model.page_layout.header_height || 108) - 6).stroke();
      doc.restore();
      y = Math.max(y, (model.page_layout.header_height || 108) + 18);
    };

    const drawFooter = (pageNumber, pageCount) => {
      const footerY = doc.page.height - margins.bottom + 12;
      const parts = [
        model.variables.abn ? `ABN ${model.variables.abn}` : '',
        `Generated ${formatAusDate(model.generated_at_iso.slice(0, 10))}`
      ].filter(Boolean);
      const pageLabel = `Page ${pageNumber} of ${pageCount}`;
      doc.save();
      doc.strokeColor('#e2e8f0').lineWidth(0.5);
      doc.moveTo(margins.left, footerY - 10).lineTo(pageWidth - margins.right, footerY - 10).stroke();
      doc.fillColor('#64748b').font(font).fontSize(7.5);
      doc.text(parts.join(' | '), margins.left, footerY, {
        width: contentWidth * 0.72,
        align: 'left',
        lineBreak: false,
        ellipsis: true,
        height: 12
      });
      doc.text(pageLabel, margins.left + contentWidth * 0.72, footerY, {
        width: contentWidth * 0.28,
        align: 'right',
        lineBreak: false,
        height: 12
      });
      doc.restore();
    };

    drawHeader();

    for (const section of model.sections) {
      const title = interpolateTemplate(section.title, model.variables);
      const body = htmlToText(interpolateTemplate(section.body_html, model.variables));
      ensureSpace(52);
      if (section.locked) {
        doc.save();
        doc.rect(margins.left - 6, y - 6, contentWidth + 12, Math.min(120, doc.page.height - footerReserve - y)).fill('#f8fafc');
        doc.restore();
      }
      doc.save();
      doc.rect(margins.left, y, contentWidth, 24).fill(section.locked ? '#475569' : primary);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11);
      doc.text(`${section.locked ? 'Locked: ' : ''}${title}`, margins.left + 12, y + 6, { width: contentWidth - 24, lineBreak: false });
      doc.restore();
      y += 34;

      const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
      for (const paragraph of paragraphs) {
        doc.font(font).fontSize(baseSize).fillColor('#1f2937');
        const height = doc.heightOfString(paragraph, { width: contentWidth, lineGap: 2 });
        ensureSpace(height + 12);
        doc.text(paragraph, margins.left, y, { width: contentWidth, lineGap: 2, align: 'left' });
        y += height + 10;
      }
      y += 6;
    }

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(range.start + i);
      drawFooter(i + 1, range.count);
    }

    doc.end();
  });
}
