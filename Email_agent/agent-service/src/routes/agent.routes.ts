/**
 * src/routes/agent.routes.ts
 *
 * Agent API routes — all endpoints require a valid JWT (requireAuth middleware
 * is applied at the router level in src/routes/index.ts).
 *
 *   POST /api/agent/chat    — submit a user message
 *   POST /api/agent/confirm — confirm a pending risky action
 *   POST /api/agent/cancel  — cancel a pending risky action
 */

import { Router } from "express";
import multer from "multer";
import { chat, confirm, cancel } from "../controllers/agent.controller.js";
import { agentFileFilter } from "../lib/agentFileFilter.js";

const router = Router();

// memory storage — file is accessible as req.file.buffer (no disk I/O)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: agentFileFilter,
});

router.post("/chat",    upload.single("file"), chat);
router.post("/confirm", confirm);
router.post("/cancel",  cancel);

export { router as agentRouter };
