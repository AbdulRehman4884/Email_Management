import { Router } from "express";
import multer from "multer";
import {
  approveBulkTemplates,
  bulkApproveTemplateStatuses,
  configureBulkTemplateStrategy,
  getBulkStatus,
  listBulkTemplates,
  repairBulkCampaignReadiness,
  regenerateBulkTemplate,
  retryBulkJob,
  updateBulkTemplate,
  uploadBulkFile,
  uploadBulkRows,
} from "../controllers/bulkController.js";
import { templateOptions } from "../lib/templateInjectionEngine.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const app = Router();

app.post("/upload", upload.single("file"), uploadBulkFile);
app.post("/manual-rows", uploadBulkRows);
app.get("/template-options", (_req, res) => res.json({ options: templateOptions() }));
app.post("/template-strategy/:jobId", configureBulkTemplateStrategy);
app.get("/status/:jobId", getBulkStatus);
app.post("/retry/:jobId", retryBulkJob);
app.get("/templates/:jobId", listBulkTemplates);
app.put("/templates/:templateId", updateBulkTemplate);
app.post("/templates/:templateId/regenerate", regenerateBulkTemplate);
app.post("/templates/approve/:jobId", bulkApproveTemplateStatuses);
app.post("/approve/:jobId", approveBulkTemplates);
app.post("/campaign-readiness/:campaignId", repairBulkCampaignReadiness);

export default app;
