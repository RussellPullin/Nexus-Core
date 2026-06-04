import PDFDocument from 'pdfkit';
import { privacyPolicyPhrase, providerDisplayName, providerLegalPhrase } from '../lib/templateBranding.js';

function ensureSpace(doc, y, needed, margin, pageMaxY) {
  if (y + needed > pageMaxY) {
    doc.addPage();
    return margin;
  }
  return y;
}

function checkbox(doc, x, y, checked) {
  const size = 10;
  doc.rect(x, y, size, size).stroke('#0f172a');
  if (checked) {
    doc
      .save()
      .lineWidth(2)
      .moveTo(x + 2, y + 5)
      .lineTo(x + 4, y + 8)
      .lineTo(x + 9, y + 2)
      .stroke('#0f172a')
      .restore();
  }
  return size;
}

function safeText(v) {
  return String(v ?? '').trim();
}

/**
 * Render a Privacy Consent PDF from a snapshot (intake + coordinator tickboxes).
 * Produces a human-readable PDF matching the same fields as the supplied policy PDF,
 * but rendered via pdfkit so it is always auto-fillable.
 *
 * Also returns an embedded signing_layout for Dropbox Sign field placement.
 */
export function generatePrivacyConsentPdfBuffer(snapshot) {
  return new Promise((resolvePromise, reject) => {
    const doc = new PDFDocument({ margin: 48, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolvePromise(Buffer.concat(chunks)));
    doc.on('error', reject);

    const margin = 48;
    const pageWidth = doc.page.width;
    const pageMaxY = () => doc.page.height - 60;
    let y = margin;

    const org = snapshot?.org || null;
    const providerName = providerDisplayName(org);
    const providerPhrase = providerLegalPhrase(org);
    const policyName = privacyPolicyPhrase(org);

    const title = 'Privacy Consent Form';
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#0f172a').text(title, margin, y);
    y += 18;
    doc.font('Helvetica').fontSize(10).fillColor('#334155').text(providerName, margin, y);
    y += 16;

    const para = (t) => {
      doc.font('Helvetica').fontSize(9).fillColor('#0f172a');
      const h = doc.heightOfString(t, { width: pageWidth - 2 * margin });
      y = ensureSpace(doc, y, h + 8, margin, pageMaxY());
      doc.text(t, margin, y, { width: pageWidth - 2 * margin });
      y += h + 8;
    };

    para(
      `${providerPhrase} respects your privacy. This statement explains why we collect and use your personal information and the parties to whom your information may be disclosed and obtains your consent to such collection, use and disclosure.`
    );
    para(
      'The personal information we process about you will include information about you and your disability. This information may take many forms including as written by us and by other health professionals as well as photographs and videos of you and your condition taken by us or other health professionals.'
    );
    para(
      'We use your personal information to provide, manage and administer care to you and for purposes directly or indirectly related to providing, managing and administering such care.'
    );

    const h2 = (t) => {
      y = ensureSpace(doc, y, 22, margin, pageMaxY());
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f172a').text(t, margin, y);
      y += 16;
      doc
        .save()
        .moveTo(margin, y)
        .lineTo(pageWidth - margin, y)
        .lineWidth(0.5)
        .stroke('#cbd5e1')
        .restore();
      y += 10;
    };

    const kv2 = (labelA, valueA, labelB, valueB) => {
      const colW = (pageWidth - 2 * margin - 16) / 2;
      const x1 = margin;
      const x2 = margin + colW + 16;
      const rowH = 30;
      y = ensureSpace(doc, y, rowH + 8, margin, pageMaxY());

      doc.font('Helvetica-Bold').fontSize(8).fillColor('#475569').text(labelA, x1, y);
      doc.font('Helvetica').fontSize(10).fillColor('#0f172a').text(safeText(valueA) || '—', x1, y + 10, { width: colW });

      doc.font('Helvetica-Bold').fontSize(8).fillColor('#475569').text(labelB, x2, y);
      doc.font('Helvetica').fontSize(10).fillColor('#0f172a').text(safeText(valueB) || '—', x2, y + 10, { width: colW });

      y += rowH;
    };

    const kv1 = (label, value) => {
      const rowH = 28;
      y = ensureSpace(doc, y, rowH + 8, margin, pageMaxY());
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#475569').text(label, margin, y);
      doc.font('Helvetica').fontSize(10).fillColor('#0f172a').text(safeText(value) || '—', margin, y + 10, {
        width: pageWidth - 2 * margin
      });
      y += rowH;
    };

    h2('Client Details');
    kv2('Full legal name', snapshot.participant?.full_legal_name, 'Preferred name', snapshot.participant?.preferred_name);
    kv2('Date of birth', snapshot.participant?.date_of_birth_display, 'NDIS number', snapshot.participant?.ndis_number);
    kv2('Email', snapshot.participant?.email, 'Phone', snapshot.participant?.phone);
    kv1('Street address', snapshot.participant?.address?.street_address);
    kv2('Suburb/City', snapshot.participant?.address?.suburb_city, 'State', snapshot.participant?.address?.state);
    kv1('Postcode', snapshot.participant?.address?.postcode);

    h2('Primary Contact / Guardian');
    kv2('Name', snapshot.primary_contact?.name, 'Relationship', snapshot.primary_contact?.relationship);
    kv2('Phone', snapshot.primary_contact?.phone, 'Email', snapshot.primary_contact?.email);

    h2('Consent to liaise and share information (tick relevant boxes)');
    const liaison = snapshot.consent?.liaison || {};
    const liaisonItems = [
      ['NDIS Coordinator', liaison.ndis_coordinator],
      ['Occupational Therapist', liaison.occupational_therapist],
      ['School Guidance Officer', liaison.school_guidance_officer],
      ['General Practitioner (GP)', liaison.general_practitioner],
      ['Psychologist', liaison.psychologist],
      ['Psychiatrist', liaison.psychiatrist],
      ['Physiotherapist', liaison.physiotherapist],
      ['Other', liaison.other_1],
      ['Other', liaison.other_2],
      ['Other', liaison.other_3]
    ];

    const itemRow = (label, checked, detailValue = '') => {
      const lineH = 16;
      y = ensureSpace(doc, y, lineH + 10, margin, pageMaxY());
      checkbox(doc, margin, y + 2, Boolean(checked));
      doc.font('Helvetica').fontSize(10).fillColor('#0f172a').text(label, margin + 16, y, {
        width: pageWidth - 2 * margin - 16
      });
      y += lineH;
      if (label === 'Other') {
        const dv = safeText(detailValue);
        if (dv) {
          doc.font('Helvetica').fontSize(9).fillColor('#334155').text(`Details: ${dv}`, margin + 16, y - 2, {
            width: pageWidth - 2 * margin - 16
          });
          y += 12;
        }
      }
    };

    itemRow(liaisonItems[0][0], liaisonItems[0][1]);
    itemRow(liaisonItems[1][0], liaisonItems[1][1]);
    itemRow(liaisonItems[2][0], liaisonItems[2][1]);
    itemRow(liaisonItems[3][0], liaisonItems[3][1]);
    itemRow(liaisonItems[4][0], liaisonItems[4][1]);
    itemRow(liaisonItems[5][0], liaisonItems[5][1]);
    itemRow(liaisonItems[6][0], liaisonItems[6][1]);
    itemRow(liaisonItems[7][0], liaisonItems[7][1], snapshot.consent?.liaison_other_details_1);
    itemRow(liaisonItems[8][0], liaisonItems[8][1], snapshot.consent?.liaison_other_details_2);
    itemRow(liaisonItems[9][0], liaisonItems[9][1], snapshot.consent?.liaison_other_details_3);

    y += 8;
    y = ensureSpace(doc, y, 18, margin, pageMaxY());
    checkbox(doc, margin, y + 2, Boolean(snapshot.consent?.contact_by_email_sms));
    doc.font('Helvetica').fontSize(10).fillColor('#0f172a').text('I consent to contact by email and SMS.', margin + 16, y);
    y += 18;

    para('In some circumstances, information could be provided without your consent if required or authorised by law.');

    h2('Complaints and Incidents');
    para(
      `The ${policyName} contains information about how you can access the personal information we hold about you, how you can make a complaint about a breach of your privacy or the Privacy Act and how we will deal with your complaint (in accordance with our Feedback and Complaints Management Policy).`
    );
    para(
      'Any breach or alleged breach of your privacy will be taken seriously and managed in accordance with our Incident Management and Reporting Policy.'
    );
    para(
      'You can contact us to request copies of our Privacy and Dignity Policy, Feedback and Complaints Management Policy or Incident Management and Reporting Policy.'
    );

    h2('Client Consent (A)');
    para(
      'I have read this Privacy Consent Form and the Privacy and Dignity Policy and consent to the use of my personal information for the purposes set out above and in accordance with my preferences.'
    );

    // Signature block A (Participant)
    const sigBlock = (labelLeft, labelRight) => {
      y = ensureSpace(doc, y, 60, margin, pageMaxY());
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f172a').text(labelLeft, margin, y);
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f172a').text(labelRight, margin + 320, y);
      const lineY = y + 22;
      doc
        .save()
        .moveTo(margin, lineY)
        .lineTo(margin + 280, lineY)
        .stroke('#0f172a')
        .moveTo(margin + 320, lineY)
        .lineTo(pageWidth - margin, lineY)
        .stroke('#0f172a')
        .restore();
      y += 46;
    };

    sigBlock('Client signature', 'Date');
    kv1('Client name (print)', snapshot.participant?.full_legal_name || snapshot.participant?.first_name || snapshot.participant?.last_name);

    h2('Guardian/Parent Consent (B)');
    para(
      'I am authorised to act on behalf of the client named below and consent on their behalf for the use of their personal information for the purposes set out above and in accordance with the preferences set out below.'
    );
    kv1('Client name (print)', snapshot.participant?.full_legal_name || snapshot.participant?.first_name || snapshot.participant?.last_name);
    sigBlock('Representative signature', 'Date');
    kv1('Representative name (print)', snapshot.primary_contact?.name);
    para('Please complete either A or B above.');

    h2('Keeping other people informed');
    kv1('1. I direct you NOT to provide my / the client’s personal information to (names / details)', snapshot.consent?.not_provide_info_to_names);
    kv1(
      '2. In addition to the people set out above, I consent for you to disclose my / the client’s personal information to (names / contact details)',
      snapshot.consent?.disclose_to_additional_names
    );

    h2('Withdrawal of consent (if applicable)');
    const w = snapshot.consent?.withdrawal || {};
    const withdrawalItems = [
      ['NDIS audit and other quality assurance activities', w.ndis_audit_quality],
      ['Carrying out internal functions including training', w.internal_training],
      ['Receiving marketing communications', w.marketing_communications],
      ['Photos published on website or social media', w.photos_website_social],
      ['Audio and/or visual recordings', w.audio_visual_recordings]
    ];
    withdrawalItems.forEach(([label, checked]) => {
      y = ensureSpace(doc, y, 16, margin, pageMaxY());
      checkbox(doc, margin, y + 2, Boolean(checked));
      doc.font('Helvetica').fontSize(10).fillColor('#0f172a').text(label, margin + 16, y, {
        width: pageWidth - 2 * margin - 16
      });
      y += 16;
    });

    y += 10;
    y = ensureSpace(doc, y, 22, margin, pageMaxY());
    checkbox(doc, margin, y + 2, Boolean(snapshot.consent?.wants_copy_and_policy));
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#0f172a')
      .text('I would like a copy of this signed privacy consent form and the Privacy and Dignity Policy.', margin + 16, y, {
        width: pageWidth - 2 * margin - 16
      });
    y += 22;
    kv1('Email or mailing address', snapshot.consent?.copy_delivery_details);
    para('You can withdraw or modify consent at any time by providing written or verbal notice.');

    h2('Declaration by staff member');
    para('I declare that I have explained the matters on this form to the client, including how their personal and sensitive information will be handled.');

    // Staff declaration signature lines (non-interactive for now)
    sigBlock('Staff signature', 'Date');
    kv1('Name (print)', snapshot.staff?.name_print);
    para(
      'Need help understanding? Let us know if you need help to understand this document. We can arrange bilingual staff, interpreters or advocates to support you.'
    );

    // Signing layout for Dropbox Sign - place a single signer (participant) over Client Consent (A)
    // signature + printed name + date. This is the minimum viable signing flow.
    // Coordinates are derived from current y positions; we anchor to the Client Consent (A) lines by
    // replaying rough offsets. For stability we compute them using fixed positions on the last page.
    const signingPage = doc.bufferedPageRange().count;
    const sigY = doc.page.height - 250;
    snapshot.signing_layout = {
      page: signingPage,
      participant: {
        signature: { page: signingPage, x: margin, y: sigY, width: 280, height: 32 },
        printed_name: { page: signingPage, x: margin, y: sigY + 54, width: pageWidth - 2 * margin, height: 16 },
        date: { page: signingPage, x: margin + 320, y: sigY, width: pageWidth - margin - (margin + 320), height: 16 }
      }
    };

    doc.end();
  });
}

