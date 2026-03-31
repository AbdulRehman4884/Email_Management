/**
 * src/middleware/auth.ts
 *
 * JWT authentication middleware.
 * Verifies the Authorization: Bearer <token> header against JWT_SECRET,
 * extracts userId and email from the payload, and attaches an AuthContext
 * to req.authContext for downstream handlers.
 *
 * Security rules:
 *  - The raw token is stored in authContext.rawToken for forwarding to MCP
 *  - userId is ALWAYS resolved from the JWT — never from request body/params
 *  - Token is never logged
 */

import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { createLogger } from "../lib/logger.js";
import { AuthError, ErrorCode } from "../lib/errors.js";
import { sendFailure } from "../lib/apiResponse.js";
import { asUserId, type AuthContext } from "../types/common.js";

const log = createLogger("auth");

interface JwtPayload {
  sub: string;
  email?: string;
  iat?: number;
  exp?: number;
}

/**
 * Verifies the JWT and attaches AuthContext to the request.
 * Responds with 401 on any auth failure.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    sendFailure(res, 401, ErrorCode.AUTH_MISSING_TOKEN, "Authorization header required");
    return;
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer" || !parts[1]) {
    sendFailure(res, 401, ErrorCode.AUTH_INVALID_TOKEN, "Authorization header must be Bearer <token>");
    return;
  }

  const rawToken = parts[1];

  try {
    const payload = jwt.verify(rawToken, env.JWT_SECRET) as JwtPayload;

    if (!payload.sub) {
      throw new AuthError(ErrorCode.AUTH_INVALID_TOKEN, "JWT missing sub claim");
    }

    const authContext: AuthContext = {
      userId: asUserId(payload.sub),
      email: payload.email,
      rawToken,
    };

    req.authContext = authContext;

    log.debug(
      { requestId: req.requestId, userId: payload.sub },
      "Auth context resolved",
    );

    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      sendFailure(res, 401, ErrorCode.AUTH_EXPIRED_TOKEN, "Token expired");
      return;
    }
    if (err instanceof jwt.JsonWebTokenError) {
      sendFailure(res, 401, ErrorCode.AUTH_INVALID_TOKEN, "Invalid token");
      return;
    }
    // Re-throw unexpected errors to the global error handler
    next(err);
  }
}
