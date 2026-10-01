/**
 * src/routes/index.ts
 *
 * Mounts all route groups under their canonical prefixes.
 * Import this single router in app.ts.
 */

import { Router } from "express";
import { healthRouter } from "./health.routes.js";
import { agentRouter } from "./agent.routes.js";
import { scriptsRouter } from "./scripts.routes.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.use("/health", healthRouter);

// All agent routes require a valid JWT.
// Mounted before /api/agent so requests don't pass through requireAuth twice.
router.use("/api/agent/scripts", requireAuth, scriptsRouter);
router.use("/api/agent", requireAuth, agentRouter);

export { router as appRouter };
