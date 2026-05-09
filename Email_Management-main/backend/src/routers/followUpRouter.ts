import { Router } from "express";
import {
  cancelFollowUpJob,
  createFollowUpJob,
  getFollowUpAnalytics,
  listFollowUpJobs,
  previewFollowUpJobCount,
} from "../controllers/followUpJobController";

const app = Router();

app.post("/follow-up-jobs", createFollowUpJob);
app.get("/follow-up-jobs", listFollowUpJobs);
app.get("/follow-up-jobs/preview-count", previewFollowUpJobCount);
app.delete("/follow-up-jobs/:id", cancelFollowUpJob);
app.get("/follow-up-analytics", getFollowUpAnalytics);

export default app;
