/** Hazard checklist blocks for activity risk assessments (Step 1 → Step 3 sync). */
export const ACTIVITY_RISK_HAZARD_BLOCKS = [
  {
    category: 'Biological (hygiene, disease, infection)',
    prefix: 'hazard_bio',
    cols: 3,
    items: [
      'Blood / bodily fluids',
      'Virus / disease',
      'Food handling',
      'Insect / tick-borne illness',
      'Skin infection risk (cuts near natural water)'
    ]
  },
  {
    category: 'Chemicals  (refer to label and SDS for classification and management)',
    prefix: 'hazard_chem',
    cols: 2,
    items: [
      'Non-hazardous chemical(s)',
      'Hazardous chemical (refer to completed chemical risk assessment)',
      'Sunscreen / insect repellent',
      'Cleaning agents / sanitisers'
    ]
  },
  {
    category: 'Critical Incident — may result in:',
    prefix: 'hazard_critical',
    cols: 3,
    items: [
      'Serious injury / death',
      'Evacuation required',
      'Minor injury',
      'Participant elopement / missing person',
      'Medical emergency (seizure, anaphylaxis, cardiac)'
    ]
  },
  {
    category: 'Environment — Outdoor / Natural Setting',
    prefix: 'hazard_env',
    cols: 3,
    items: [
      'Sun exposure / UV',
      'Water (creek, river, beach, dam, pool)',
      'Animals / insects / wildlife',
      'Storms / lightning / severe weather',
      'Extreme temperature (heat / cold)',
      'Uneven terrain / remote location',
      'Flooding / fast-moving water',
      'Sound / noise'
    ]
  },
  {
    category: 'Facilities / Built Environment',
    prefix: 'hazard_facility',
    cols: 3,
    items: [
      'Workshops / work rooms',
      'Buildings and fixtures',
      'Driveways / paths',
      'Playground equipment',
      'Furniture',
      'Swimming pool / water feature'
    ]
  },
  {
    category: 'Machinery, Plant & Equipment',
    prefix: 'hazard_machinery',
    cols: 3,
    items: [
      'Power tools',
      'Hand tools',
      'Vehicles / transport',
      'Ropes / climbing equipment',
      'Craft / art equipment'
    ]
  },
  {
    category: 'Manual Tasks / Physical Demands',
    prefix: 'hazard_manual',
    cols: 3,
    items: [
      'Repetitive or heavy manual tasks',
      'Working at heights',
      'Restricted / confined space',
      'Physical overexertion',
      'Lifting / carrying loads'
    ]
  },
  {
    category: 'Participant-Specific Considerations (NDIS)',
    prefix: 'hazard_participant',
    cols: 2,
    items: [
      'Behavioural support needs (aggression, elopement)',
      'Sensory sensitivities (noise, texture, heat, light)',
      'Communication support needs',
      'Medical conditions (seizure, allergy, diabetes)',
      'Psychological / emotional wellbeing',
      'Physical disability / reduced mobility',
      'Fatigue or medication side-effects',
      'Participant / carer consent requirements'
    ]
  },
  {
    category: 'People',
    prefix: 'hazard_people',
    cols: 3,
    items: [
      'Participant',
      'Support worker / therapist',
      'Other participants',
      'Volunteers / community members',
      'Members of public'
    ]
  }
];

export const ACTIVITY_RISK_CONTROL_ROW_COUNT = 10;

export function isActivityRiskHazardField(name) {
  const key = String(name || '');
  return /^hazard_[a-z]+_\d+$/.test(key) || /^hazard_[a-z]+_other$/.test(key);
}

/** Collect ticked hazard labels (and non-empty Other fields) in checklist order. */
export function getCheckedActivityRiskHazardLabels(fieldValues) {
  const labels = [];
  if (!fieldValues || typeof fieldValues !== 'object') return labels;

  for (const block of ACTIVITY_RISK_HAZARD_BLOCKS) {
    block.items.forEach((label, idx) => {
      const fieldName = `${block.prefix}_${idx + 1}`;
      const raw = fieldValues[fieldName];
      if (raw === true || raw === 'true' || raw === 1 || raw === '1') {
        labels.push(label);
      }
    });
    const otherKey = `${block.prefix}_other`;
    const otherVal = String(fieldValues[otherKey] || '').trim();
    if (otherVal) labels.push(`Other (${block.prefix}): ${otherVal}`);
  }

  return labels;
}

/**
 * Copy ticked Step 1 hazards into Step 3 control description rows.
 * Preserves manually edited descriptions unless they match a prior auto-sync value.
 */
export function syncCheckedHazardsToControlRows(values, { previousAutoDesc = {} } = {}) {
  const checked = getCheckedActivityRiskHazardLabels(values);
  const next = { ...values };
  const nextAutoDesc = { ...previousAutoDesc };

  for (let i = 1; i <= ACTIVITY_RISK_CONTROL_ROW_COUNT; i++) {
    const key = `control_${i}_desc`;
    const hazardLabel = checked[i - 1] || '';
    const current = String(values[key] ?? '').trim();
    const prevAuto = String(previousAutoDesc[key] ?? '').trim();

    if (hazardLabel) {
      if (!current || current === prevAuto) {
        next[key] = hazardLabel;
        nextAutoDesc[key] = hazardLabel;
      }
    } else if (!current || current === prevAuto) {
      next[key] = '';
      nextAutoDesc[key] = '';
    }
  }

  return { values: next, autoDesc: nextAutoDesc };
}

export function inferAutoSyncedControlDesc(values) {
  const checked = getCheckedActivityRiskHazardLabels(values);
  const autoDesc = {};
  for (let i = 1; i <= ACTIVITY_RISK_CONTROL_ROW_COUNT; i++) {
    const key = `control_${i}_desc`;
    const hazardLabel = checked[i - 1] || '';
    const current = String(values[key] ?? '').trim();
    if (hazardLabel && current === hazardLabel) autoDesc[key] = hazardLabel;
    else if (!current) autoDesc[key] = '';
  }
  return autoDesc;
}
