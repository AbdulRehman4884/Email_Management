import { Router } from "express";
import {
  cancelFollowUpJob,
  createFollowUpJob,
  getFollowUpAnalytics,
  getFollowUpJobAnalyticsById,
  listFollowUpJobs,
  previewFollowUpJobCount,
  stopFollowUpJob,
} from "../controllers/followUpJobController";

const app = Router();

app.post("/follow-up-jobs", createFollowUpJob);
app.get("/follow-up-jobs", listFollowUpJobs);
app.get("/follow-up-jobs/preview-count", previewFollowUpJobCount);
app.delete("/follow-up-jobs/:id", cancelFollowUpJob);
app.post("/follow-up-jobs/:id/stop", stopFollowUpJob);
app.get("/follow-up-analytics", getFollowUpAnalytics);
app.get("/follow-up-analytics/jobs/:id", getFollowUpJobAnalyticsById);

export default app;
