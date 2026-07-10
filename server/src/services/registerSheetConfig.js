/** OneDrive Register/*.xlsx sheets linked into the Nexus Registers UI (column layout from Registers.xlsx). */

export const ONEDRIVE_LINKED_REGISTER_SHEETS = new Set([
  'Conflict of interest register',
  'Collection and storage of Med',
  'Continuous improvment',
  'Emergency test register',
  'Waste removal Register'
]);

/** First data row in each sheet (matches OneDrive template sync). */
export const REGISTER_SHEET_DATA_START = {
  Complaints: 4,
  'Document Register': 3,
  'Feedback and complaints': 4,
  'HR role register': 9,
  'Significant risk factor': 4,
  'Training and Development': 6,
  'Policy register': 3,
  'Conflict of interest register': 3,
  'Collection and storage of Med': 4,
  'Continuous improvment': 3,
  'Emergency test register': 3,
  'Incident register': 4,
  'Waste removal Register': 4
};

/** Excel column indices (1-based) for each logical UI column. */
export const REGISTER_SHEET_COLUMN_MAP = {
  'Conflict of interest register': [1, 2, 3, 4, 5, 6, 7, 8, 9],
  'Collection and storage of Med': [1, 3, 4, 5, 7, 9, 10, 12, 13, 14, 15, 16, 17, 18],
  'Continuous improvment': [1, 3, 5, 6, 9, 11, 12, 13, 14, 15, 16],
  'Emergency test register': [1, 3, 5, 7, 9, 11, 12, 13, 14, 15],
  'Waste removal Register': [1, 4, 5, 6, 8, 9]
};

export const ONEDRIVE_LINKED_REGISTER_UI_HEADERS = {
  'Conflict of interest register': [
    'Date of Notification',
    'Participant Name',
    'Service Type',
    'Nature of conflict or interest',
    'Alternative options / quotes',
    'Declaration obtained (Y/N)',
    'Date of declaration',
    'Person providing declaration',
    'Staff member providing declaration'
  ],
  'Collection and storage of Med': [
    'Date',
    'Time',
    'Storage locked (Y/N)',
    'Medication name',
    'Dosage (mg/tab)',
    'Lot no.',
    'Expiry date',
    'Package open date',
    'Tabs removed',
    'Tablets expected / counted',
    'Worker signature',
    'Prescriber',
    'Comments',
    'Medication returned / locked (Y/N)'
  ],
  'Continuous improvment': [
    'No.',
    'Date submitted',
    'ID',
    'Description',
    'Document reference',
    'Benefits',
    'Urgency',
    'Due date',
    'Cost',
    'Responsibility',
    'Status'
  ],
  'Emergency test register': [
    'No.',
    'Test date',
    'Type of test',
    'Emergency plan tested',
    'Start time',
    'End time',
    'Result',
    'Comments',
    'Improvements',
    'Tester signature'
  ],
  'Waste removal Register': [
    'Date added',
    'Added by',
    'Position',
    'Department',
    'Waste description',
    'Containers'
  ]
};
