/**
 * src/controllers/health.controller.ts
 *
 * Liveness and readiness health probes.
 *
 * GET /health       — liveness: is the process running?
 * GET /health/ready — readiness: are all dependencies reachable?
 */

import type { Request, Response } from "express";
import { sendSuccess } from "../lib/apiResponse.js";
import { SERVICE_NAME, SERVICE_VERSION } from "../config/constants.js";

export interface HealthData {
  status: "ok";
  service: string;
  version: string;
  uptime: number;
  timestamp: string;
}

export interface ReadinessData {
  status: "ok" | "degraded";
  checks: Record<string, "ok" | "fail">;
}

/** GET /health — liveness probe */
export function getLiveness(_req: Request, res: Response): void {
  const data: HealthData = {
    status: "ok",
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };
  sendSuccess(res, data);
}

/** GET /health/ready — readiness probe */
export function getReadiness(_req: Request, res: Response): void {
  // Phase 1: simple check — expand in later phases to probe MCP, LLM connectivity
  const data: ReadinessData = {
    status: "ok",
    checks: {
      process: "ok",
    },
  };
  sendSuccess(res, data);
}
