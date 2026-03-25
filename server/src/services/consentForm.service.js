/**
 * Consent Form Service - fills NDIS consent Word template with participant data.
 * Uses docxtemplater for placeholder replacement ({name}, {date}, {address}, etc.)
 * and fills Word content controls (w:sdt) by tag/alias so form-field-based templates work.
 * Template path is resolved via formTemplatePath.service.js (data/forms/templates/privacy-consent/).
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { getConsentFormPath } from './formTemplatePath.service.js';

export { getConsentFormPath };

function toSafeString(value) {
  if (value == null) return '';
  if (typeof value === 'object') return Array.isArray(value) ? value.join(', ') : JSON.stringify(value);
  return String(value).trim();
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Fill Word content controls (w:sdt) in document XML by tag or alias.
 * Matches control tag/alias to data keys (alias spaces normalized to underscore).
 * Modifies the first <w:t> inside each control's <w:sdtContent> with the data value.
 * @param {string} xmlStr - word/document.xml (or header/footer) content
 * @param {Record<string, string>} data - key-value map (same as docxtemplater data)
 * @returns {string} Modified XML
 */
function fillContentControlsInXml(xmlStr, data) {
  if (!xmlStr || typeof xmlStr !== 'string') return xmlStr;
  let result = xmlStr;
  let pos = 0;
  const sdtOpen = '<w:sdt';
  const sdtClose = '</w:sdt>';

  while (true) {
    const start = result.indexOf(sdtOpen, pos);
    if (start === -1) break;

    const tagEnd = result.indexOf('>', start);
    if (tagEnd === -1) break;

    let depth = 1;
    let searchStart = tagEnd + 1;
    let end = -1;

    while (depth > 0) {
      const nextOpen = result.indexOf(sdtOpen, searchStart);
      const nextClose = result.indexOf(sdtClose, searchStart);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        searchStart = nextOpen + sdtOpen.length;
      } else {
        depth -= 1;
        if (depth === 0) {
          end = nextClose + sdtClose.length;
          break;
        }
        searchStart = nextClose + sdtClose.length;
      }
    }

    if (end === -1) {
      pos = tagEnd + 1;
      continue;
    }

    const block = result.substring(start, end);

    // Tag: <w:tag w:val="..."/> or w:val='...'. Alias: <w:alias w:val="..."/>
    const tagMatch = block.match(/<w:tag\s[^>]*\bw:val=["']([^"']*)["']/);
    const aliasMatch = block.match(/<w:alias\s[^>]*\bw:val=["']([^"']*)["']/);
    const tag = tagMatch ? tagMatch[1].trim() : null;
    const alias = aliasMatch ? aliasMatch[1].trim() : null;

    const key = tag || (alias ? alias.replace(/\s+/g, '_') : null);
    const value = key != null && key !== '' && data[key] !== undefined && data[key] !== null
      ? toSafeString(data[key])
      : null;

    if (value !== null) {
      const sdtContentStart = block.indexOf('<w:sdtContent>');
      if (sdtContentStart !== -1) {
        const afterSdtContent = block.substring(sdtContentStart);
        const tMatch = afterSdtContent.match(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/);
        if (tMatch) {
          const fullTag = tMatch[0];
          const oldInner = tMatch[1];
          const newInner = escapeXml(value);
          const newTag = fullTag.replace(oldInner, newInner);
          const newBlock = block.replace(fullTag, newTag);
          result = result.substring(0, start) + newBlock + result.substring(end);
          pos = start + newBlock.length;
          continue;
        }
      }
    }

    pos = end;
  }

  return result;
}

/**
 * Fill all document.xml and header/footer XMLs in the zip with content control values.
 * @param {PizZip} zip - Zip instance (e.g. from doc.getZip() after docxtemplater render)
 * @param {Record<string, string>} data - Same data object used for docxtemplater
 */
function fillContentControlsInZip(zip, data) {
  const docPath = 'word/document.xml';
  const docFile = zip.file(docPath);
  if (docFile) {
    const xmlStr = docFile.asText();
    zip.file(docPath, fillContentControlsInXml(xmlStr, data));
  }

  zip.file(/^word\/header\d*\.xml$/)?.forEach((f) => {
    const path = f.name;
    const xmlStr = f.asText();
    zip.file(path, fillContentControlsInXml(xmlStr, data));
  });
  zip.file(/^word\/footer\d*\.xml$/)?.forEach((f) => {
    const path = f.name;
    const xmlStr = f.asText();
    zip.file(path, fillContentControlsInXml(xmlStr, data));
  });
}

/**
 * Fill the consent form template with participant and intake data.
 * All intake field_key values are exposed as placeholders (e.g. {primary_contact_name}).
 * @param {object} participant - { name, email, phone, address, date_of_birth, ndis_number }
 * @param {object} intake - intake fields (key-value from participant_intake_fields)
 * @param {object} [options] - optional { coordinatorSignatureDataUrl, templateFilename } (templateFilename from form_templates after Forms upload)
 * @returns {Buffer} Filled docx buffer
 */
export function fillConsentForm(participant = {}, intake = {}, options = {}) {
  const { templateFilename, ...restOptions } = options;
  const path = getConsentFormPath({ templateFilename });
  if (!path) {
    throw new Error('Consent form template not found. Place a .docx template in data/forms/templates/privacy-consent/');
  }

  const content = readFileSync(path, 'binary');
  const zip = new PizZip(content);
  const today = new Date().toISOString().slice(0, 10);

  const data = {
    name: participant.name || '',
    participant_name: participant.name || '',
    client_name: participant.name || '',
    email: participant.email || '',
    phone: participant.phone || '',
    address: participant.address || '',
    ndis_number: participant.ndis_number || '',
    date_of_birth: (participant.date_of_birth || '').toString().slice(0, 10),
    date: today,
    today: today,
    primary_contact_name: toSafeString(intake.primary_contact_name || participant.parent_guardian_name),
    primary_contact_phone: toSafeString(intake.primary_contact_phone || participant.parent_guardian_phone),
    primary_contact_email: toSafeString(intake.primary_contact_email || participant.parent_guardian_email),
    coordinator_signed_date: restOptions.coordinatorSignatureDataUrl ? today : '',
    coordinator_signature_note: restOptions.coordinatorSignatureDataUrl ? 'Signed by coordinator' : ''
  };

  // Merge every intake field so any placeholder in the template (e.g. {full_legal_name}) is filled
  if (intake && typeof intake === 'object') {
    for (const [key, value] of Object.entries(intake)) {
      if (!key || key === 'template') continue;
      const safeKey = String(key).replace(/\s+/g, '_').replace(/-/g, '_');
      if (!(safeKey in data)) data[safeKey] = toSafeString(value);
    }
  }

  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => ''
  });
  doc.render(data);

  const outZip = doc.getZip();
  fillContentControlsInZip(outZip, data);
  return outZip.generate({ type: 'nodebuffer' });
}

/**
 * Convert a docx buffer to PDF using LibreOffice (soffice) if available.
 * @param {Buffer} docxBuffer - filled docx content
 * @returns {Buffer|null} PDF buffer, or null if conversion not available/fails
 */
export function convertDocxToPdf(docxBuffer) {
  const tmpDir = join(tmpdir(), `consent-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const docxPath = join(tmpDir, 'consent.docx');
  const outDir = tmpDir;

  try {
    writeFileSync(docxPath, docxBuffer);
    const result = spawnSync('soffice', [
      '--headless',
      '--convert-to', 'pdf',
      '--outdir', outDir,
      docxPath
    ], { encoding: 'utf8', timeout: 60000 });

    if (result.status !== 0) return null;
    const pdfPath = join(outDir, 'consent.pdf');
    if (!existsSync(pdfPath)) return null;
    return readFileSync(pdfPath);
  } catch {
    return null;
  }
}
