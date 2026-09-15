#!/usr/bin/env node
/**
 * Create/complete six Activity Risk Assessments for adventure-therapy activities
 * (indoor rock climbing, outdoor rock climbing, boxing training, mountain biking,
 * swimming, bush walking) for one organisation, ready to be reviewed, natively
 * signed, and assigned to participant files from the Activity Risk Assessments
 * panel in the app.
 *
 * This does NOT sign the assessments — pre-activity sign-off (prepared/reviewed
 * by, date, signature, consent) is left blank so an admin completes that inside
 * the app via "Sign with Nexus Core", which is also the gate before an
 * assessment can be assigned to a participant.
 *
 * Usage:
 *   node server/scripts/seed-adventure-activity-risk-assessments.mjs <organisationId> [--dry-run] [--pdf-out <dir>]
 *
 * Production (Fly):
 *   fly ssh console -a nexus-core-crm -C \
 *     "env DATABASE_PATH=/data/schedule.db DATA_DIR=/data NODE_ENV=production \
 *      node /app/server/scripts/seed-adventure-activity-risk-assessments.mjs <organisationId>"
 */
import { config } from 'dotenv';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
config({ path: join(projectRoot, '.env') });

const {
  ensureOrgActivityRiskTemplates,
  listActivityRiskTemplates,
  createActivityRiskTemplate,
  createActivityRiskRecord,
  updateActivityRiskRecord,
  generateActivityRiskRecordPdfBuffer
} = await import('../src/services/activityRiskAssessments.service.js');

const args = process.argv.slice(2);
const orgId = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const pdfOutIdx = args.indexOf('--pdf-out');
const pdfOutDir = pdfOutIdx >= 0 ? args[pdfOutIdx + 1] : null;

if (!orgId) {
  console.error('Usage: node seed-adventure-activity-risk-assessments.mjs <organisationId> [--dry-run] [--pdf-out <dir>]');
  process.exit(1);
}

// ── Helpers to build field_values from a compact activity spec ───────────────

function hazardFields(spec) {
  const values = {};
  for (const [prefix, indices] of Object.entries(spec.hazards || {})) {
    for (const i of indices) values[`${prefix}_${i}`] = true;
  }
  for (const [prefix, other] of Object.entries(spec.hazardOther || {})) {
    values[`${prefix}_other`] = other;
  }
  return values;
}

function controlFields(rows) {
  const values = {};
  rows.forEach((row, idx) => {
    const i = idx + 1;
    values[`control_${i}_desc`] = row.desc || '';
    values[`control_${i}_pre_risk`] = row.pre || '';
    values[`control_${i}_controls`] = row.controls || '';
    values[`control_${i}_post_risk`] = row.post || '';
    values[`control_${i}_responsible`] = row.responsible || '';
  });
  return values;
}

function buildFieldValues(spec) {
  return {
    activity_name: spec.activityName,
    activity_location: spec.location,
    duration: spec.duration,
    ...hazardFields(spec),
    ...controlFields(spec.controls),
    additional_notes: spec.notes || ''
  };
}

// ── Activity content ──────────────────────────────────────────────────────────

const ACTIVITIES = [
  {
    templateName: 'Rock Climbing (Indoor)',
    activityName: 'Rock Climbing — Indoor',
    location: 'Commercial indoor climbing centre',
    duration: '2–3 hours, incl. induction/briefing',
    hazards: {
      hazard_bio: [1],
      hazard_chem: [4],
      hazard_critical: [1, 2, 3, 4, 5],
      hazard_facility: [2],
      hazard_machinery: [4],
      hazard_manual: [2, 4],
      hazard_participant: [1, 2, 3, 4, 5, 6, 7, 8],
      hazard_people: [1, 2, 3, 5]
    },
    controls: [
      { desc: 'Falls from height', pre: 'High', controls: 'Instructor safety briefing and belay check before every climb; auto-belay/top-rope only; harness and helmet buddy-checked.', post: 'Low', responsible: 'Instructor' },
      { desc: 'Equipment failure', pre: 'High', controls: 'Centre-inspected equipment only; visual pre-climb check by instructor; centre maintenance log reviewed.', post: 'Low', responsible: 'Centre staff' },
      { desc: 'Collision with climbers', pre: 'Medium', controls: 'Clear fall zone maintained; gym etiquette briefed; climber spacing supervised.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Sensory overload', pre: 'Medium', controls: 'Off-peak session booked where possible; quiet break area identified; noise-reducing headphones offered.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Anxiety at height', pre: 'Medium', controls: 'Readiness checked first; gradual exposure via the bouldering wall; support worker at the base; agreed exit plan.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Medical emergency', pre: 'High', controls: 'Medical/support plan reviewed first; First Aid Officer on site; medication carried; AED location known.', post: 'Low', responsible: 'First Aid Officer' },
      { desc: 'Hygiene — shared gear', pre: 'Low', controls: 'Hand sanitiser available; shared harnesses wiped down between users; own chalk bag where possible.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Overexertion / fatigue', pre: 'Medium', controls: 'Session paced with rest breaks; hydration available; stop early if fatigue shows.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Elopement in facility', pre: 'Medium', controls: 'Agreed supervision ratio kept; facility exits known; sign-in/out with reception.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Low supervision ratio', pre: 'Medium', controls: 'Support ratio confirmed against the plan before booking; qualified instructor always present.', post: 'Low', responsible: 'Coordinator' }
    ],
    notes: 'Confirm the exact venue, opening hours and induction requirement before each new participant’s first visit. All participants complete the centre’s induction on their first visit. Support worker to hold a current First Aid certificate. Review this assessment if the venue changes.'
  },

  {
    templateName: 'Rock Climbing (Outdoor)',
    activityName: 'Rock Climbing — Outdoor',
    location: 'Outdoor crag / natural rock face',
    duration: 'Half-day (4–6 hrs) incl. travel & set-up',
    hazards: {
      hazard_bio: [1, 4, 5],
      hazard_chem: [3],
      hazard_critical: [1, 2, 3, 4, 5],
      hazard_env: [1, 3, 4, 5, 6, 7],
      hazard_machinery: [3, 4],
      hazard_manual: [2, 4, 5],
      hazard_participant: [1, 2, 3, 4, 5, 6, 7, 8],
      hazard_people: [1, 2, 3, 4]
    },
    controls: [
      { desc: 'Fall from height (climbing)', pre: 'Extreme', controls: 'Qualified guide (min. Cert IV Outdoor Rec.) sets redundant top-rope anchors; harness/helmet buddy-checked; no lead climbing by participants.', post: 'Medium', responsible: 'Climbing guide' },
      { desc: 'Rockfall / falling debris', pre: 'High', controls: 'Helmets mandatory at base and on the rock; safe waiting zone clear of the fall line; guide inspects the route first.', post: 'Low', responsible: 'Climbing guide' },
      { desc: 'Remote / delayed response', pre: 'High', controls: 'PLB or satellite communicator carried where reception is unreliable; trip plan logged with the office; first aid kit on site.', post: 'Medium', responsible: 'Facilitator' },
      { desc: 'Heat / UV / dehydration', pre: 'High', controls: 'Reschedule if forecast exceeds 35°C; sunscreen, hats, min. 2L water per person; shaded rest area; monitor for heat stress.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Wildlife (snakes, insects)', pre: 'Medium', controls: 'Closed footwear mandatory; wildlife-awareness briefing; insect repellent; check for ticks after the session.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Uneven approach terrain', pre: 'Medium', controls: 'Approach walked at the participant’s pace; walking poles offered; sturdy footwear required; guide leads the route.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Severe weather', pre: 'High', controls: 'BOM forecast monitored before and during the session; pre-set weather-abort criteria and shelter/evacuation plan.', post: 'Low', responsible: 'Facilitator' },
      { desc: 'Equipment failure', pre: 'High', controls: 'Guide-supplied, regularly inspected climbing equipment only; pre-climb equipment check.', post: 'Low', responsible: 'Climbing guide' },
      { desc: 'Anxiety in remote setting', pre: 'Medium', controls: 'Readiness discussed first; graduated exposure; support worker stays at the base; agreed stop signal.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Vehicle transport to site', pre: 'Medium', controls: 'Roadworthy vehicle, seatbelts, licensed driver; trip plan logged; mobile phone charged.', post: 'Low', responsible: 'Driver' }
    ],
    notes: 'Confirm the exact site, access track and mobile reception before each session. Session is cancelled or rescheduled for severe weather, a total fire ban, or crag closure. The guide must hold a current outdoor recreation / climbing instructor qualification and NDIS Worker Screening Check.'
  },

  {
    templateName: 'Boxing Training',
    activityName: 'Boxing Training (non-contact, fitness)',
    location: 'Boxing gym / studio, or outdoor pad session',
    duration: '45–60 minutes',
    hazards: {
      hazard_bio: [1],
      hazard_chem: [4],
      hazard_critical: [1, 2, 3, 5],
      hazard_facility: [1, 2, 5],
      hazard_manual: [1, 4],
      hazard_participant: [1, 2, 3, 4, 5, 6, 7, 8],
      hazard_people: [1, 2, 3, 5]
    },
    controls: [
      { desc: 'Impact injury (pad/bag work)', pre: 'Medium', controls: 'Non-contact pad and bag work only — no participant sparring; correct technique taught before intensity increases.', post: 'Low', responsible: 'Boxing instructor' },
      { desc: 'Hand / wrist injury', pre: 'Medium', controls: 'Hand wraps and correctly fitted gloves every session; instructor checks technique and sizing.', post: 'Low', responsible: 'Boxing instructor' },
      { desc: 'Overexertion / cardiac strain', pre: 'Medium', controls: 'Medical/support plan and cardiac precautions reviewed first; warm-up/cool-down included; intensity matched to fitness.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Collision with equipment', pre: 'Medium', controls: 'Adequate spacing between stations; clear floor markings; rotation between activities supervised.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Behavioural escalation', pre: 'Medium', controls: 'Structured, instructor-led session with clear non-contact rules; support worker uses known de-escalation strategies.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Slips / trips on gym floor', pre: 'Low', controls: 'Clear walkways; equipment stored when not in use; appropriate athletic footwear.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Hygiene — shared gloves', pre: 'Low', controls: 'Shared gloves and pads wiped down between users; hand sanitiser available; own wraps where possible.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Medical emergency', pre: 'High', controls: 'Medical/support plan reviewed first; First Aid Officer present; inhaler/medication carried; contacts accessible.', post: 'Low', responsible: 'First Aid Officer' },
      { desc: 'Aggravating an old injury', pre: 'Medium', controls: 'Current injuries checked at the start of every session; exercises modified; instructor briefed on restrictions.', post: 'Low', responsible: 'Boxing instructor' },
      { desc: 'Low supervision ratio', pre: 'Medium', controls: 'Support ratio confirmed against the plan before booking; a qualified boxing instructor is present every session.', post: 'Low', responsible: 'Coordinator' }
    ],
    notes: 'Confirm the exact venue before booking. This is non-contact fitness boxing (pad and bag work) for therapeutic and fitness purposes. Sparring between participants is never permitted. Instructor to be briefed on each participant’s support needs before the session.'
  },

  {
    templateName: 'Mountain Biking',
    activityName: 'Mountain Biking',
    location: 'Purpose-built mountain bike trail / park',
    duration: '2–3 hours incl. bike fit & briefing',
    hazards: {
      hazard_bio: [1, 4, 5],
      hazard_chem: [3],
      hazard_critical: [1, 2, 3, 4, 5],
      hazard_env: [1, 3, 4, 5, 6],
      hazard_facility: [3],
      hazard_machinery: [3],
      hazard_manual: [4, 5],
      hazard_participant: [1, 2, 3, 4, 5, 6, 7, 8],
      hazard_people: [1, 2, 3, 5]
    },
    controls: [
      { desc: 'Fall from the bike', pre: 'High', controls: 'Trail matched to skill level (start on green trails); helmet mandatory; bike handling checked before riding.', post: 'Medium', responsible: 'Ride leader' },
      { desc: 'Collision with trail users', pre: 'Medium', controls: 'Low-traffic times/trails chosen; trail etiquette and right-of-way briefed; safe following distance kept.', post: 'Low', responsible: 'Ride leader' },
      { desc: 'Mechanical failure', pre: 'High', controls: 'Pre-ride ABC check (air, brakes, chain) on every bike; well-maintained hire/loan bikes only.', post: 'Low', responsible: 'Bike provider' },
      { desc: 'Remote trail / delayed response', pre: 'Medium', controls: 'Group riding with a known trail map and exit points; mobile phone carried; first aid kit in the support vehicle.', post: 'Low', responsible: 'Ride leader' },
      { desc: 'Heat exposure / dehydration', pre: 'Medium', controls: 'Water carried by every rider; scheduled shade breaks; avoid peak-heat riding; sunscreen applied at trailhead.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Uneven terrain / obstacles', pre: 'High', controls: 'Trail graded for the group; leader scouts conditions first; riders can walk any section beyond comfort level.', post: 'Medium', responsible: 'Ride leader' },
      { desc: 'Wildlife / insects', pre: 'Low', controls: 'Insect repellent; wildlife-awareness briefing; closed-toe shoes and long pants recommended.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Fatigue affecting control', pre: 'Medium', controls: 'Ride distance matched to fitness; regular rest stops; route shortened if signs of fatigue appear.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Medical emergency on trail', pre: 'High', controls: 'Medical/support plan reviewed before riding; First Aid Officer in group; nearest vehicle access known.', post: 'Low', responsible: 'First Aid Officer' },
      { desc: 'Poorly fitted bike', pre: 'Medium', controls: 'Bike sized and adjusted for each participant before departure; helmet correctly fitted.', post: 'Low', responsible: 'Bike provider' }
    ],
    notes: 'Confirm the trail grade suits the participant’s skill level before booking. Helmets are mandatory at all times while riding. Trail difficulty is matched to the least experienced rider in the group. Consider an e-bike or tag-along option for participants with reduced physical capacity.'
  },

  {
    templateName: 'Swimming',
    activityName: 'Swimming',
    location: 'Public swimming pool or a patrolled beach',
    duration: '1–1.5 hours',
    hazards: {
      hazard_bio: [1, 2, 5],
      hazard_chem: [4],
      hazard_critical: [1, 2, 3, 4, 5],
      hazard_env: [1, 2, 3, 4, 7],
      hazard_facility: [6],
      hazard_manual: [5],
      hazard_participant: [1, 2, 3, 4, 5, 6, 7, 8],
      hazard_people: [1, 2, 3, 5]
    },
    controls: [
      { desc: 'Drowning / submersion', pre: 'Extreme', controls: 'Min. 1:1 in-water supervision for non-swimmers/seizure-risk participants; worker within arm’s reach; lifeguard on duty confirmed first.', post: 'Medium', responsible: 'Lifeguard' },
      { desc: 'Seizure in the water', pre: 'Extreme', controls: 'Seizure history reviewed before every session; 1:1 in-water supervision for at-risk participants; lifeguard briefed.', post: 'Medium', responsible: 'Support worker' },
      { desc: 'Slips on wet deck', pre: 'Medium', controls: '"Walk, don’t run" reinforced; non-slip footwear to and from pool edge; assistance on wet surfaces as needed.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Sun exposure (outdoor)', pre: 'Medium', controls: 'Sunscreen applied before entry; rash vest/sun shirt encouraged; shaded rest area between activities.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Rip currents (beach only)', pre: 'High', controls: 'Swim only between patrolled flags at a surf-lifesaving beach; check daily conditions; no entry if flags are closed.', post: 'Medium', responsible: 'Surf lifesaver' },
      { desc: 'Recreational water illness', pre: 'Low', controls: 'Participants with wounds, gastro symptoms or a contagious condition do not enter the pool; shower before entering.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Panic / anxiety in water', pre: 'Medium', controls: 'Gradual entry at the participant’s pace; worker close by; agreed exit signal; never left alone in or near water.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Entrapment (drains, ladders)', pre: 'Medium', controls: 'Pools with compliant drain covers only; supervise near ladders/steps; no unsupervised plant-room access.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Transfers for reduced mobility', pre: 'Medium', controls: 'Pool hoist, ramp or steps used as appropriate; manual handling plan followed; two-person assist where required.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Low supervision ratio', pre: 'High', controls: '1:1 in-water supervision confirmed before booking; worker never exceeds the ratio agreed in the participant’s plan.', post: 'Medium', responsible: 'Coordinator' }
    ],
    notes: 'Confirm venue and lifeguard/patrol coverage before booking. Every participant’s swimming ability and any medical history relevant to water safety must be confirmed before the first session and reviewed regularly. Support workers supervising in water should hold current water-safety awareness training. Never leave a participant unattended in or near water.'
  },

  {
    templateName: 'Bush Walking',
    activityName: 'Bush Walking',
    location: 'Local national park / bushland trail',
    duration: '2–4 hours including breaks',
    hazards: {
      hazard_bio: [1, 4, 5],
      hazard_chem: [3],
      hazard_critical: [1, 2, 3, 4, 5],
      hazard_env: [1, 3, 4, 5, 6, 7],
      hazard_machinery: [3],
      hazard_manual: [4, 5],
      hazard_participant: [1, 2, 3, 4, 5, 6, 7, 8],
      hazard_people: [1, 2, 3, 4]
    },
    controls: [
      { desc: 'Slips, trips and falls', pre: 'Medium', controls: 'Trail grade matched to mobility and experience; sturdy enclosed footwear required; walking poles offered.', post: 'Low', responsible: 'Walk leader' },
      { desc: 'Lost / separated from group', pre: 'Medium', controls: 'Head count at start, rest stops and finish; buddy system; leader carries a map/GPS; stay on the marked trail.', post: 'Low', responsible: 'Walk leader' },
      { desc: 'Heat exposure / dehydration', pre: 'High', controls: 'Min. 1.5–2L water per person; scheduled shaded breaks; sunscreen and hat; reschedule on extreme-heat days.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Severe weather / lightning', pre: 'High', controls: 'BOM forecast checked before departure; pre-set turn-back criteria; nearest shelter/vehicle access known.', post: 'Low', responsible: 'Walk leader' },
      { desc: 'Creek crossing / wet rocks', pre: 'High', controls: 'Crossings avoided after rain if fast-flowing or above knee height; participants assisted; alternative route ready.', post: 'Medium', responsible: 'Walk leader' },
      { desc: 'Wildlife (snakes, ticks)', pre: 'Medium', controls: 'Stay on the marked trail; insect repellent; closed footwear; check for ticks after the walk; snake-bite first aid known.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Remote / delayed response', pre: 'Medium', controls: 'First aid kit and charged phone (or PLB) carried; trip plan and return time logged with the office.', post: 'Low', responsible: 'Walk leader' },
      { desc: 'Fatigue / overexertion', pre: 'Medium', controls: 'Distance and terrain matched to fitness; regular rest stops; option to turn back early.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Sensory response to bush', pre: 'Medium', controls: 'Environment and sensory triggers discussed before the walk; pace and route kept flexible.', post: 'Low', responsible: 'Support worker' },
      { desc: 'Medical emergency on trail', pre: 'High', controls: 'Medical/support plan reviewed before departure; First Aid Officer in group; vehicle access known.', post: 'Low', responsible: 'First Aid Officer' }
    ],
    notes: 'Confirm trail grade and length before booking. Walk leader to check trail conditions and closures (e.g. via the National Parks alert system) before every session. Group size kept small enough that the agreed supervision ratio can be maintained at all times on the trail.'
  }
];

// ── Run ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Organisation: ${orgId}${dryRun ? '  (dry run — no writes)' : ''}`);
  ensureOrgActivityRiskTemplates(orgId);

  if (pdfOutDir && !existsSync(pdfOutDir)) mkdirSync(pdfOutDir, { recursive: true });

  for (const spec of ACTIVITIES) {
    const existingTemplates = listActivityRiskTemplates(orgId);
    let template = existingTemplates.find(
      (t) => t.activity_name.toLowerCase().trim() === spec.templateName.toLowerCase().trim()
    );

    if (!template) {
      if (dryRun) {
        console.log(`[dry-run] would create template "${spec.templateName}"`);
        template = { id: 'DRY-RUN', activity_name: spec.templateName };
      } else {
        template = createActivityRiskTemplate(orgId, spec.templateName);
        console.log(`Created template "${spec.templateName}" (${template.id})`);
      }
    } else {
      console.log(`Template "${spec.templateName}" already exists (${template.id})`);
    }

    const fieldValues = buildFieldValues(spec);

    if (dryRun) {
      console.log(`[dry-run] would fill ${Object.keys(fieldValues).length} fields for "${spec.templateName}"`);
      continue;
    }

    const record = createActivityRiskRecord(orgId, template.id, { title: spec.activityName });
    const updated = updateActivityRiskRecord(orgId, record.id, {
      title: spec.activityName,
      field_values: fieldValues
    });
    console.log(
      `  Record ${updated.id} — "${updated.title}" — ${Object.keys(fieldValues).length} fields set` +
        (updated.is_complete === false ? '' : '')
    );

    if (pdfOutDir) {
      const buffer = await generateActivityRiskRecordPdfBuffer(orgId, updated.id);
      const outPath = join(pdfOutDir, `${spec.templateName.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-')}.pdf`);
      writeFileSync(outPath, buffer);
      console.log(`  Preview PDF -> ${outPath}`);
    }
  }

  console.log('\nDone. Open Activity Risk Assessments in the app to review, sign, and assign to participants.');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
