/**
 * Standard NDIS-style Services Agreement — Version 3 layout (generic master; no tenant PII).
 * Clause wording follows the standard sixteen-clause structure; organisation names use {{placeholders}}.
 */

export const DOCUMENT_META = {
  documentTitle: 'Services Agreement',
  versionLabel: '',
  /** Bumped when master definition_json changes — seed service refreshes DB row. */
  definitionRevision: 9
};

export const SECTION_TITLES = {
  s1: 'Section 1 — Parties to this Agreement',
  s2: 'Section 2 — Key Details',
  s3: 'Section 3 — Agreement Checklist',
  s4: 'Section 4 — Terms of Agreement'
};

export const PARTIES_BLOCK_LABELS = {
  service_provider: 'Service Provider (We / Us)',
  client_details: 'Participant details (You)',
  representative: 'Representative / Advocate (if applicable)',
  invoicing_funding: 'Invoicing / Funding Management',
  plan_manager: 'Plan Manager Details (complete if plan managed)'
};

/**
 * Section 4 clauses — fixed wording with {{placeholders}} for org / variables.
 */
export const TERMS_CLAUSES = [
  {
    number: 1,
    title: 'Purpose of this Agreement',
    body:
      '(a) The purpose of this Agreement is to document a personalised and self-directed support arrangement between {{org_trading_name}} and you. Please ensure your details and those of your Representative (if any) are accurately set out above.\n\n' +
      '(b) This Agreement is made in accordance with the rules and goals of the NDIS and for the purpose of providing the Services to you in accordance with your Plan.\n\n' +
      '(c) This Agreement is made in the context of the NDIS, which is a scheme that aims to: (1) support the independence and social and economic participation of people with disability; and (2) enable people with disability to exercise choice and control in the pursuit of their goals and the planning and delivery of their supports.'
  },
  {
    number: 2,
    title: 'Definitions',
    body:
      'Agreement means this agreement including any schedules and annexures. Client or you means the NDIS participant identified in Section 1. Commencement Date means the date on which you sign this Agreement. NDIA means the National Disability Insurance Agency. NDIS means the National Disability Insurance Scheme established by the NDIS Act. NDIS Act means the National Disability Insurance Scheme Act 2013 (Cth). Other Support Services means services delivered to you by other service providers. Personal Support means assistance with daily personal activities. Plan means the written plan developed with you by the NDIA. Principal means {{principal_names}}. {{org_trading_name}}, us or we means {{org_legal_name}} ABN {{org_abn}}. Services means the services and support agreed under clause 4(a). Worker means any worker providing support or services to you.'
  },
  {
    number: 3,
    title: 'Commencement and Review',
    body:
      '(a) This Agreement commences on the Commencement Date and continues until terminated in accordance with clause 13.\n\n' +
      '(b) The terms of this Agreement will be reviewed on the Review Date specified in Section 2.'
  },
  {
    number: 4,
    title: 'The Services We Provide',
    body:
      '(a) You, your Representative and {{org_trading_name}} will work together to determine the specific Services to meet your goals. Services will be set out in writing in the Services and Supports Schedule.\n\n' +
      '(b) Services can be adjusted in consultation with us as your needs, goals and preferences change.\n\n' +
      '(c) If your Plan details differ from the NDIS portal, {{org_trading_name}} will provide Services according to the NDIS portal details.\n\n' +
      '(d) You and your Representative agree to: (1) {{org_trading_name}} assessing and reviewing your Plan; (2) {{org_trading_name}} discussing your Plan with the NDIA and contractors; (3) {{org_trading_name}} discussing your Plan with other support providers; (4) {{org_trading_name}} claiming travel time and costs; (5) {{org_trading_name}} claiming for Non-Face-to-Face supports; (6) {{org_trading_name}} claiming for NDIA Requested Reports; (7) {{org_trading_name}} providing Services in line with this Agreement; (8) third-party auditing and review of records; and (9) compliance with {{org_trading_name}}\'s Policies.'
  },
  {
    number: 5,
    title: 'Your Consent to Services',
    body:
      '(a) Your informed consent is required. If the Client is a child, a parent or legal guardian must also provide consent.\n\n' +
      '(b) You may withdraw consent for any specific Service at any time, which will cease immediately.\n\n' +
      '(c) Services carry benefits and risks. Staff will discuss foreseeable risks before providing any Service.\n\n' +
      '(d) Staff may ask personal questions relating to your goals. The more information you provide, the more effective the Services.\n\n' +
      '(e) Consent is achieved through signing this Agreement, with implied consent assumed for the duration.\n\n' +
      '(f) Please inform staff of: (1) heart conditions impacting physical activity; (2) seizures; (3) severe respiratory conditions; (4) severe allergies; (5) severe phobias; (6) absconding behaviours.\n\n' +
      '(g) By receiving Services you acknowledge: assessment/screening may be undertaken; video, photo and written records may be taken; relevant parties may be contacted to discuss your Plan.'
  },
  {
    number: 6,
    title: 'Fees for Services',
    body:
      '(a) {{org_trading_name}} will charge you for the Services and you must pay.\n\n' +
      '(b) Additional expenses not funded under your Plan are your responsibility.\n\n' +
      '(c) Prices are set in the NDIS Price Guide and will be automatically adjusted when the Price Guide changes.\n\n' +
      '(d) An establishment fee may be charged for personal care/participation Services where applicable under NDIS Rules, provided at least {{establishment_fee_min_hours}} hours per month of personal care/community access support is to be delivered.\n\n' +
      '(e) Where recreational or community access services are funded under your Plan, funded hours may be converted to a fee for those purposes.\n\n' +
      '(f) Group centre-based care may attract an additional allowance of ${{group_centre_allowance_per_hour}} per hour.\n\n' +
      '(g) Shadow shifts may be charged (up to {{shadow_shift_max_hours_per_year}} hours per year at weekday rates) where complex needs require a new worker to be introduced before providing Services independently.\n\n' +
      '(h)-(i) Meal preparation Services are charged at an hourly rate; the cost of food itself is not covered under the Plan.'
  },
  {
    number: 7,
    title: 'Payments',
    body:
      '(a) Self-managed: Invoices must be paid within {{invoice_payment_terms_days}} days.\n\n' +
      '(b) Plan Nominee managed: Invoices sent to nominee, payable within {{invoice_payment_terms_days}} days.\n\n' +
      '(c) NDIA managed: {{org_trading_name}} will claim payment directly from the NDIA.\n\n' +
      '(d) Plan Manager managed: {{org_trading_name}} will claim from the plan management provider.\n\n' +
      '(e) If {{org_trading_name}} is unable to obtain payment from the above parties, you must pay all amounts due.'
  },
  {
    number: 8,
    title: 'Your Rights and Our Responsibilities',
    body:
      '8.1 General. During this Agreement, {{org_trading_name}} will: act with respect for your rights; respect your privacy and right to intimacy; provide Services safely and competently; act with integrity and transparency; prevent and respond to violence, exploitation, neglect and abuse; prevent and respond to sexual misconduct; arrive on time; comply with all applicable laws; treat you with dignity; make reasonable efforts to involve you in selecting workers; notify you of changes; maintain confidential records; provide timely invoices; and communicate openly.\n\n' +
      '8.2 Advocacy. You have a right to be represented by an advocate at any time. We can assist you to access advocacy bodies.\n\n' +
      '8.3 Clients Subject to a Significant Risk Factor. For clients identified as Subject to a Significant Risk Factor, {{org_trading_name}} will ensure appropriate assessment, documentation, supervision and communication obligations are met.\n\n' +
      '8.4 Matching a Worker. {{org_trading_name}} will work with you to match the right Worker to meet your needs, taking into account personality, language, culture, skill and risk factors.\n\n' +
      '8.5 Monitoring and Supervision. {{org_trading_name}} will supervise Worker performance and undertake in-person supervision at the agreed frequency.\n\n' +
      '8.6 Risk Management. {{org_trading_name}} will maintain documented supervision plans, provide regular reports to key management, and address identified concerns without unreasonable delay.\n\n' +
      '8.7 Emergency and Disaster Management. In the event of unavoidable service disruption, {{org_trading_name}} will: (1) attempt to source an internal replacement Worker; (2) engage an external agency if needed; (3) recruit a new Worker if the absence becomes permanent.'
  },
  {
    number: 9,
    title: 'Responsibilities of the Client',
    body:
      'You and your Representatives agree to: (a) let {{org_trading_name}} know about concerns with Services; (b) be actively involved in designing the support plan; (c) ensure fees can be met from your approved Plan; (d) pay all invoices promptly; (e) notify us immediately if you stop being an NDIS participant; (f) keep {{org_trading_name}} informed of relevant changes in circumstances; (g) be at the agreed location at appointment times; (h) treat all {{org_trading_name}} staff with respect; (i) advise us of any changes to your Plan; (j) provide updated Plans as soon as possible; (k) consent to electronic communications; (l) inform us if you prefer not to receive documents electronically.'
  },
  {
    number: 10,
    title: 'Cancellation and No Show Policy',
    body:
      'You agree that {{org_trading_name}} may charge {{cancellation_charge_percent}}% of the relevant amount if you: (a) do not attend a scheduled Service within a reasonable time; or (b) give less than {{cancellation_notice_days}} clear days\' notice of cancellation, and {{org_trading_name}} cannot find alternative work for the scheduled employee.'
  },
  {
    number: 11,
    title: 'Privacy',
    body:
      '(a) We collect, use, disclose and store Personal Information and Sensitive Information in accordance with applicable privacy laws.\n\n' +
      '(b) Our Privacy and Dignity Policy sets out how this information is handled. A copy is available on request.\n\n' +
      '(c) You may make decisions about your Personal Information through a Privacy Consent Form.'
  },
  {
    number: 12,
    title: 'Feedback and Complaints',
    body:
      '(a) You are encouraged to raise concerns with us directly.\n\n' +
      '(b) Anonymous complaints may be made by calling or writing without including your name.\n\n' +
      '(c) Complaints may be lodged: in person to the Principal or a staff member; by email to {{complaints_email}}; by post to {{complaints_postal_address}}; or by telephone on {{complaints_phone}}.\n\n' +
      '(d) You may also complain to the NDIS Commission by phoning 1800 035 544 or visiting ndiscommission.gov.au/about/complaints.\n\n' +
      '(e) All complaints will be resolved in accordance with our Feedback and Complaints Management Policy.'
  },
  {
    number: 13,
    title: 'Termination',
    body:
      '(a) Either party may terminate this Agreement by giving at least {{termination_notice_weeks}} weeks\' written notice.\n\n' +
      '(b) {{org_trading_name}} may terminate with immediate effect if: the Client ceases to be an NDIS participant; the services are no longer able to meet the Client\'s needs; the Client fails to communicate relevant changes; the Client transfers to another provider; the Client dies; the Client is unwilling to work towards agreed goals; the Client is unwilling to meet reasonable support plan conditions; the Client breaches the Agreement; the Client fails to comply with {{org_trading_name}} Policies; the Client\'s condition exceeds {{org_trading_name}}\'s capacity; there has been no contact for {{no_contact_termination_months}} months; the Client or support network engages in unacceptable behaviour; the Client ignores risk management procedures; or the Client fails to pay fees by the due date.'
  },
  {
    number: 14,
    title: 'Indemnity and Release',
    body:
      '(a) Except where liability is caused by our negligence, you irrevocably and unconditionally indemnify {{org_trading_name}} against all liabilities arising from: damage or loss of property, injury or death; things done under this Agreement; or Services not being available.\n\n' +
      '(b) You also indemnify {{org_trading_name}} against liabilities arising from: our doing something you should have done; or your breach of this Agreement including acts of your Representative, agent or invitee.'
  },
  {
    number: 15,
    title: 'Goods and Services Tax',
    body:
      'The supply of Services under this Agreement constitutes the supply of reasonable and necessary supports specified in the Client\'s Plan under the NDIS Act. The Client\'s Plan is expected to remain in effect during the period Services are provided. The Client or representative will notify {{org_trading_name}} immediately if the Plan is replaced or the Client stops being an NDIS participant.'
  },
  {
    number: 16,
    title: 'General',
    body:
      '16.1 Governing law. This Agreement is governed by the laws of {{governing_law_jurisdiction}}.\n\n' +
      '16.2 Amendment. Amendments must be in writing and signed by both parties.\n\n' +
      '16.3 Waiver. A waiver must be in writing signed by the waiving party.\n\n' +
      '16.4 Exercise of rights. Rights may be exercised at the party\'s discretion and may be exercised separately or together.\n\n' +
      '16.5 Remedies cumulative. Rights and remedies under this Agreement are in addition to those provided by law.\n\n' +
      '16.6 Assignment. Only {{org_trading_name}} may assign its rights under this Agreement. Other parties may not assign their rights.\n\n' +
      '16.7 Severance. If any provision is invalid in any jurisdiction, it is severed to the minimum extent necessary without affecting remaining provisions.\n\n' +
      '16.8 Counterparts. This Agreement may be executed in counterparts including electronic form.\n\n' +
      '16.9 Consent or approval. Unless expressly stated, a party may give or withhold consent in its absolute discretion.\n\n' +
      '16.10 Entire agreement. This Agreement supersedes all prior discussions, undertakings and agreements.\n\n' +
      '16.11 Further assurances. Each party must do everything reasonably necessary to give effect to this Agreement.\n\n' +
      '16.12 Relationship. Nothing in this Agreement constitutes the parties as partners or agents.\n\n' +
      '16.13 Notices. Notices may be sent by hand, pre-paid post or email to the addresses set out in this Agreement.'
  }
];

/** Section 3 checklist — matches standard administration confirmations. */
export const AGREEMENT_CHECKLIST = [
  {
    id: 'chk_provided_agreement',
    text: 'Has the Client been provided this Agreement? (Provide date & method)'
  },
  {
    id: 'chk_intake_consistent',
    text: 'Is the Agreement consistent with the Client Intake Form? (If not, explain)'
  },
  {
    id: 'chk_understood',
    text: 'Has the Client been supported to understand the Agreement?'
  },
  {
    id: 'chk_representative_present',
    text: 'Was a representative or advocate present? (Provide details if yes)'
  },
  {
    id: 'chk_client_signed',
    text: 'Has the Client signed the Agreement?'
  },
  {
    id: 'chk_provider_signed',
    text: 'Have we signed the Agreement?'
  },
  {
    id: 'chk_copy_provided',
    text: 'Has a fully signed version been provided to the Client?'
  }
];
