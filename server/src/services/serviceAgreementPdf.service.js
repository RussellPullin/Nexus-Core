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
      const fy = doc.page.height - 42;
      doc.fontSize(7).fillColor('#475569').font(font);
      // CRITICAL: lineBreak:false + a small explicit height stops pdfkit from
      // auto-paginating when the footer text is long. Without this, a long org
      // address overflows the footer line and creates an empty trailing page,
      // and the loop in bufferedPageRange then cascades the bug for every page.
      doc.text(bits, margin, fy, {
        width: pageWidth - 2 * margin,
        align: 'center',
        lineBreak: false,
        height: 10,
        ellipsis: true
      });
      if (ctrl) {
        doc.text(ctrl, margin, fy + 10, {
          width: pageWidth - 2 * margin,
          align: 'center',
          lineBreak: false,
          height: 10,
          ellipsis: true
        });
      }
    };

    /* Header band */
    doc.save();
    doc.rect(0, 0, pageWidth, 56).fill(`rgb(${primary.r},${primary.g},${primary.b})`);
    doc.fillColor('#ffffff').fontSize(16).font('Helvetica-Bold');
    const title = snapshot.definition_meta?.documentTitle || 'Services Agreement';
    doc.text(title, margin, 18, { width: pageWidth - 2 * margin, align: 'center' });
    const ver = snapshot.definition_meta?.versionLabel || '';
    if (ver) {
      doc.fontSize(9).text(ver, margin, 38, { width: pageWidth - 2 * margin, align: 'center' });
    }

    const logoPath = resolveLogoFullPath(branding, snapshot.org);
    if (logoPath) {
      try {
        doc.image(logoPath, margin, 8, { height: 40 });
      } catch {
        /* skip corrupt logo */
      }
    } else {
      doc.strokeColor('#cbd5e1').lineWidth(0.75);
      doc.rect(margin, 8, 88, 40).stroke();
      doc.fillColor('#94a3b8').fontSize(7).text('Logo', margin + 4, 26, { width: 80, align: 'center' });
    }
    doc.restore();

    y = 68;
    const orgSubtitle = [snapshot.org?.trading_name, snapshot.org?.legal_name].filter(Boolean).join(' · ');
    if (orgSubtitle) {
      doc.fillColor('#475569').font(font).fontSize(9);
      doc.text(orgSubtitle, margin, y, { width: pageWidth - 2 * margin, align: 'center' });
      y += 16;
    }

    const sectionBar = (label) => {
      y = ensureSpace(doc, y, 36, margin, pageMaxY());
      doc.save();
      doc.rect(margin, y, pageWidth - 2 * margin, 22).fill(`rgb(${accent.r},${accent.g},${accent.b})`);
      doc.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold').text(label, margin + 8, y + 5, {
        width: pageWidth - 2 * margin - 16
      });
      doc.restore();
      y += 30;
    };

    const bodyPara = (text, opts = {}) => {
      const size = opts.size || 9;
      doc.fillColor('#0f172a').font(font).fontSize(size);
      const h = doc.heightOfString(text, { width: pageWidth - 2 * margin });
      y = ensureSpace(doc, y, h + 8, margin, pageMaxY());
      doc.text(text, margin, y, { width: pageWidth - 2 * margin, align: 'left' });
      y += h + 8;
    };

    const subHeading = (text) => {
      y = ensureSpace(doc, y, 22, margin, pageMaxY());
      doc.font('Helvetica-Bold').fontSize(10).fillColor(`rgb(${primary.r},${primary.g},${primary.b})`).text(
        text,
        margin,
        y,
        { width: pageWidth - 2 * margin, lineBreak: false, height: 14 }
      );
      // accent underline tying the heading visually to the section bar
      doc.save();
      doc.rect(margin, y + 13, 36, 1.5).fill(`rgb(${accent.r},${accent.g},${accent.b})`);
      doc.restore();
      y += 18;
    };

    // Render label/value pairs in a multi-column grid. Default 2 columns.
    // Skips pairs with no value so we don't pad the form with '—' rows.
    const kvGrid = (pairs, opts = {}) => {
      const cols = opts.cols || 2;
      const gutter = 14;
      const cellW = (pageWidth - 2 * margin - gutter * (cols - 1)) / cols;
      const labelH = 10;
      const valuePadAbove = 1;
      const bottomPad = opts.bottomPad ?? 6;
      const visible = pairs.filter((p) => {
        if (opts.includeEmpty) return true;
        return String(p?.value ?? '').trim() !== '';
      });
      doc.font(font).fontSize(9);
      for (let i = 0; i < visible.length; i += cols) {
        const rowPairs = visible.slice(i, i + cols);
        let maxValueH = 11;
        rowPairs.forEach((p) => {
          const vh = doc.heightOfString(String(p.value || '—'), { width: cellW });
          maxValueH = Math.max(maxValueH, vh);
        });
        const rowH = labelH + valuePadAbove + maxValueH + bottomPad;
        y = ensureSpace(doc, y, rowH, margin, pageMaxY());
        rowPairs.forEach((p, j) => {
          const x = margin + j * (cellW + gutter);
          doc.font('Helvetica-Bold').fontSize(7).fillColor('#64748b')
            .text(String(p.label || '').toUpperCase(), x, y, {
              width: cellW,
              lineBreak: false,
              characterSpacing: 0.4,
              height: labelH
            });
          doc.font(font).fontSize(9).fillColor('#0f172a').text(
            String(p.value || '—'),
            x,
            y + labelH + valuePadAbove,
            { width: cellW }
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

    y += 6;
    subHeading('Services and Supports Schedule');
    const rows = snapshot.schedule_rows || [];
    if (rows.length === 0) {
      bodyPara('No services were entered for this agreement; complete the Services & quote section in Nexus and regenerate.', {
        size: 8
      });
    } else {
      const tableTop = y;
      const col = [margin, margin + 280, margin + 360, margin + 440];
      // Branded header band using the org accent colour
      doc.save();
      doc.rect(margin, tableTop - 2, pageWidth - 2 * margin, 16)
        .fill(`rgb(${accent.r},${accent.g},${accent.b})`);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
      doc.text('SUPPORT / SERVICE', col[0] + 4, tableTop + 2, { width: 268, characterSpacing: 0.4 });
      doc.text('HOURS', col[1] + 4, tableTop + 2, { width: 72, characterSpacing: 0.4, align: 'right' });
      doc.text('RATE ($/HR)', col[2] + 4, tableTop + 2, { width: 72, characterSpacing: 0.4, align: 'right' });
      doc.text('LINE TOTAL', col[3] + 4, tableTop + 2, { width: pageWidth - col[3] - margin - 4, characterSpacing: 0.4, align: 'right' });
      doc.restore();
      y = tableTop + 18;
      doc.font(font).fontSize(9).fillColor('#0f172a');
      rows.forEach((r, idx) => {
        const desc = r.description || '';
        const h = Math.max(14, doc.heightOfString(desc, { width: 268 }));
        y = ensureSpace(doc, y, h + 6, margin, pageMaxY());
        // zebra striping for legibility
        if (idx % 2 === 1) {
          doc.save();
          doc.rect(margin, y - 2, pageWidth - 2 * margin, h + 6).fill('#f8fafc');
          doc.restore();
          doc.fillColor('#0f172a');
        }
        doc.text(desc, col[0] + 4, y, { width: 268 });
        doc.text(r.hours || r.duration || '', col[1] + 4, y, { width: 72, align: 'right' });
        doc.text(r.rate || r.price || '', col[2] + 4, y, { width: 72, align: 'right' });
        doc.text(r.budget || r.line_total_display || '', col[3] + 4, y, {
          width: pageWidth - col[3] - margin - 4,
          align: 'right'
        });
        y += h + 6;
      });
      // Total row in primary colour
      y = ensureSpace(doc, y, 22, margin, pageMaxY());
      doc.save();
      doc.rect(margin, y, pageWidth - 2 * margin, 18)
        .fill(`rgb(${primary.r},${primary.g},${primary.b})`);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10);
      doc.text('Total quote for the plan', margin + 4, y + 4, { width: 360 });
      doc.text(`$${Number(snapshot.schedule_total || 0).toFixed(2)}`, margin + 360, y + 4, {
        width: pageWidth - 2 * margin - 364,
        align: 'right'
      });
      doc.restore();
      y += 24;
    }

    /* Section 3 — Terms of Agreement (was Section 4; the in-PDF checklist is intentionally
       not printed on the signed copy. Admin verifies its items in Nexus before sending.) */
    sectionBar('Section 3 — Terms of Agreement');
    (snapshot.clauses_rendered || []).forEach((c) => {
      const heading = `Clause ${c.number}: ${c.title}`;
      y = ensureSpace(doc, y, 22, margin, pageMaxY());
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(10).text(heading, margin, y, {
        width: pageWidth - 2 * margin
      });
      y += 14;
      const body = c.body_rendered || '';
      doc.font(font).fontSize(9).fillColor('#1e293b');
      const bh = doc.heightOfString(body, { width: pageWidth - 2 * margin });
      y = ensureSpace(doc, y, bh + 12, margin, pageMaxY());
      doc.text(body, margin, y, { width: pageWidth - 2 * margin, align: 'justify' });
      y += bh + 12;
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
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f172a').text(label, x, boxY);

      const innerY = boxY + 14;
      const sigInputH = 32;
      const lineH = 16;
      const lblH = 10;
      const gap = 6;
      const innerH = sigInputH + lineH + lineH + lblH * 3 + gap * 3 + 6;

      doc.rect(x, innerY, width, innerH).stroke('#64748b');

      let cy = innerY + 4;
      doc.font(font).fontSize(7).fillColor('#64748b').text('Signature', x + 4, cy);
      cy += lblH;
      const sigField = { x: x + 4, y: cy, width: width - 8, height: sigInputH };
      doc.rect(sigField.x, sigField.y, sigField.width, sigField.height).stroke('#e2e8f0');
      cy += sigInputH + gap;

      doc.font(font).fontSize(7).fillColor('#64748b').text('Printed name', x + 4, cy);
      cy += lblH;
      const nameField = { x: x + 4, y: cy, width: width - 8, height: lineH };
      doc.moveTo(nameField.x, nameField.y + nameField.height)
        .lineTo(nameField.x + nameField.width, nameField.y + nameField.height)
        .stroke('#94a3b8');
      cy += lineH + gap;

      doc.font(font).fontSize(7).fillColor('#64748b').text('Date', x + 4, cy);
      cy += lblH;
      const dateField = { x: x + 4, y: cy, width: width - 8, height: lineH };
      doc.moveTo(dateField.x, dateField.y + dateField.height)
        .lineTo(dateField.x + dateField.width, dateField.y + dateField.height)
        .stroke('#94a3b8');

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
