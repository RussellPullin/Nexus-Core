import { db } from '../src/db/index.js';
import { upsertRenewalTasksForParticipant, createAuditEvent } from '../src/services/onboarding.service.js';

function runRenewals() {
  const onboardings = db.prepare('SELECT * FROM participant_onboarding').all();
  let totalCreated = 0;
  onboardings.forEach((onboarding) => {
    const created = upsertRenewalTasksForParticipant(onboarding.id);
    totalCreated += created;
    if (created > 0) {
      createAuditEvent({
        participantId: onboarding.participant_id,
        participantOnboardingId: onboarding.id,
        actorType: 'system',
        actorId: 'renewal_scheduler',
        eventType: 'renewal_tasks_generated',
        entityType: 'onboarding',
        entityId: onboarding.id,
        newValue: { tasks_created: created }
      });
    }
  });
  console.log(`Onboarding renewal run complete. Tasks created: ${totalCreated}`);
}

runRenewals();
