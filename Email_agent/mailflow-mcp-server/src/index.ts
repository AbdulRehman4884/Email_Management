/**
 * src/index.ts
 *
 * Application entry point.
 *
 * Load order is intentional and must not be changed:
 *  1. env.ts   — validates all environment variables; exits on failure
 *  2. logger   — depends on env.LOG_LEVEL
 *  3. server   — depends on env, logger
 *
 * Tool registration (Phase 7) will be inserted between steps 2 and 3
 * by importing the tool registry before calling startServer().
 */

// Step 1: validate env first — process.exit on invalid config
import "./config/env.js";

import { createLogger } from "./lib/logger.js";
import { buildStartOptionsFromEnv, startServer } from "./server.js";

// Bootstrap: creates the FastMCP server with authenticate hook and registers all tools.
// Must be imported before startServer() so tools are attached to mcpServer first.
import "./mcp/bootstrap/createServer.js";

const log = createLogger("index");

async function main(): Promise<void> {
  try {
    const options = buildStartOptionsFromEnv();
    await startServer(options);
  } catch (err) {
    log.fatal({ err }, "Failed to start mailflow-mcp-server");
    process.exit(1);
  }
}

main();
