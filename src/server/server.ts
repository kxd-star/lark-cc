import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Server } from "bun";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";

import type { Logger } from "@/shared";
import { createLogger } from "@/shared";

import {
  cronjobsRoutes,
  handoffRoutes,
  healthRoutes,
  memoryRoutes,
  sessionRoutes,
  skillsRoutes,
  taskRoutes,
  usageRoutes,
} from "./routes";

/**
 * Creates the Hono app with all API routes mounted.
 *
 * Extracted as a standalone function so TypeScript can infer the full
 * chained route type, which is then exported as {@link AppType} for
 * use with Hono's RPC client (`hc<AppType>`).
 */
function createApp() {
  return (
    new Hono()
      // CORS middleware
      .use("/api/*", cors({ origin: "*" }))
      // Routes
      .route("/api", healthRoutes)
      .route("/api/cronjobs", cronjobsRoutes)
      .route("/api/handoff", handoffRoutes)
      .route("/api/memory", memoryRoutes)
      .route("/api/sessions", sessionRoutes)
      .route("/api/skills", skillsRoutes)
      .route("/api/tasks", taskRoutes)
      .route("/api/usage", usageRoutes)
  );
}

/**
 * The fully-typed Hono app, including all mounted route signatures.
 *
 * Use with `hc<AppType>` on the client side for end-to-end type safety.
 */
export type AppType = ReturnType<typeof createApp>;

/**
 * The HTTP server wrapping Hono, started and stopped by the Kernel.
 *
 * Serves RESTful API routes under `/api` and, in production mode,
 * static files from the built React SPA at `web/dist/`.
 */
export class HonoServer {
  private _app: AppType;
  private _server: Server<undefined> | undefined;
  private _logger: Logger;

  constructor() {
    this._logger = createLogger("hono-server");
    this._app = createApp();
    this._setupStaticServing();
  }

  get app(): AppType {
    return this._app;
  }

  /**
   * Start listening on the configured host and port.
   *
   * Uses `AGENTARA_SERVICE_PORT` (default 1984) and
   * `AGENTARA_SERVICE_HOST` (default 0.0.0.0).
   *
   * Retries binding up to 5 times with 1s delay to handle
   * TIME_WAIT from a prior instance of the same process.
   */
  async start(): Promise<void> {
    const port = parseInt(Bun.env.AGENTARA_SERVICE_PORT ?? "1984", 10);
    const hostname = Bun.env.AGENTARA_SERVICE_HOST ?? "0.0.0.0";
    const maxRetries = 5;
    const retryDelayMs = 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this._server = Bun.serve({
          fetch: this._app.fetch,
          port,
          hostname,
        });
        break; // success
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < maxRetries) {
          this._logger.warn(
            { attempt, maxRetries, port, err: msg },
            `Port ${port} bind failed, retrying in ${retryDelayMs}ms...`,
          );
          await new Promise((r) => setTimeout(r, retryDelayMs));
        } else {
          this._logger.error(
            { port, err: msg },
            `Port ${port} bind failed after ${maxRetries} attempts`,
          );
          throw err;
        }
      }
    }

    this._logger.info(
      "HTTP server is running on http://" +
        hostname +
        (port === 80 ? "" : ":" + port),
    );
  }

  /**
   * Gracefully shut down the server.
   */
  async stop(): Promise<void> {
    if (this._server) {
      await this._server.stop(true);
      this._logger.info("HTTP server stopped");
    }
  }

  private _setupStaticServing(): void {
    if (Bun.env.NODE_ENV === "production") {
      const webRoot = join(process.cwd(), "web", "dist");
      if (existsSync(webRoot)) {
        this._app.use("/*", serveStatic({ root: webRoot }));
        // SPA fallback: serve index.html for non-API, non-asset routes
        this._app.get("*", serveStatic({ path: join(webRoot, "index.html") }));
      }
    }
  }
}
