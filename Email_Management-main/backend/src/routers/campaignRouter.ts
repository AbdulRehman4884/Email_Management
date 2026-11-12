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
    getRecipientById,
    getDashboardStats,
    getBestSendTime,
    markRecipientReplied,
    deleteRecipient,
    deleteAllRecipients,
    validatePlaceholders,
    getSentEmails,
    sendFollowUpEmail
} from "../controllers/campaignController";

import { Router } from "express";
import multer from "multer";

const upload = multer({ storage: multer.memoryStorage() });
const app = Router()

// N-23: a non-numeric campaign id is a client error (400), not a database cast error (500).
app.param('id', (req, res, next, value) => {
    if (!/^\d+$/.test(String(value)) || Number(value) < 1) {
        return res.status(400).json({ error: 'Invalid campaign id' });
    }
    next();
});

// Dashboard
app.get("/dashboard/stats", getDashboardStats);
app.get("/dashboard/best-send-time", getBestSendTime);

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
app.get("/campaigns/:id/recipients/:recipientId", getRecipientById);
app.post("/campaigns/:id/recipients/:recipientId/mark-replied", markRecipientReplied);
app.post("/campaigns/:id/recipients/:recipientId/follow-up", sendFollowUpEmail);
app.delete("/campaigns/:id/recipients/:recipientId", deleteRecipient);
app.delete("/campaigns/:id/recipients", deleteAllRecipients);

export default app;