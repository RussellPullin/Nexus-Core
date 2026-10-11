/**
 * Where a shift is worked, for state public-holiday rules.
 * Participant address is the shift location. Provider address is only a fallback.
 */
import { db } from '../db/index.js';
import { normalizeHolidayLocation } from '../../../shared/auPublicHolidays.js';

export const SHIFT_HOLIDAY_LOCATION_COLUMNS = `
  p.address AS participant_address,
  (
    SELECT pif.field_value
    FROM participant_intake_fields pif
    JOIN participant_onboarding po ON po.id = pif.participant_onboarding_id
    WHERE po.participant_id = p.id AND pif.field_key = 'state'
    ORDER BY pif.updated_at DESC
    LIMIT 1
  ) AS intake_state,
  (
    SELECT COALESCE(
      NULLIF(TRIM(biz.company_address), ''),
      NULLIF(TRIM(org.address), ''),
      NULLIF(TRIM(org.street_address), '')
    )
    FROM organisations org
    LEFT JOIN business_settings biz ON biz.org_id = org.id
    WHERE org.id = p.provider_org_id
    LIMIT 1
  ) AS org_address
`;

export function loadParticipantHolidayLocation(participantId) {
  if (!participantId) return { state: null, locationText: '' };
  const row = db.prepare(`
    SELECT
      p.address AS participant_address,
      (
        SELECT pif.field_value
        FROM participant_intake_fields pif
        JOIN participant_onboarding po ON po.id = pif.participant_onboarding_id
        WHERE po.participant_id = p.id AND pif.field_key = 'state'
        ORDER BY pif.updated_at DESC
        LIMIT 1
      ) AS intake_state,
      (
        SELECT COALESCE(
          NULLIF(TRIM(biz.company_address), ''),
          NULLIF(TRIM(org.address), ''),
          NULLIF(TRIM(org.street_address), '')
        )
        FROM organisations org
        LEFT JOIN business_settings biz ON biz.org_id = org.id
        WHERE org.id = p.provider_org_id
        LIMIT 1
      ) AS org_address
    FROM participants p
    WHERE p.id = ?
  `).get(participantId);
  if (!row) return { state: null, locationText: '' };
  return normalizeHolidayLocation(row);
}
