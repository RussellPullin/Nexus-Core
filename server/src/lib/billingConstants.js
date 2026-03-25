/**
 * Billing constants - shared nf2f definition for draft-batch and create-batch.
 * NDIS: only one non-face-to-face charge per participant per day; multiple nf2f tasks are consolidated.
 */
export const NF2F_TASK_TYPES = ['meeting_non_f2f', 'email', 'phone'];

export function isNf2fTask(taskType) {
  return taskType && NF2F_TASK_TYPES.includes(taskType);
}
