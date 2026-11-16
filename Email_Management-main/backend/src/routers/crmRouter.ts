import { Router } from 'express';
import { relabelRepliesHandler } from '../controllers/crmController.js';
import {
  listTemplates,
  listPipelines,
  getPipeline,
  createPipeline,
  updatePipeline,
  deletePipeline,
  getStages,
  createStage,
  updateStage,
  reorderStages,
  deleteStage,
  getRules,
  createRule,
  updateRule,
  deleteRule,
  testRules,
  lookupContacts,
  listTags,
} from '../controllers/crmPipelineController.js';
import {
  campaignTagMap,
  campaignCrmSummary,
  saveCampaignSettings,
  listContacts,
  getContact,
  addContactTag,
  removeContactTag,
  bulkUpdateContacts,
} from '../controllers/crmTagController.js';
import {
  getCrmSettings,
  saveCrmSettings,
  listNeedsReply,
  snoozeContact,
  markContactDone,
} from '../controllers/crmNeedsReplyController.js';
import { getScoring, saveScoring, startRecalculation, getRecalculation } from '../controllers/crmScoringController.js';
import { moveContactStage, getSummary, exportContactsCsv } from '../controllers/crmDashboardController.js';
import { listSites, createSite, updateSite, deleteSite } from '../controllers/crmSitesController.js';
import { listForms, getForm, createForm, updateForm, deleteForm, listSubmissions, exportSubmissionsCsv } from '../controllers/crmFormsController.js';
import { webTablesReady } from '../lib/crm/webTracking.js';
import {
  listAutomationTemplates,
  listAutomations,
  getAutomation,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  listAutomationRuns,
  listCallsToMake,
  listRunEvents,
  postCallResult,
  postStopRun,
  postSendNow,
  getCampaignAutomation,
  setCampaignAutomation,
  postAiWrite,
} from '../controllers/crmAutomationsController.js';

/** Mounted at /api/crm (auth + crmEnabled plan check in index.ts). */
const router = Router();

// Step 10: lead filters and KPIs read website data only once migration 0037 is applied.
router.use((_req, _res, next) => {
  webTablesReady().catch(() => false).then(() => next());
});

// Step 2
router.post('/relabel', relabelRepliesHandler);

// Step 4: Pipeline Builder
router.get('/pipeline-templates', listTemplates);
router.get('/pipelines', listPipelines);
router.post('/pipelines', createPipeline);
router.get('/pipelines/:id', getPipeline);
router.patch('/pipelines/:id', updatePipeline);
router.delete('/pipelines/:id', deletePipeline);

router.get('/pipelines/:id/stages', getStages);
router.post('/pipelines/:id/stages', createStage);
router.patch('/pipelines/:id/stages/reorder', reorderStages); // before /:stageId
router.patch('/pipelines/:id/stages/:stageId', updateStage);
router.delete('/pipelines/:id/stages/:stageId', deleteStage);

router.get('/pipelines/:id/rules', getRules);
router.post('/pipelines/:id/rules/test', testRules); // before /:ruleId
router.post('/pipelines/:id/rules', createRule);
router.patch('/pipelines/:id/rules/:ruleId', updateRule);
router.delete('/pipelines/:id/rules/:ruleId', deleteRule);

router.get('/contacts/lookup', lookupContacts);
router.get('/tags', listTags);

// Step 5: tags on campaigns and leads
router.get('/campaign-tags', campaignTagMap);
router.get('/campaigns/:id', campaignCrmSummary);
router.put('/campaigns/:id/settings', saveCampaignSettings);
router.get('/contacts', listContacts);
router.get('/contacts/export', exportContactsCsv); // step 8, before /contacts/:id
router.post('/contacts/bulk', bulkUpdateContacts); // before /contacts/:id
router.get('/contacts/:id', getContact); // /contacts/lookup is declared above
router.post('/contacts/:id/tags/:tagId', addContactTag);
router.delete('/contacts/:id/tags/:tagId', removeContactTag);

// Step 6: needs-reply reminders
router.get('/settings', getCrmSettings);
router.put('/settings', saveCrmSettings);
router.get('/needs-reply', listNeedsReply);
router.post('/contacts/:id/snooze', snoozeContact);
router.post('/contacts/:id/needs-reply/done', markContactDone);

// Step 7: lead scoring
router.get('/scoring', getScoring);
router.put('/scoring', saveScoring);
router.post('/scoring/recalculate', startRecalculation);
router.get('/scoring/recalculate', getRecalculation);

// Step 8: CRM dashboard
router.get('/summary', getSummary);
router.patch('/contacts/:id/stage', moveContactStage);

// Step 10: website tracking
router.get('/sites', listSites);
router.post('/sites', createSite);
router.patch('/sites/:id', updateSite);
router.delete('/sites/:id', deleteSite);

// Step 10: lead capture forms
router.get('/forms', listForms);
router.post('/forms', createForm);
router.get('/forms/:id', getForm);
router.patch('/forms/:id', updateForm);
router.delete('/forms/:id', deleteForm);
router.get('/forms/:id/submissions', listSubmissions);
router.get('/forms/:id/submissions/export', exportSubmissionsCsv);

// Lead automations (migration 0040)
router.get('/automation-templates', listAutomationTemplates);
router.get('/automations', listAutomations);
router.post('/automations', createAutomation);
router.get('/automations/:id', getAutomation);
router.patch('/automations/:id', updateAutomation);
router.delete('/automations/:id', deleteAutomation);
router.get('/automations/:id/runs', listAutomationRuns);
router.get('/automation-calls', listCallsToMake);
router.get('/automation-runs/:runId/events', listRunEvents);
router.post('/automation-runs/:runId/call-result', postCallResult);
router.post('/automation-runs/:runId/stop', postStopRun);
router.post('/automation-runs/:runId/send-now', postSendNow);
// Campaign automations (migration 0041)
router.get('/campaigns/:id/automation', getCampaignAutomation);
router.put('/campaigns/:id/automation', setCampaignAutomation);
router.post('/automation-ai/write', postAiWrite);

export default router;
