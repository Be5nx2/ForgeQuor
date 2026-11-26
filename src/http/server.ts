import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { RegistrationError, type Forge } from "../forge/forge.js";
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

  if (deps.webRoot && existsSync(deps.webRoot)) {
    await app.register(fastifyStatic, { root: deps.webRoot });
  }
  return app;
}
