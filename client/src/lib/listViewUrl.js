/**
 * Build /participants/:id and /directory / /staff query strings so profile pages
 * can restore the previous list (search, filters, selected org).
 */

export const PARTICIPANTS_LIST_STORAGE_KEY = 'nexus_participants_list';
export const DIRECTORY_LIST_STORAGE_KEY = 'nexus_directory_list';
export const STAFF_LIST_STORAGE_KEY = 'nexus_staff_list';

/** Query for opening a participant from the participants list (preserve back). */
export function participantsProfileQueryFromList({ q, archived }) {
  const p = new URLSearchParams();
  p.set('from', 'participants');
  if (q) p.set('listQ', q);
  if (archived) p.set('listA', '1');
  return p.toString();
}

/** Query for opening a participant from directory (preserve back). */
export function participantsProfileQueryFromDirectory({ q, orgId }) {
  const p = new URLSearchParams();
  p.set('from', 'directory');
  if (q) p.set('dirQ', q);
  if (orgId) p.set('dirOrg', orgId);
  return p.toString();
}

/** Query for opening staff profile from staff list. */
export function staffProfileQueryFromList({ q, archived, role }) {
  const p = new URLSearchParams();
  p.set('from', 'staff');
  if (q) p.set('listQ', q);
  if (archived) p.set('listA', '1');
  if (role) p.set('listR', role);
  return p.toString();
}

/**
 * Where "Back to list" / browser back should go from participant profile.
 * Accepts URLSearchParams from the profile page.
 */
export function backToPreviousListPath(searchParams, basePrefix = '') {
  const from = searchParams.get('from');
  if (from === 'directory') {
    const p = new URLSearchParams();
    const q = searchParams.get('dirQ');
    if (q) p.set('q', q);
    const org = searchParams.get('dirOrg');
    if (org) p.set('org', org);
    const s = p.toString();
    return s ? `${basePrefix}/directory?${s}` : `${basePrefix}/directory`;
  }
  const p = new URLSearchParams();
  const lq = searchParams.get('listQ');
  if (lq) p.set('q', lq);
  if (searchParams.get('listA') === '1') p.set('archived', '1');
  const s = p.toString();
  return s ? `${basePrefix}/participants?${s}` : `${basePrefix}/participants`;
}

export function participantProfileBackLabel(searchParams) {
  return searchParams.get('from') === 'directory' ? 'Back to directory' : 'Back to list';
}

/** Staff profile → staff list */
export function backToStaffListPath(searchParams, basePrefix = '') {
  if (searchParams.get('from') !== 'staff') return `${basePrefix}/staff`;
  const p = new URLSearchParams();
  const lq = searchParams.get('listQ');
  if (lq) p.set('q', lq);
  if (searchParams.get('listA') === '1') p.set('archived', '1');
  const lr = searchParams.get('listR');
  if (lr) p.set('role', lr);
  const s = p.toString();
  return s ? `${basePrefix}/staff?${s}` : `${basePrefix}/staff`;
}
