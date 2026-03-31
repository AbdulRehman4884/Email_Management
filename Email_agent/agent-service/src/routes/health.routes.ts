/**
 * src/routes/health.routes.ts
 *
 * Health probe routes — no auth required.
 */

import { Router } from "express";
import { getLiveness, getReadiness } from "../controllers/health.controller.js";

const router = Router();

router.get("/", getLiveness);
router.get("/ready", getReadiness);

export { router as healthRouter };
