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

  app.get<{ Querystring: { projectId?: string; state?: RunState } }>("/api/runs", async (req) =>
    deps.forge.listRuns({
      projectId: req.query.projectId ? Number(req.query.projectId) : undefined,
      state: req.query.state || undefined,
    }),
  );
  app.post<{ Body: { projectId?: number; task?: string; title?: string; trackerRef?: string } }>(
    "/api/runs",
    async (req, reply) => {
      const { projectId, task, title, trackerRef } = req.body ?? {};
      if (!projectId || !task?.trim()) return reply.code(400).send({ error: "projectId and task are required." });
      try {
        return reply.code(201).send(await deps.forge.startRun({ projectId, task, title, trackerRef }));
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
  app.get("/api/gates", async () => deps.forge.listOpenGates());
  app.post<{ Params: { id: string }; Body: { action?: GateAction } }>("/api/gates/:id/decision", async (req, reply) => {
    const action = req.body?.action;
    if (action !== "approve" && action !== "abandon") return reply.code(400).send({ error: "action must be approve or abandon." });
    try {
      return await deps.forge.decideGate({ gateId: Number(req.params.id), action });
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
