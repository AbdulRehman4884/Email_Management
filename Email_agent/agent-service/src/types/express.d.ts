/**
 * src/types/express.d.ts
 *
 * Augments Express's Request interface with agent-service-specific properties
 * injected by middleware before route handlers run.
 */

import type { AuthContext, RequestId } from "./common.js";

declare global {
  namespace Express {
    interface Request {
      /** Unique identifier for this HTTP request — injected by requestLogger middleware */
      requestId: RequestId;

      /** Resolved auth context — injected by auth middleware on protected routes */
      authContext?: AuthContext;
    }
  }
}

export {};
