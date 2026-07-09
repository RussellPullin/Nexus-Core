#!/usr/bin/env node
/**
 * Regenerate the generic (unbranded) activity risk assessment master PDF.
 * Run: node server/scripts/regenerate-activity-risk-master.mjs
 */
import { writeGenericActivityRiskMaster, bundledMasterPath } from '../src/services/activityRiskAssessmentPdf.service.js';
import { clearActivityRiskFieldSchemaCache } from '../src/services/activityRiskAssessments.service.js';

const target = bundledMasterPath();
const buf = await writeGenericActivityRiskMaster(target);
clearActivityRiskFieldSchemaCache();
console.log(`Wrote ${buf.length} bytes to ${target}`);
