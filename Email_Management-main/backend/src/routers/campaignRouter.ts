import {
    createCampaign,
    getAllCampaigns,
    getCampaignStats,
    getCampaignById,
    updateCampaign,
    deleteCampaign,
    startCampaign,
    pauseCampaign,
    resumeCampaign,
    uploadRecipientsCSV,
    saveRecipientsBulk,
    getRecipients,
    getDashboardStats,
    markRecipientReplied,
    markRecipientBounced,
    deleteRecipient,
    getRecipientCount,
    saveAiCampaignPrompt,
    generatePersonalizedEmails,
    getPersonalizedEmails,
    getSequenceProgress,
    getPendingFollowUps,
    getRecipientSequenceHistory,
} from "../controllers/campaignController";

import { Router } from "express";
import multer from "multer";

const upload = multer({ storage: multer.memoryStorage() });
const app = Router()

// Dashboard
app.get("/dashboard/stats", getDashboardStats);

// Campaign CRUD
app.post("/campaigns", createCampaign);
app.get("/campaigns", getAllCampaigns);
app.get("/campaigns/:id", getCampaignById);
app.put("/campaigns/:id", updateCampaign);
app.delete("/campaigns/:id", deleteCampaign);

// Campaign actions
app.post("/campaigns/:id/start", startCampaign);
app.post("/campaigns/:id/pause", pauseCampaign);
app.post("/campaigns/:id/resume", resumeCampaign);

// Campaign stats
app.get("/campaigns/:id/stats", getCampaignStats);

// Recipients
app.post("/campaigns/:id/recipients/upload", upload.single('file'), uploadRecipientsCSV);
app.post("/campaigns/:id/recipients/bulk", saveRecipientsBulk);
app.get("/campaigns/:id/recipients", getRecipients);
app.post("/campaigns/:id/recipients/:recipientId/mark-replied", markRecipientReplied);
app.post("/campaigns/:id/recipients/mark-replied", markRecipientReplied);
app.post("/campaigns/:id/recipients/:recipientId/mark-bounced", markRecipientBounced);
app.post("/campaigns/:id/recipients/mark-bounced", markRecipientBounced);
app.get("/campaigns/:id/sequence-progress", getSequenceProgress);
app.get("/campaigns/:id/pending-follow-ups", getPendingFollowUps);
app.get("/campaigns/:id/recipients/:recipientId/touch-history", getRecipientSequenceHistory);
app.get("/campaigns/:id/recipients/touch-history", getRecipientSequenceHistory);
app.delete("/campaigns/:id/recipients/:recipientId", deleteRecipient);

// Phase 1: AI Campaign
app.get("/campaigns/:id/recipient-count", getRecipientCount);
app.post("/campaigns/:id/ai-prompt", saveAiCampaignPrompt);
app.post("/campaigns/:id/generate-personalized", generatePersonalizedEmails);
app.get("/campaigns/:id/personalized-emails", getPersonalizedEmails);

export default app;