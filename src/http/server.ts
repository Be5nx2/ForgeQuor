import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import {
  AssetNotFoundError,
  GateError,
  DogfoodExportError,
  DogfoodNoteNotFoundError,
  DogfoodNoteTransitionError,
  InvalidInputError,
  InvalidSeatError,
  RegistrationError,
  RunNotFoundError,
  RunStateError,
  SeatLockedError,
  type AssetRequest,
  type Forge,
  type GateAction,
  type ReviewMode,
  type SeatSettings,
  type Verdict,
  type RunState,
} from "../forge/forge.js";
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

  app.get("/api/skill-packs", async () => ({ offered: deps.forge.offeredSkillPacks() }));

  app.put<{ Params: { id: string }; Body: { packs?: unknown } }>("/api/projects/:id/skill-packs", async (req, reply) => {
    const packs = req.body?.packs;
    if (!Array.isArray(packs) || packs.some((p) => typeof p !== "string")) {
      return reply.code(400).send({ error: "packs must be a list of Skill Pack names." });
    }
    try {
      return await deps.forge.setSkillPacks(Number(req.params.id), packs);
    } catch (e: any) {
      return reply.code(e instanceof InvalidInputError ? 400 : 404).send({ error: e.message });
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

  app.put<{ Params: { id: string }; Body: { artDirectionPath?: unknown; artFolder?: unknown } }>("/api/projects/:id/art", async (req, reply) => {
    const { artDirectionPath, artFolder } = req.body ?? {};
    if (typeof artDirectionPath !== "string" || typeof artFolder !== "string") {
      return reply.code(400).send({ error: "artDirectionPath and artFolder must be paths." });
    }
    try {
      return await deps.forge.setArt(Number(req.params.id), { artDirectionPath, artFolder });
    } catch (e: any) {
      return reply.code(e instanceof InvalidInputError ? 400 : 404).send({ error: e.message });
    }
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/art-info", async (req, reply) => {
    try {
      return await deps.forge.artInfo(Number(req.params.id));
    } catch (e: any) {
      return reply.code(404).send({ error: e.message });
    }
  });

  /**
   * POST /api/workflows/validate  body: { yaml: string, projectId?: number }
   * Validates Workflow YAML text exactly as launch does and stores nothing. Answers 200 with
   * `{ valid: boolean, errors: [{ path, line?, column?, message }] }` (`errors` is empty when valid; every error is
   * listed, not the first). 400 when `yaml` is not a string, 404 when `projectId` names no Project.
   * Used by the `/to-workflow` Skill: curl -s -X POST -H 'content-type: application/json' -d '{"yaml":"..."}' <address>/api/workflows/validate
   */
  app.post<{ Body: { yaml?: unknown; projectId?: unknown } }>("/api/workflows/validate", async (req, reply) => {
    const { yaml, projectId } = req.body ?? {};
    if (typeof yaml !== "string") return reply.code(400).send({ error: "The body needs a `yaml` string." });
    if (projectId !== undefined && !Number.isInteger(projectId)) return reply.code(400).send({ error: "`projectId` must be an integer." });
    try {
      return await deps.forge.validateWorkflow(yaml, projectId as number | undefined);
    } catch (e: any) {
      return reply.code(404).send({ error: e.message });
    }
  });

  // What the Run form offers and the Workflows tab shows: the built-in Workflows and the Project's own, with Steps, YAML and errors, read from its freshly fetched default branch.
  app.get<{ Params: { id: string } }>("/api/projects/:id/workflows", async (req, reply) => {
    try {
      return await deps.forge.listWorkflows(Number(req.params.id));
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
  app.post<{ Body: { projectId?: number; task?: string; title?: string; trackerRef?: string; workflow?: string; assets?: AssetRequest[]; review?: ReviewMode; seats?: SeatSettings } }>(
    "/api/runs",
    async (req, reply) => {
      const { projectId, task, title, trackerRef, workflow, assets, review, seats } = req.body ?? {};
      // An `assets` Run takes Asset Requests instead of a task; the Forge core says what is wrong with them.
      if (!projectId || (!task?.trim() && !assets)) return reply.code(400).send({ error: "projectId and a task (or Asset Requests) are required." });
      try {
        return reply.code(201).send(await deps.forge.startRun({ projectId, task, title, trackerRef, workflow, assets, review, seats }));
      } catch (e: any) {
        if (e instanceof InvalidSeatError) return reply.code(400).send({ error: e.message });
        if (e instanceof SeatLockedError) return reply.code(409).send({ error: e.message });
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
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/runs/:id/notes", async (req, reply) => {
    try {
      return await deps.forge.getRunNote(Number(req.params.id), req.query.path ?? "");
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
  // An Asset's image: the ids pick what the Forge core recorded, the request never names a path.
  app.get<{ Params: { runId: string; assetId: string }; Querystring: { version?: string; replaced?: string } }>("/api/runs/:runId/assets/:assetId/image", async (req, reply) => {
    const { runId, assetId } = req.params;
    const version = req.query.version;
    if (!/^\d{1,15}$/.test(runId) || !/^\d{1,15}$/.test(assetId) || (version !== undefined && !/^\d{1,15}$/.test(version))) {
      return reply.code(404).send({ error: "No such Asset." });
    }
    try {
      const image = await readFile(await deps.forge.assetImage(Number(runId), Number(assetId), req.query.replaced !== undefined ? "replaced" : version === undefined ? undefined : Number(version)));
      // An Asset's file changes between Iterations at the same URL.
      return reply.type("image/png").header("cache-control", "no-store").send(image);
    } catch (e) {
      if (e instanceof AssetNotFoundError || (e as NodeJS.ErrnoException)?.code === "ENOENT") return reply.code(404).send({ error: "No such Asset." });
      throw e;
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
  // Both vendors' latest Quota Reading with its age: the Quota bars.
  app.get("/api/quota", async () => deps.forge.quota());
  // The Team page: each seat's effective Runner and model, and where each comes from.
  app.get("/api/team", async () => deps.forge.team());
  app.put<{ Params: { seat: string }; Body: { runner?: string | null; model?: string | null } }>("/api/team/:seat", async (req, reply) => {
    try {
      const { runner, model } = req.body ?? {};
      return await deps.forge.changeSeat(req.params.seat, { runner, model });
    } catch (e) {
      if (e instanceof InvalidInputError) return reply.code(400).send({ error: e.message });
      if (e instanceof SeatLockedError) return reply.code(409).send({ error: e.message });
      throw e;
    }
  });
  /**
   * POST /api/dogfood-notes  body: { nature, target, text, tab, runId?, projectId? }  creates a Dogfood Note (201 with the note);
   * 400 for a blank text, a bad nature or target, or an unknown Run or Project.
   * GET /api/dogfood-notes?status=&nature=&target=  answers `{ notes, newCount }`, newest first (400 for an unknown filter value).
   */
  app.post<{ Body: Record<string, unknown> }>("/api/dogfood-notes", async (req, reply) => {
    const { nature, target, text, tab, runId, projectId } = req.body ?? {};
    for (const [name, value] of [["nature", nature], ["target", target], ["text", text], ["tab", tab]] as const) {
      if (typeof value !== "string") return reply.code(400).send({ error: `${name} is required.` });
    }
    for (const [name, value] of [["runId", runId], ["projectId", projectId]] as const) {
      if (value !== undefined && value !== null && !Number.isInteger(value)) return reply.code(400).send({ error: `${name} must be an integer.` });
    }
    try {
      return reply.code(201).send(
        await deps.forge.createDogfoodNote({ nature: nature as string, target: target as string, text: text as string, tab: tab as string, runId: (runId ?? undefined) as number | undefined, projectId: (projectId ?? undefined) as number | undefined }),
      );
    } catch (e) {
      if (e instanceof InvalidInputError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });
  app.get<{ Querystring: { status?: string; nature?: string; target?: string } }>("/api/dogfood-notes", async (req, reply) => {
    try {
      return await deps.forge.listDogfoodNotes({ status: req.query.status, nature: req.query.nature, target: req.query.target });
    } catch (e) {
      if (e instanceof InvalidInputError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });
  /**
   * PUT /api/dogfood-notes/:id/status  body: { status, triageRef? }  moves a note to triaged (with an optional reference),
   * dismissed, or back to new, and answers the note. 400 for a bad status or reference, 404 for an unknown note, 409 for a move not allowed.
   */
  app.put<{ Params: { id: string }; Body: { status?: unknown; triageRef?: unknown } }>("/api/dogfood-notes/:id/status", async (req, reply) => {
    const { status, triageRef } = req.body ?? {};
    if (typeof status !== "string") return reply.code(400).send({ error: "status is required." });
    if (triageRef !== undefined && triageRef !== null && typeof triageRef !== "string") return reply.code(400).send({ error: "triageRef must be text." });
    if (!/^\d+$/.test(req.params.id)) return reply.code(404).send({ error: `No Dogfood Note ${req.params.id}.` });
    try {
      return await deps.forge.setDogfoodNoteStatus(Number(req.params.id), status, triageRef as string | null | undefined);
    } catch (e) {
      if (e instanceof InvalidInputError) return reply.code(400).send({ error: e.message });
      if (e instanceof DogfoodNoteNotFoundError) return reply.code(404).send({ error: e.message });
      if (e instanceof DogfoodNoteTransitionError) return reply.code(409).send({ error: e.message });
      throw e;
    }
  });
  /**
   * POST /api/dogfood-notes/export  body: { ids: number[] }  writes the chosen notes as one Markdown file in the export folder
   * and answers `{ fileName, path, content }` for download. Changes no status. 400 for an empty selection or a bad ID, 404 for
   * an unknown note, 500 with the reason when the folder cannot be written.
   */
  app.post<{ Body: { ids?: unknown } }>("/api/dogfood-notes/export", async (req, reply) => {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids)) return reply.code(400).send({ error: "ids is required." });
    try {
      return await deps.forge.exportDogfoodNotes(ids as number[]);
    } catch (e) {
      if (e instanceof InvalidInputError) return reply.code(400).send({ error: e.message });
      if (e instanceof DogfoodNoteNotFoundError) return reply.code(404).send({ error: e.message });
      if (e instanceof DogfoodExportError) return reply.code(500).send({ error: e.message });
      throw e;
    }
  });
  app.get("/api/gates",async () => deps.forge.listOpenGates());
  // The merge list: Approved Runs whose pull request waits for the human's merge.
  app.get("/api/approved-runs", async () => deps.forge.listApprovedRuns());
  app.post<{ Params: { id: string }; Body: { action?: GateAction; feedback?: string; verdicts?: Verdict[]; target?: string; message?: string } }>("/api/gates/:id/decision", async (req, reply) => {
    const { action, feedback, verdicts, target, message } = req.body ?? {};
    if (action !== "approve" && action !== "reject" && action !== "abandon" && action !== "judge" && action !== "retry" && action !== "go_back" && action !== "answer" && action !== "confirm") {
      return reply.code(400).send({ error: "action must be approve, reject, judge, retry, go_back, answer, confirm or abandon." });
    }
    if (message !== undefined && typeof message !== "string") return reply.code(400).send({ error: "message must be text." });
    try {
      return await deps.forge.decideGate({ gateId: Number(req.params.id), action, feedback, verdicts, target, message });
    } catch (e) {
      if (e instanceof InvalidInputError) return reply.code(400).send({ error: e.message });
      if (e instanceof GateError) return reply.code(409).send({ error: e.message });
      throw e;
    }
  });

  if (deps.webRoot && existsSync(deps.webRoot)) {
    await app.register(fastifyStatic, { root: deps.webRoot });
  }
  return app;
}
