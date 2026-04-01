/**
 * src/server.ts
 *
 * Creates and exports the FastMCP server instance.
 *
 * Responsibilities:
 *  - Instantiate FastMCP with server metadata
 *  - Attach all MCP tools via the tool registry (wired in Phase 7)
 *  - Expose a typed `startServer()` function consumed by src/index.ts
 *
 * This file does NOT import env directly — it receives transport config
 * as typed parameters so it remains independently testable.
 */

import { SERVER_NAME, SERVER_VERSION } from "./config/constants.js";
import { createLogger } from "./lib/logger.js";
import { env } from "./config/env.js";

const log = createLogger("server");

// ── Server instance ───────────────────────────────────────────────────────────

/**
 * Fully configured FastMCP singleton — created by mcp/bootstrap/createServer.ts.
 * Importing this module triggers tool registration as a side effect.
 */
import { mcpServer } from "./mcp/bootstrap/createServer.js";
export { mcpServer };

// ── Start ─────────────────────────────────────────────────────────────────────

export interface ServerStartOptions {
  transportType: "sse" | "stdio";
  sse?: {
    port: number;
    endpoint: string;
  };
}

/**
 * Starts the MCP server with the given transport configuration.
 * Logs startup info and attaches a health endpoint when using SSE.
 */
export async function startServer(options: ServerStartOptions): Promise<void> {
  const { transportType } = options;

  log.info(
    { transport: transportType, port: options.sse?.port },
    `Starting ${SERVER_NAME} v${SERVER_VERSION}`,
  );

  if (transportType === "sse") {
    if (!options.sse) {
      throw new Error("SSE transport requires sse options (port, endpoint)");
    }

    const { port, endpoint } = options.sse;

    await new Promise<void>((resolve, reject) => {
      process.once("uncaughtException", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          reject(
            new Error(
              `Port ${port} is already in use. ` +
              `Set a different MCP_SSE_PORT in .env and restart.`,
            ),
          );
        } else {
          log.error({ err }, "Uncaught exception during SSE server startup");
          reject(err);
        }
      });

      mcpServer
        .start({ transportType: "sse", sse: { port, endpoint: endpoint.startsWith("/") ? (endpoint as `/${string}`) : `/${endpoint}` } })
        .then(resolve)
        .catch((err: unknown) => {
          log.error({ err }, "FastMCP SSE server failed to start — check @modelcontextprotocol/sdk compatibility");
          reject(err);
        });
    });

    log.info({ port, endpoint }, "MCP server listening over SSE");
  } else {
    await mcpServer.start({ transportType: "stdio" });
    log.info("MCP server listening over stdio");
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function buildShutdownHandler(signal: string): () => void {
  return () => {
    log.info({ signal }, "Shutdown signal received — stopping MCP server");
    // FastMCP does not expose an explicit stop() in v1; process exit is sufficient
    // for stdio. For SSE the HTTP server will be torn down by Node's process exit.
    process.exit(0);
  };
}

process.on("SIGTERM", buildShutdownHandler("SIGTERM"));
process.on("SIGINT", buildShutdownHandler("SIGINT"));

// ── Re-export env-derived default options (convenience) ───────────────────────

export function buildStartOptionsFromEnv(): ServerStartOptions {
  if (env.MCP_TRANSPORT === "stdio") {
    return { transportType: "stdio" };
  }

  return {
    transportType: "sse",
    sse: {
      port: env.MCP_SSE_PORT,
      endpoint: env.MCP_SSE_ENDPOINT,
    },
  };
}
