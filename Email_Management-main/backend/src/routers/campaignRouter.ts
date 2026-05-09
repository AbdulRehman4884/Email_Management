import { 
    createCampaign, 
    getAllCampaigns, 
    getCampaignStats, 
    getCampaignById,
    patchCampaignFollowUpSettings,
    updateCampaign,
    deleteCampaign,
    startCampaign,
    pauseCampaign,
    resumeCampaign,
    uploadRecipientsCSV,
    getRecipients,
    getDashboardStats,
    markRecipientReplied,
    deleteRecipient,
    validatePlaceholders,
    getSentEmails,
    sendFollowUpEmail
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
app.get("/campaigns/sent-emails", getSentEmails);
app.get("/campaigns/:id", getCampaignById);
app.patch("/campaigns/:id/follow-up-settings", patchCampaignFollowUpSettings);
app.put("/campaigns/:id", updateCampaign);
app.delete("/campaigns/:id", deleteCampaign);

// Campaign actions
app.post("/campaigns/:id/start", startCampaign);
app.post("/campaigns/:id/pause", pauseCampaign);
app.post("/campaigns/:id/resume", resumeCampaign);
app.get("/campaigns/:id/validate-placeholders", validatePlaceholders);

// Campaign stats
app.get("/campaigns/:id/stats", getCampaignStats);

// Recipients
app.post("/campaigns/:id/recipients/upload", upload.single('file'), uploadRecipientsCSV);
app.get("/campaigns/:id/recipients", getRecipients);
app.post("/campaigns/:id/recipients/:recipientId/mark-replied", markRecipientReplied);
app.post("/campaigns/:id/recipients/:recipientId/follow-up", sendFollowUpEmail);
app.delete("/campaigns/:id/recipients/:recipientId", deleteRecipient);

export default app;