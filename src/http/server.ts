import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { GateError, RegistrationError, RunNotFoundError, RunStateError, type Forge, type GateAction, type RunState } from "../forge/forge.js";
import type { ToolReport } from "../startup/preflight.js";

/** Thin JSON translation of the Forge core interface. No logic here. */
export async function createServer(deps: {
  forge: Forge;
  tools: ToolReport[];
  webRoot?: string;
}): Promise<FastifyInstance> {
  const app = Fastify();

  app.get("/api/health", async () => ({ tools: deps.tools }));
  app.get("/api/projects", async () => deps.forge.listProjects());
  app.post<{ Body: { path?: string } }>("/api/projects", async (req, reply) => {
    const path = req.body?.path?.trim();
    if (!path) return reply.code(400).send({ error: "path is required." });
    try {
      return reply.code(201).send(await deps.forge.registerProject({ path }));
    } catch (e) {
      if (e instanceof RegistrationError) return reply.code(422).send({ error: e.message });
      throw e;
    }
  });

  app.put<{ Params: { id: string }; Body: { checks?: unknown } }>("/api/projects/:id/checks", async (req, reply) => {
    const checks = req.body?.checks;
    if (!Array.isArray(checks) || checks.some((c) => typeof c !== "string")) {
      return reply.code(400).send({ error: "checks must be a list of commands." });
    }
    try {
      return await deps.forge.setChecks(Number(req.params.id), checks);
    } catch (e: any) {
      return reply.code(404).send({ error: e.message });
    }
  });

  app.put<{ Params: { id: string }; Body: { setup?: unknown } }>("/api/projects/:id/setup", async (req, reply) => {
    const setup = req.body?.setup;
    if (!Array.isArray(setup) || setup.some((c) => typeof c !== "string")) {
      return reply.code(400).send({ error: "setup must be a list of commands." });
    }
    try {
      return await deps.forge.setSetup(Number(req.params.id), setup);
    } catch (e: any) {
      return reply.code(404).send({ error: e.message });
    }
  });

  app.put<{ Params: { id: string }; Body: { max?: unknown } }>("/api/projects/:id/concurrency", async (req, reply) => {
    const max = req.body?.max;
    if (typeof max !== "number" || !Number.isInteger(max) || max < 1) {
      return reply.code(400).send({ error: "max must be a whole number of at least 1." });
    }
    try {
      return await deps.forge.setMaxConcurrentRuns(Number(req.params.id), max);
    } catch (e: any) {
      return reply.code(/^No Project/.test(e.message) ? 404 : 500).send({ error: e.message });
    }
  });

  app.get<{ Querystring: { projectId?: string; state?: RunState } }>("/api/runs", async (req) =>
    deps.forge.listRuns({
      projectId: req.query.projectId ? Number(req.query.projectId) : undefined,
      state: req.query.state || undefined,
    }),
  );
  app.post<{ Body: { projectId?: number; task?: string; title?: string; trackerRef?: string; workflow?: string } }>(
    "/api/runs",
    async (req, reply) => {
      const { projectId, task, title, trackerRef, workflow } = req.body ?? {};
      if (!projectId || !task?.trim()) return reply.code(400).send({ error: "projectId and task are required." });
      try {
        return reply.code(201).send(await deps.forge.startRun({ projectId, task, title, trackerRef, workflow }));
      } catch (e: any) {
        return reply.code(422).send({ error: e.message });
      }
    },
  );
  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    try {
      return await deps.forge.getRun(Number(req.params.id));
    } catch (e: any) {
      return reply.code(404).send({ error: e.message });
    }
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/abandon", async (req, reply) => {
    try {
      return await deps.forge.abandonRun(Number(req.params.id));
    } catch (e: any) {
      return reply.code(e instanceof RunNotFoundError ? 404 : e instanceof RunStateError ? 409 : 502).send({ error: e.message });
    }
  });
  // Live Run updates as server-sent events: one JSON RunUpdate per message.
  app.get("/api/events", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": connected\n\n");
    const send = (chunk: string) => {
      if (!res.destroyed && !res.writableEnded) res.write(chunk);
    };
    const unsubscribe = deps.forge.subscribe((update) => send(`data: ${JSON.stringify(update)}\n\n`));
    const heartbeat = setInterval(() => send(": keep-alive\n\n"), 25_000);
    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
  app.get("/api/gates", async () => deps.forge.listOpenGates());
  app.post<{ Params: { id: string }; Body: { action?: GateAction; feedback?: string } }>("/api/gates/:id/decision", async (req, reply) => {
    const { action, feedback } = req.body ?? {};
    if (action !== "approve" && action !== "reject" && action !== "abandon") {
      return reply.code(400).send({ error: "action must be approve, reject or abandon." });
    }
    try {
      return await deps.forge.decideGate({ gateId: Number(req.params.id), action, feedback });
    } catch (e) {
      if (e instanceof GateError) return reply.code(409).send({ error: e.message });
      throw e;
    }
  });

  if (deps.webRoot && existsSync(deps.webRoot)) {
    await app.register(fastifyStatic, { root: deps.webRoot });
  }
  return app;
}
