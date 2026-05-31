/**
 * Renders Service Agreement PDF from an immutable snapshot (pdfkit).
 */
import PDFDocument from 'pdfkit';
import { existsSync } from 'fs';
import { join, resolve, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const dataUploadsDir = process.env.DATA_DIR
  ? join(process.env.DATA_DIR, 'uploads')
  : join(projectRoot, 'data', 'uploads');

function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '').trim();
  if (h.length !== 6) return { r: 30, g: 58, b: 95 };
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  };
}

function resolveLogoFullPath(branding, org) {
  // Phase 1: prefer the org-level logo uploaded via the setup wizard (absolute path).
  if (org?.logo_path) {
    const raw = String(org.logo_path).trim();
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
  // Legacy: Settings → Business stored a relative filename in business_settings.logo_path
  // and copied that into snapshot.org.business_logo_filename.
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
  // Template branding fallback.
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

function pickColor(orgValue, brandingValue, fallbackHex) {
  const isValid = (v) => typeof v === 'string' && /^#?[0-9a-fA-F]{6}$/.test(v.trim());
  if (isValid(orgValue)) return orgValue.trim();
  if (isValid(brandingValue)) return brandingValue.trim();
  return fallbackHex;
}

function footerText(snapshot) {
  const o = snapshot.org || {};
  const meta = snapshot.metadata || {};
  const bits = [
    [o.trading_name, o.legal_name].filter(Boolean).join(' | '),
    o.abn ? `ABN ${o.abn}` : '',
    o.address || '',
    o.email || ''
  ]
    .filter(Boolean)
    .join(' · ');
  const ctrl = [
    meta.date_approved ? `Approved: ${meta.date_approved}` : '',
    meta.review_date ? `Review: ${meta.review_date}` : '',
    meta.next_review_date ? `Next review: ${meta.next_review_date}` : ''
  ]
    .filter(Boolean)
    .join(' · ');
  return { bits, ctrl };
}

function ensureSpace(doc, y, needed, margin, pageMaxY) {
  if (y + needed > pageMaxY) {
    doc.addPage();
    return margin + 20;
  }
  return y;
}

/**
 * @param {object} snapshot - from buildServiceAgreementSnapshot
 * @returns {Promise<Buffer>}
 */
export function generateServiceAgreementPdfBuffer(snapshot) {
  return new Promise((resolvePromise, reject) => {
    const branding = snapshot.branding || {};
    const orgBlock = snapshot.org || {};
    // Prefer the org-profile colours (set via the setup wizard / Settings → Org profile);
    // fall back to the template branding, then a tasteful default.
    const primaryHex = pickColor(orgBlock.primary_color, branding.primary_color, '#1e3a5f');
    const accentHex = pickColor(orgBlock.accent_color, branding.accent_color, '#2563eb');
    const primary = hexToRgb(primaryHex);
    const accent = hexToRgb(accentHex);
    const font = branding.body_font && branding.body_font !== 'Helvetica' ? 'Helvetica' : 'Helvetica';

    const doc = new PDFDocument({ margin: 48, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolvePromise(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width;
    const margin = 48;
    const footerReserve = 52;
    const pageMaxY = () => doc.page.height - footerReserve;
    let y = margin;

    const drawFooterOnCurrentPage = () => {
      const { bits, ctrl } = footerText(snapshot);
      const fy = doc.page.height - 44;

      // Subtle footer divider
      doc.save();
      doc.strokeColor('#e5e7eb').lineWidth(0.5);
      doc.moveTo(margin, fy - 8).lineTo(pageWidth - margin, fy - 8).stroke();
      doc.restore();

      // Footer text with improved readability
      doc.fontSize(7.5).fillColor('#6b7280').font(font);
      // CRITICAL: lineBreak:false + a small explicit height stops pdfkit from
      // auto-paginating when the footer text is long. Without this, a long org
      // address overflows the footer line and creates an empty trailing page,
      // and the loop in bufferedPageRange then cascades the bug for every page.
      doc.text(bits, margin, fy, {
        width: pageWidth - 2 * margin,
        align: 'center',
        lineBreak: false,
        height: 11,
        ellipsis: true
      });
      if (ctrl) {
        doc.fontSize(7).text(ctrl, margin, fy + 9, {
          width: pageWidth - 2 * margin,
          align: 'center',
          lineBreak: false,
          height: 10,
          ellipsis: true
        });
      }
    };

    /* ══════════════════════════════════════════════════════════════════
       ENHANCED HEADER — Logo centered, refined typography, better spacing
       ══════════════════════════════════════════════════════════════════ */
    doc.save();

    // Subtle background rectangle for the entire header area
    doc.rect(0, 0, pageWidth, 100).fill('#f8fafc');

    // Logo placement — centered, larger
    const logoPath = resolveLogoFullPath(branding, snapshot.org);
    const logoWidth = 70;
    const logoX = (pageWidth - logoWidth) / 2;
    const logoY = 12;

    if (logoPath) {
      try {
        doc.image(logoPath, logoX, logoY, { width: logoWidth });
      } catch {
        /* skip corrupt logo */
      }
    } else {
      // Placeholder with subtle styling
      doc.strokeColor('#cbd5e1').lineWidth(1);
      doc.rect(logoX, logoY, logoWidth, logoWidth).stroke();
      doc.fillColor('#94a3b8').fontSize(8).font('Helvetica').text('Logo', logoX, logoY + (logoWidth / 2) - 4, {
        width: logoWidth,
        align: 'center',
        height: 10
      });
    }

    // Organization name — bold and prominent
    y = logoY + logoWidth + 12;
    const orgName = snapshot.org?.trading_name || snapshot.org?.legal_name || 'Service Provider';
    doc.fillColor(`rgb(${primary.r},${primary.g},${primary.b})`).fontSize(18).font('Helvetica-Bold');
    doc.text(orgName, margin, y, { width: pageWidth - 2 * margin, align: 'center' });
    y += 20;

    // Document title
    const title = snapshot.definition_meta?.documentTitle || 'Service Agreement';
    doc.fillColor('#1f2937').fontSize(12).font('Helvetica');
    doc.text(title, margin, y, { width: pageWidth - 2 * margin, align: 'center' });
    y += 8;

    // Version label if present
    const ver = snapshot.definition_meta?.versionLabel || '';
    if (ver) {
      doc.fontSize(8).fillColor('#6b7280').font('Helvetica');
      doc.text(ver, margin, y, { width: pageWidth - 2 * margin, align: 'center' });
    }

    doc.restore();

    // Professional divider after header
    doc.strokeColor(`rgb(${accent.r},${accent.g},${accent.b})`).lineWidth(2);
    doc.moveTo(margin, 104).lineTo(pageWidth - margin, 104).stroke();

    y = 115;

    const sectionBar = (label) => {
      y = ensureSpace(doc, y, 36, margin, pageMaxY());
      doc.save();
      // Enhanced section header with shadow effect
      doc.rect(margin, y, pageWidth - 2 * margin, 24).fill(`rgb(${primary.r},${primary.g},${primary.b})`);
      doc.fillColor('#ffffff').fontSize(12).font('Helvetica-Bold');
      doc.text(label, margin + 12, y + 6, {
        width: pageWidth - 2 * margin - 24,
        lineBreak: false
      });
      doc.restore();
      y += 32;
    };

    const bodyPara = (text, opts = {}) => {
      const size = opts.size || 9;
      doc.fillColor('#374151').font(font).fontSize(size);
      const h = doc.heightOfString(text, { width: pageWidth - 2 * margin });
      y = ensureSpace(doc, y, h + 10, margin, pageMaxY());
      doc.text(text, margin, y, { width: pageWidth - 2 * margin, align: 'left', lineGap: 2 });
      y += h + 10;
    };

    const subHeading = (text) => {
      y = ensureSpace(doc, y, 24, margin, pageMaxY());
      doc.font('Helvetica-Bold').fontSize(10).fillColor(`rgb(${primary.r},${primary.g},${primary.b})`).text(
        text,
        margin,
        y,
        { width: pageWidth - 2 * margin, lineBreak: false, height: 15 }
      );
      // Professional underline using accent color
      doc.save();
      doc.strokeColor(`rgb(${accent.r},${accent.g},${accent.b})`).lineWidth(2);
      doc.moveTo(margin, y + 14).lineTo(margin + 40, y + 14).stroke();
      doc.restore();
      y += 20;
    };

    // Render label/value pairs in a multi-column grid. Default 2 columns.
    // Skips pairs with no value so we don't pad the form with '—' rows.
    const kvGrid = (pairs, opts = {}) => {
      const cols = opts.cols || 2;
      const gutter = 16;
      const cellW = (pageWidth - 2 * margin - gutter * (cols - 1)) / cols;
      const labelH = 11;
      const valuePadAbove = 2;
      const bottomPad = opts.bottomPad ?? 10;
      const visible = pairs.filter((p) => {
        if (opts.includeEmpty) return true;
        return String(p?.value ?? '').trim() !== '';
      });
      doc.font(font).fontSize(9);
      for (let i = 0; i < visible.length; i += cols) {
        const rowPairs = visible.slice(i, i + cols);
        let maxValueH = 12;
        rowPairs.forEach((p) => {
          const vh = doc.heightOfString(String(p.value || '—'), { width: cellW });
          maxValueH = Math.max(maxValueH, vh);
        });
        const rowH = labelH + valuePadAbove + maxValueH + bottomPad;
        y = ensureSpace(doc, y, rowH, margin, pageMaxY());
        rowPairs.forEach((p, j) => {
          const x = margin + j * (cellW + gutter);
          // Label — bold, uppercase, professional gray
          doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#6b7280')
            .text(String(p.label || '').toUpperCase(), x, y, {
              width: cellW,
              lineBreak: false,
              characterSpacing: 0.5,
              height: labelH
            });
          // Value — dark text, better readability
          doc.font(font).fontSize(9.5).fillColor('#1f2937').text(
            String(p.value || '—'),
            x,
            y + labelH + valuePadAbove,
            { width: cellW, lineGap: 1 }
          );
        });
        y += rowH;
      }
    };

    // Section numbers are renderer-controlled and contiguous so the printed PDF goes
    // 1 → 2 → 3 → Execution. We intentionally ignore snapshot.section_titles for the
    // section *numbers* (the legacy template stored a "Section 4 — …" title for terms,
    // and we removed the old Section 3 checklist from the participant copy).
    /* Section 1 — Parties */
    sectionBar('Section 1 — Parties to this Agreement');
    const pl = snapshot.parties_labels || {};

    subHeading(pl.service_provider || 'Service Provider');
    kvGrid([
      { label: 'Organisation', value: snapshot.org?.legal_name },
      { label: 'ABN', value: snapshot.org?.abn },
      { label: 'Address', value: snapshot.org?.address },
      { label: 'Email', value: snapshot.org?.email },
      { label: 'Contact', value: snapshot.org?.contact_person },
      { label: 'Phone', value: snapshot.org?.phone }
    ]);

    y += 4;
    subHeading(pl.client_details || 'Client Details');
    const p = snapshot.participant || {};
    kvGrid([
      { label: 'First name', value: p.first_name },
      { label: 'Last name', value: p.last_name },
      { label: 'Phone', value: p.phone },
      { label: 'Mobile', value: p.mobile },
      { label: 'Email', value: p.email },
      { label: 'Date of birth', value: p.date_of_birth_display },
      { label: 'NDIS number', value: p.ndis_number },
      { label: 'Street address', value: p.street_address },
      { label: 'Suburb', value: p.suburb },
      { label: 'State', value: p.state },
      { label: 'Postal code', value: p.postcode },
      { label: 'Plan start', value: p.plan_start },
      { label: 'Plan expiry', value: p.plan_expiry }
    ]);

    const rep = snapshot.representative;
    if (rep && (rep.name || rep.first_name || rep.last_name || rep.phone || rep.email)) {
      y += 4;
      subHeading(pl.representative || 'Representative / Advocate');
      kvGrid([
        { label: 'First name', value: rep.first_name },
        { label: 'Last name', value: rep.last_name },
        { label: 'Phone', value: rep.phone },
        { label: 'Mobile', value: rep.mobile },
        { label: 'Email', value: rep.email },
        { label: 'Relationship to client', value: rep.relationship }
      ]);
    }

    y += 4;
    subHeading(pl.invoicing_funding || 'Invoicing / Funding Management');
    const invOrg = snapshot.org?.trading_name || snapshot.org?.legal_name || 'The provider';
    bodyPara(`${invOrg} will invoice as follows:`, { size: 9 });
    kvGrid([{ label: 'Arrangement', value: snapshot.funding?.label }], { cols: 1 });

    const fm = snapshot.funding?.plan_manager;
    if (snapshot.funding?.show_plan_manager && fm) {
      y += 4;
      subHeading(pl.plan_manager || 'Plan Manager Details');
      kvGrid([
        { label: 'Organisation', value: fm.name },
        { label: 'ABN', value: fm.abn },
        { label: 'Email', value: fm.email },
        { label: 'Phone', value: fm.phone },
        { label: 'Address', value: fm.address }
      ]);
    }

    /* Section 2 — Key Details */
    sectionBar('Section 2 — Key Details');
    const s2 = snapshot.section2 || {};
    kvGrid([
      { label: 'Date of Agreement', value: s2.agreement_date },
      { label: 'Scheduled Review Date', value: s2.scheduled_review_date },
      { label: 'Monitoring of Worker Frequency', value: s2.monitoring_worker_frequency },
      { label: 'Other Provider Consultation Frequency', value: s2.other_provider_consultation_frequency },
      { label: 'Communication Preferences', value: s2.communication_preferences }
    ]);

    y += 8;
    subHeading('Services and Supports Schedule');
    const rows = snapshot.schedule_rows || [];
    if (rows.length === 0) {
      bodyPara('No services were entered for this agreement; complete the Services & quote section in Nexus and regenerate.', {
        size: 8
      });
    } else {
      const tableTop = y;
      const col = [margin, margin + 280, margin + 360, margin + 440];

      // ━━━ Enhanced table header with primary color background ━━━
      doc.save();
      doc.rect(margin, tableTop - 2, pageWidth - 2 * margin, 18)
        .fill(`rgb(${primary.r},${primary.g},${primary.b})`);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
      doc.text('SUPPORT / SERVICE', col[0] + 6, tableTop + 3, { width: 268, characterSpacing: 0.3 });
      doc.text('HOURS', col[1] + 4, tableTop + 3, { width: 72, characterSpacing: 0.3, align: 'right' });
      doc.text('RATE ($/HR)', col[2] + 4, tableTop + 3, { width: 72, characterSpacing: 0.3, align: 'right' });
      doc.text('LINE TOTAL', col[3] + 4, tableTop + 3, { width: pageWidth - col[3] - margin - 6, characterSpacing: 0.3, align: 'right' });
      doc.restore();

      y = tableTop + 20;
      doc.font(font).fontSize(9).fillColor('#1f2937');

      rows.forEach((r, idx) => {
        const desc = r.description || '';
        const h = Math.max(16, doc.heightOfString(desc, { width: 268 }));
        y = ensureSpace(doc, y, h + 8, margin, pageMaxY());

        // Enhanced zebra striping with subtle color
        if (idx % 2 === 0) {
          doc.save();
          doc.fillColor('#f9fafb');
          doc.rect(margin, y - 2, pageWidth - 2 * margin, h + 8).fill();
          doc.restore();
        } else {
          doc.save();
          doc.fillColor('#ffffff');
          doc.rect(margin, y - 2, pageWidth - 2 * margin, h + 8).fill();
          doc.restore();
        }

        // Row divider
        doc.save();
        doc.strokeColor('#e5e7eb').lineWidth(0.5);
        doc.moveTo(margin, y + h + 6).lineTo(pageWidth - margin, y + h + 6).stroke();
        doc.restore();

        doc.fillColor('#1f2937');
        doc.text(desc, col[0] + 6, y + 3, { width: 268 });
        doc.fontSize(9).text(r.hours || r.duration || '', col[1] + 4, y + 3, { width: 72, align: 'right' });
        doc.text(r.rate || r.price || '', col[2] + 4, y + 3, { width: 72, align: 'right' });
        doc.text(r.budget || r.line_total_display || '', col[3] + 4, y + 3, {
          width: pageWidth - col[3] - margin - 6,
          align: 'right'
        });
        y += h + 8;
      });

      // ━━━ Enhanced total row with strong visual hierarchy ━━━
      y = ensureSpace(doc, y, 24, margin, pageMaxY());
      doc.save();
      doc.rect(margin, y, pageWidth - 2 * margin, 20)
        .fill(`rgb(${primary.r},${primary.g},${primary.b})`);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11);
      doc.text('Total Quote for the Plan', margin + 8, y + 4, { width: 350 });
      doc.text(`$${Number(snapshot.schedule_total || 0).toFixed(2)}`, margin + 360, y + 4, {
        width: pageWidth - 2 * margin - 364,
        align: 'right'
      });
      doc.restore();
      y += 28;
    }

    /* Section 3 — Terms of Agreement (was Section 4; the in-PDF checklist is intentionally
       not printed on the signed copy. Admin verifies its items in Nexus before sending.) */
    sectionBar('Section 3 — Terms of Agreement');
    (snapshot.clauses_rendered || []).forEach((c, idx) => {
      const heading = `Clause ${c.number}: ${c.title}`;
      y = ensureSpace(doc, y, 24, margin, pageMaxY());

      // Subtle background for clause group
      if (idx % 2 === 0) {
        doc.save();
        doc.fillColor('#f9fafb');
        doc.rect(margin - 4, y - 2, pageWidth - 2 * margin + 8, 18).fill();
        doc.restore();
      }

      // Clause heading with better styling
      doc.fillColor(`rgb(${primary.r},${primary.g},${primary.b})`).font('Helvetica-Bold').fontSize(10).text(heading, margin, y, {
        width: pageWidth - 2 * margin,
        lineBreak: false
      });
      y += 16;

      const body = c.body_rendered || '';
      doc.font(font).fontSize(9).fillColor('#374151');
      const bh = doc.heightOfString(body, { width: pageWidth - 2 * margin });
      y = ensureSpace(doc, y, bh + 14, margin, pageMaxY());
      doc.text(body, margin, y, { width: pageWidth - 2 * margin, align: 'justify', lineGap: 1.5 });
      y += bh + 14;
    });

    /* Execution — Signatures. All details are finalised in Nexus Core before sending,
       so the signed PDF only has two interactive signature blocks (Provider + Client). */
    y = ensureSpace(doc, y, 200, margin, pageMaxY());
    y += 10;
    sectionBar('Execution — Signatures');
    bodyPara(
      'The agreement details above were reviewed in Nexus Core. The organisation admin signs the Provider box first; once signed, the participant receives the request to sign the Client box.',
      { size: 8 }
    );

    const confirmBoxes = []; // intentionally empty — kept so signing_layout shape stays stable

    const sigBox = (label, x, width) => {
      const boxY = y;
      // Label with accent color for visual hierarchy
      doc.font('Helvetica-Bold').fontSize(10).fillColor(`rgb(${primary.r},${primary.g},${primary.b})`).text(label, x, boxY);

      const innerY = boxY + 16;
      const sigInputH = 40;  // Larger signature area
      const lineH = 18;
      const lblH = 11;
      const gap = 8;
      const padding = 12;
      const innerH = sigInputH + lineH + lineH + lblH * 3 + gap * 3 + padding;

      // Professional box with subtle border
      doc.save();
      doc.strokeColor('#d1d5db').lineWidth(1.5);
      doc.rect(x, innerY, width, innerH).stroke();
      // Subtle background fill
      doc.fillColor('#fafbfc').rect(x, innerY, width, innerH).fill();
      doc.restore();

      let cy = innerY + padding;

      // Signature field label
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#374151').text('Signature', x + padding, cy);
      cy += lblH;
      const sigField = { x: x + padding, y: cy, width: width - 2 * padding, height: sigInputH };
      doc.strokeColor('#9ca3af').lineWidth(1);
      doc.rect(sigField.x, sigField.y, sigField.width, sigField.height).stroke();
      // Light background in signature area
      doc.fillColor('#f3f4f6').rect(sigField.x, sigField.y, sigField.width, sigField.height).fill();
      cy += sigInputH + gap;

      // Printed name field label
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#374151').text('Printed Name', x + padding, cy);
      cy += lblH;
      const nameField = { x: x + padding, y: cy, width: width - 2 * padding, height: lineH };
      doc.strokeColor('#d1d5db').lineWidth(0.8);
      doc.moveTo(nameField.x, nameField.y + nameField.height)
        .lineTo(nameField.x + nameField.width, nameField.y + nameField.height)
        .stroke();
      cy += lineH + gap;

      // Date field label
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#374151').text('Date', x + padding, cy);
      cy += lblH;
      const dateField = { x: x + padding, y: cy, width: width - 2 * padding, height: lineH };
      doc.strokeColor('#d1d5db').lineWidth(0.8);
      doc.moveTo(dateField.x, dateField.y + dateField.height)
        .lineTo(dateField.x + dateField.width, dateField.y + dateField.height)
        .stroke();

      return { boxY, x, width, innerH, signature: sigField, printedName: nameField, date: dateField };
    };

    y += 4;
    const colW = (pageWidth - 2 * margin - 16) / (snapshot.representative?.name ? 3 : 2);
    const providerBox = sigBox('Provider (organisation admin)', margin, colW);
    const clientBox = sigBox('Client (participant)', margin + colW + 8, colW);
    if (snapshot.representative?.name) {
      sigBox('Representative', margin + 2 * (colW + 8), colW);
    }

    const signingPage = doc.bufferedPageRange().count;
    snapshot.signing_layout = {
      page: signingPage,
      confirm_fields: confirmBoxes,
      provider: {
        signature: { page: signingPage, ...providerBox.signature },
        printed_name: { page: signingPage, ...providerBox.printedName },
        date: { page: signingPage, ...providerBox.date }
      },
      client: {
        signature: { page: signingPage, ...clientBox.signature },
        printed_name: { page: signingPage, ...clientBox.printedName },
        date: { page: signingPage, ...clientBox.date }
      }
    };

    y += 14 + clientBox.innerH + 12;

    // Snapshot the page range BEFORE drawing footers — lineBreak:false above stops
    // text() from auto-paginating, so this fixed bound is now safe.
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      drawFooterOnCurrentPage();
    }
    doc.end();
  });
}
