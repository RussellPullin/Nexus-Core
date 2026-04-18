/**
 * Shared prompt for mapping arbitrary CSV headers → participant fields.
 * Keep in sync with server expectations in participants CSV import (sanitize allows only listed targets).
 * @param {string[]} headers
 */
export function buildParticipantsCsvColumnMapPrompt(headers) {
  return `You are mapping CSV column headers to participant intake fields. Given these headers: ${JSON.stringify(headers)}

Return a JSON object mapping each header (exact string) to one of: name, first_name, last_name, middle_name, preferred_name, ndis_number, email, phone, address, date_of_birth, management_type, plan_manager_name, plan_manager_email, invoice_email, additional_invoice_emails, plan_start_date, plan_end_date, diagnosis, medical_conditions, medications, allergies, goals, support_category, notes, primary_contact_name, primary_contact_email, primary_contact_phone, parent_guardian_phone, parent_guardian_email, emergency_contact_name, emergency_contact_phone, emergency_contact_email. Use null for headers that don't map. IMPORTANT: Map "Family Name", "Surname", "Last Name" to last_name. Example: {"Client Name":"name","First Name":"first_name","Family Name":"last_name","NDIS #":"ndis_number","Guardian":"primary_contact_name"}`;
}
