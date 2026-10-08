/**
 * src/routes/scripts.routes.ts
 *
 * On-demand script generation for one saved company (requireAuth is applied
 * where this router is mounted).
 *
 *   POST /api/agent/scripts/companies/:companyId/generate
 *     body: { type: "cold_email" | "cold_call" | "linkedin", regenerate?: boolean }
 *
 * A saved script is returned without any AI call unless regenerate is true.
 * The backend enforces ownership through the user's own token.
 */

import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { sendFailure, sendSuccess } from "../lib/apiResponse.js";
import { ErrorCode, ValidationError } from "../lib/errors.js";
import {
  SCRIPT_TYPES,
  ScriptGenerationError,
  generateScript,
} from "../services/scriptGeneration.service.js";

const router = Router();

const bodySchema = z.object({
  type:       z.enum(SCRIPT_TYPES as [string, ...string[]]),
  regenerate: z.boolean().optional(),
});

router.post("/companies/:companyId/generate", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = Number(req.params.companyId);
    if (!Number.isInteger(companyId) || companyId < 1) {
      throw new ValidationError("Invalid companyId");
    }
    const body = bodySchema.safeParse(req.body);
    if (!body.success) throw new ValidationError("Invalid request body", body.error.flatten());

    const auth = req.authContext!;
    const result = await generateScript(
      companyId,
      body.data.type as (typeof SCRIPT_TYPES)[number],
      auth,
      { regenerate: body.data.regenerate === true },
    );
    sendSuccess(res, result);
  } catch (err) {
    if (err instanceof ScriptGenerationError) {
      sendFailure(res, err.status, err.status === 404 ? ErrorCode.NOT_FOUND : ErrorCode.INTERNAL_ERROR, err.message);
      return;
    }
    next(err);
  }
});

export { router as scriptsRouter };
