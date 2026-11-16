import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { ACCESS_COOKIE, readCookie } from '../lib/authCookies.js';
import { csrfProblem } from './csrf.js';

const JWT_SECRET = process.env.JWT_SECRET;
// N-17: short-lived access tokens (was 7d). Sessions last longer through the rotating refresh cookie.
// The AI agent verifies these same tokens; it gets a fresh one with every request from the web app.
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '15m';

export interface JwtPayload {
  userId: number;
  email: string;
  role: string;
}

export interface AuthUser {
  id: number;
  email: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      /** How the request was authenticated (N-07). */
      authVia?: 'bearer' | 'cookie';
    }
  }
}

/**
 * Accepts, in this order:
 *   1. Authorization: Bearer <jwt>  (unchanged: AI agent, MCP server, scripts, older web builds; no CSRF check)
 *   2. the HttpOnly mf_at cookie    (N-07: the web app; CSRF-checked for state-changing requests)
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  let token: string | null = null;
  let via: 'bearer' | 'cookie' = 'bearer';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else {
    token = readCookie(req, ACCESS_COOKIE);
    via = 'cookie';
  }
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!JWT_SECRET) {
    console.error('JWT_SECRET is not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }
  let decoded: JwtPayload;
  try {
    decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (via === 'cookie') {
    const problem = csrfProblem(req);
    if (problem) return res.status(403).json({ error: problem, code: 'CSRF' });
  }
  req.user = { id: decoded.userId, email: decoded.email, role: decoded.role };
  req.authVia = via;
  next();
}

/** Bearer-only variant (legacy session upgrade): never authenticates from a cookie. */
export function bearerOnlyAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return authMiddleware(req, res, next);
}

export function signToken(payload: JwtPayload): string {
  if (!JWT_SECRET) throw new Error('JWT_SECRET is not set');
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions);
}

/** Milliseconds until a token signed by signToken() expires (for the mf_at cookie Max-Age). */
export function tokenMaxAgeMs(token: string): number {
  const decoded = jwt.decode(token) as { exp?: number } | null;
  return decoded?.exp ? Math.max(0, decoded.exp * 1000 - Date.now()) : 15 * 60 * 1000;
}
