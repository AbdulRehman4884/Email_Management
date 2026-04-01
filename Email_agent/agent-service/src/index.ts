/**
 * src/index.ts
 *
 * Entrypoint — validates environment, starts the HTTP server, and registers
 * graceful shutdown handlers.
 *
 * Import order matters: env.ts must be first to fail fast on misconfiguration.
 *
 * Server timeout configuration:
 *   keepAliveTimeout  — idle connection reuse window; set above typical proxy
 *                       idle timeout (AWS ALB = 60 s) to prevent 502s
 *   headersTimeout    — must be strictly greater than keepAliveTimeout to
 *                       avoid a Node.js/proxy race condition on reused sockets
 *
 * Graceful shutdown sequence:
 *   1. Stop accepting new TCP connections (server.close)
 *   2. Shorten keepAlive to drain idle connections quickly
 *   3. Let in-flight requests complete naturally
 *   4. After SHUTDOWN_TIMEOUT_MS, forcibly destroy remaining sockets and exit 1
 *   5. If all connections close cleanly before the timeout, exit 0
 */

import { createServer } from "node:http";
import type { Socket } from "node:net";
import { env } from "./config/env.js";
import { createLogger } from "./lib/logger.js";
import {
  SERVICE_NAME,
  SERVICE_VERSION,
  SHUTDOWN_TIMEOUT_MS,
  SERVER_KEEP_ALIVE_TIMEOUT_MS,
  SERVER_HEADERS_TIMEOUT_MS,
} from "./config/constants.js";
import { disconnectRedis } from "./lib/redisClient.js";
import { createSessionStore, setSessionMemoryStore } from "./memory/sessionMemory.store.js";
import { createPendingActionStore, setPendingActionService, PendingActionService } from "./services/pendingAction.service.js";
import { app } from "./app.js";

const log = createLogger("index");

// ── Store initialisation ──────────────────────────────────────────────────────

/**
 * Initialises Redis-backed stores when REDIS_URL is set.
 * Falls back to the in-memory implementations silently on any failure.
 * Must complete before the HTTP server starts accepting requests.
 */
async function initStores(): Promise<void> {
  try {
    const [sessionStore, pendingStore] = await Promise.all([
      createSessionStore(),
      createPendingActionStore(),
    ]);
    setSessionMemoryStore(sessionStore);
    setPendingActionService(new PendingActionService(pendingStore));

    const backend = sessionStore.constructor.name;
    log.info({ backend }, "Stores initialised");
  } catch (err) {
    log.error({ err }, "Store initialisation failed — using in-memory fallback");
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = createServer(app);

// Prevent the Node.js/ALB socket-reuse race condition.
server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
server.headersTimeout   = SERVER_HEADERS_TIMEOUT_MS;

// ── Socket tracking (for graceful drain) ──────────────────────────────────────
// We need to know which sockets are still open so we can destroy them during
// shutdown if they have not closed on their own within the grace period.

const openSockets = new Set<Socket>();

server.on("connection", (socket: Socket) => {
  openSockets.add(socket);
  socket.once("close", () => openSockets.delete(socket));
});

// ── Start ─────────────────────────────────────────────────────────────────────

await initStores();

server.listen(env.PORT, () => {
  log.info(
    {
      port: env.PORT,
      env:  env.NODE_ENV,
      pid:  process.pid,
    },
    `${SERVICE_NAME} v${SERVICE_VERSION} started`,
  );
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  log.info({ signal }, "Shutdown signal received — draining connections");

  // Stop accepting new connections. Fires the "close" event when the last
  // existing connection also closes.
  server.close();

  // Shorten keep-alive so idle sockets stop waiting and close quickly.
  // In-flight requests are unaffected — their sockets stay open until done.
  server.keepAliveTimeout = 1;

  // Force exit after SHUTDOWN_TIMEOUT_MS if connections haven't drained.
  const killTimer = setTimeout(() => {
    log.warn(
      { remainingSockets: openSockets.size },
      "Graceful shutdown timed out — destroying remaining connections",
    );
    for (const socket of openSockets) {
      socket.destroy();
    }
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  // Clean exit once all connections have closed naturally.
  server.once("close", () => {
    clearTimeout(killTimer);
    log.info("HTTP server closed — all connections drained");
    disconnectRedis().finally(() => process.exit(0));
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// ── Safety nets ───────────────────────────────────────────────────────────────

process.on("unhandledRejection", (reason) => {
  log.error({ reason }, "Unhandled promise rejection");
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  log.fatal({ err }, "Uncaught exception");
  process.exit(1);
});
