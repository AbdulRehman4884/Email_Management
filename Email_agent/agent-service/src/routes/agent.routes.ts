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
import { chat, confirm, cancel } from "../controllers/agent.controller.js";

const router = Router();

router.post("/chat",    chat);
router.post("/confirm", confirm);
router.post("/cancel",  cancel);

export { router as agentRouter };
