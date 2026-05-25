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

    const rowLine = (label, value) => {
      const line = `${label}: ${value || '—'}`;
      bodyPara(line, { size: 9 });
    };

    /* Section 1 */
    sectionBar(snapshot.section_titles?.s1 || 'Section 1 — Parties to this Agreement');
    const pl = snapshot.parties_labels || {};
    bodyPara(`${pl.service_provider || 'Service Provider'}`, { size: 10 });
    rowLine('Organisation', snapshot.org?.legal_name);
    rowLine('ABN', snapshot.org?.abn);
    rowLine('Address', snapshot.org?.address);
    rowLine('Email', snapshot.org?.email);
    rowLine('Contact', snapshot.org?.contact_person);
    rowLine('Phone', snapshot.org?.phone);

    y += 4;
    bodyPara(`${pl.client_details || 'Client Details'}`, { size: 10 });
    const p = snapshot.participant || {};
    rowLine('First name', p.first_name);
    rowLine('Last name', p.last_name);
    rowLine('Phone', p.phone);
    rowLine('Mobile', p.mobile);
    rowLine('Email', p.email);
    rowLine('Date of birth', p.date_of_birth_display);
    rowLine('NDIS number', p.ndis_number);
    rowLine('Street address', p.street_address);
    rowLine('Suburb', p.suburb);
    rowLine('State', p.state);
    rowLine('Postal code', p.postcode);
    rowLine('Plan start date', p.plan_start);
    rowLine('Plan expiry date', p.plan_expiry);

    const rep = snapshot.representative;
    if (rep && (rep.name || rep.first_name || rep.last_name || rep.phone || rep.email)) {
      y += 4;
      bodyPara(`${pl.representative || 'Representative / Advocate'}`, { size: 10 });
      rowLine('First name', rep.first_name);
      rowLine('Last name', rep.last_name);
      rowLine('Phone', rep.phone);
      rowLine('Mobile', rep.mobile);
      rowLine('Email', rep.email);
      rowLine('Relationship to client', rep.relationship);
    }

    y += 4;
    bodyPara(`${pl.invoicing_funding || 'Invoicing / Funding Management'}`, { size: 10 });
    const invOrg = snapshot.org?.trading_name || snapshot.org?.legal_name || 'The provider';
    bodyPara(`${invOrg} will invoice:`, { size: 9 });
    rowLine('Arrangement', snapshot.funding?.label);

    const fm = snapshot.funding?.plan_manager;
    if (snapshot.funding?.show_plan_manager && fm) {
      y += 4;
      bodyPara(`${pl.plan_manager || 'Plan Manager Details'}`, { size: 10 });
      rowLine('Organisation', fm.name);
      rowLine('ABN', fm.abn);
      rowLine('Email', fm.email);
      rowLine('Phone', fm.phone);
      rowLine('Address', fm.address);
    }

    /* Section 2 */
    sectionBar(snapshot.section_titles?.s2 || 'Section 2 — Key Details');
    const s2 = snapshot.section2 || {};
    rowLine('Date of Agreement', s2.agreement_date);
    rowLine('Scheduled Review Date', s2.scheduled_review_date);
    rowLine('Monitoring of Worker Frequency', s2.monitoring_worker_frequency);
    rowLine('Other Provider Consultation Frequency', s2.other_provider_consultation_frequency);
    rowLine('Communication Preferences', s2.communication_preferences);

    y += 6;
    bodyPara('Services and Supports Schedule', { size: 10 });
    const rows = snapshot.schedule_rows || [];
    if (rows.length === 0) {
      bodyPara('No schedule rows were loaded from implementations or intake; add allocations or intake schedule rows and regenerate.', {
        size: 8
      });
    } else {
      const tableTop = y;
      doc.fontSize(8).font('Helvetica-Bold');
      doc.fillColor('#0f172a');
      const col = [margin, margin + 155, margin + 230, margin + 330, margin + 410];
      doc.text('Support / Service', col[0], tableTop, { width: 145 });
      doc.text('Price', col[1], tableTop, { width: 68 });
      doc.text('Appointment times', col[2], tableTop, { width: 92 });
      doc.text('Duration', col[3], tableTop, { width: 72 });
      doc.text('Total', col[4], tableTop, { width: pageWidth - col[4] - margin });
      y = tableTop + 14;
      doc.font(font).fontSize(8);
      rows.forEach((r) => {
        const desc = r.description || '';
        const h = Math.max(
          14,
          doc.heightOfString(desc, { width: 145 }),
          doc.heightOfString(r.appointment_times || '', { width: 92 })
        );
        y = ensureSpace(doc, y, h + 4, margin, pageMaxY());
        doc.text(desc, col[0], y, { width: 145 });
        doc.text(r.price || r.rate || '', col[1], y, { width: 68 });
        doc.text(r.appointment_times || '', col[2], y, { width: 92 });
        doc.text(r.duration || r.hours || '', col[3], y, { width: 72 });
        doc.text(r.budget || r.line_total_display || '', col[4], y, { width: pageWidth - col[4] - margin });
        y += h + 4;
      });
      y += 4;
      doc.font('Helvetica-Bold').text(`Total (estimated): $${Number(snapshot.schedule_total || 0).toFixed(2)}`, margin, y);
      y += 16;
    }

    /* Section 3 Checklist */
    sectionBar(snapshot.section_titles?.s3 || 'Section 3 — Agreement Checklist');
    doc.font(font).fontSize(8);
    const chkTop = y;
    doc.font('Helvetica-Bold');
    doc.text('Confirmation', margin, chkTop, { width: 280 });
    doc.text('Yes', margin + 290, chkTop, { width: 28 });
    doc.text('No', margin + 318, chkTop, { width: 28 });
    doc.text('N/A', margin + 346, chkTop, { width: 28 });
    doc.text('Notes', margin + 380, chkTop, { width: pageWidth - margin - 380 });
    y = chkTop + 12;
    doc.font(font);
    (snapshot.checklist || []).forEach((item) => {
      const txt = item.text || '';
      const h = Math.max(22, doc.heightOfString(txt, { width: 270 }));
      y = ensureSpace(doc, y, h + 6, margin, pageMaxY());
      doc.rect(margin + 288, y, 14, 12).stroke('#94a3b8');
      doc.rect(margin + 316, y, 14, 12).stroke('#94a3b8');
      doc.rect(margin + 344, y, 14, 12).stroke('#94a3b8');
      doc.rect(margin + 378, y, pageWidth - margin - 378, h).stroke('#e2e8f0');
      doc.text(txt, margin, y + 2, { width: 270 });
      y += h + 6;
    });

    /* Section 4 Terms */
    sectionBar(snapshot.section_titles?.s4 || 'Section 4 — Terms of Agreement');
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

    /* Signatures */
    y += 8;
    sectionBar('Execution — Signatures');
    bodyPara(
      'Sign below to execute this Agreement. Pre-signature PDF for manual distribution; digital signing may be added later.',
      { size: 8 }
    );

    const sigBox = (label, x, width) => {
      const boxY = y;
      doc.font('Helvetica-Bold').fontSize(9).text(label, x, boxY);
      doc.rect(x, boxY + 14, width, 56).stroke('#64748b');
      doc.font(font).fontSize(8).fillColor('#64748b');
      doc.text('Signature', x + 4, boxY + 18);
      doc.text('Printed name', x + 4, boxY + 34);
      doc.text('Date', x + 4, boxY + 50);
    };

    y += 4;
    const colW = (pageWidth - 2 * margin - 16) / (snapshot.representative?.name ? 3 : 2);
    sigBox('Provider (for and on behalf of the organisation)', margin, colW);
    sigBox('Client', margin + colW + 8, colW);
    if (snapshot.representative?.name) {
      sigBox('Representative', margin + 2 * (colW + 8), colW);
    }
    y += 88;

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
