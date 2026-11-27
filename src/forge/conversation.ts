import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type pg from "pg";
import type { Runner } from "../runner/runner.js";
import type { StepOutcome, StepTypeModule } from "./engine.js";
import { createConversationRecords, type Turn } from "./conversation-records.js";
import { commitDeliverables, headOf, sweepForbiddenChanges, type MayChange } from "./deliverables.js";
import { InvalidInputError } from "./errors.js";
import type { InputProducer } from "./extension.js";
import type { GateKindModule } from "./gates.js";
import { requireSeat, type SeatName } from "./seats.js";
import { runAgentStep } from "./step.js";
import type { WorkflowInput } from "./workflow-definition.js";
import type { AgentSeat, WorkflowContext } from "./workflow.js";

/** What an Agent's text says as one turn of a conversation: a round of questions, or the summary it proposes, or what is wrong with it. */
export type ParsedTurn = { kind: "questions" | "summary"; body: string } | { problem: string };

/** One Agent a conversation Step can name: who it is, how its turns read, and what it may change in the Project. */
export interface ConversationAgent {
  /** The name a Workflow gives in `agent:`, and the Step's name in the Run's record. */
  name: string;
  seat: SeatName;
  instructions: string;
  /** The Run Note its turn is written to, relative to the worktree. It may be unable to write it, so its final message is read when the note is unusable. */
  notePath: string;
  /** The Run Note that keeps the whole conversation, rewritten at each exchange (read by the Agents that work from it). */
  transcriptPath: string;
  /** The transcript's title. */
  title: string;
  /** The first message of the conversation. */
  opening(ctx: WorkflowContext): string;
  parse(text: string): ParsedTurn;
  /** What it is asked when its last turn could not be used. */
  retry(problem: string): string;
  /** The Project files it may change; what else it changes is undone. */
  mayChange: MayChange;
  /**
   * The inputs it produces for the Steps after it, which `when` can then test. When the human confirms the summary they
   * are read and validated (see `InputProducer`); an invalid one reopens the conversation with the reasons.
   */
  produces?: readonly WorkflowInput[];
  /** The commit message for what it changed, made when the human confirms the summary. */
  commitMessage: string;
}

/** How many more times an Agent is asked for a turn that could be read, within the same round. */
export const EXTRA_TURN_TRIES = 2;

/** What a Conversation Gate says when the Agent proposes a summary. */
const SUMMARY_PROPOSED = "proposes a summary";

const capitalised = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
const stop: StepOutcome = { next: "stop" };
const done: StepOutcome = { next: "done" };

/**
 * The Conversation Gate: the Agent has questions, or proposes a summary, and the Run waits for the human. They answer in
 * one message, or confirm the summary (offered only when there is one); abandoning is always possible.
 */
export const createConversationGate = (pool: pg.Pool): GateKindModule => ({
  kind: "conversation",
  label: "A Conversation Gate",
  actions: ["answer", "confirm", "abandon"],
  // `confirm` is for a summary: the Agent turn this Gate waits on says whether there is one.
  offers: async (gate) => ((await createConversationRecords(pool, gate.runId).summaryAt(gate.id)) ? ["answer", "confirm", "abandon"] : ["answer", "abandon"]),
  async decide(_gate, { action, message }) {
    if (action === "abandon") return { next: "abandon" };
    if (action === "confirm") return { next: "continue", decision: "confirm", nextIteration: false };
    if (!message?.trim()) throw new InvalidInputError("An answer needs a message.");
    // The message is kept as it was written: the transcript quotes it verbatim.
    return { next: "continue", decision: "answer", feedback: message, nextIteration: false };
  },
});

/** A human's words as a blockquote: verbatim, and unable to add a heading of the transcript's own. */
const quote = (text: string) => text.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n");

/** The conversation as an Agent (and the human) reads it: one heading per round (each of the Agent's turns), the questions, then the answer verbatim, quoted. */
export function renderTranscript(title: string, subject: string, turns: Turn[]): string {
  const parts = [`# ${title}\n\nSubject:\n\n${quote(subject.trim())}`];
  let round = 0;
  for (const t of turns) {
    if (t.author === "agent") parts.push(`## Round ${++round}\n\n### ${t.kind === "summary" ? "Proposed summary" : "Questions"}\n\n${t.body.trim()}`);
    else if (t.kind === "feedback") parts.push(`### Feedback\n\n${quote(t.body)}`);
    else parts.push(`### Answer\n\n${t.kind === "confirm" ? "Confirmed." : quote(t.body)}`);
  }
  return `${parts.join("\n\n")}\n`;
}

function writeNote(worktreePath: string, path: string, text: string): void {
  const file = join(worktreePath, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** Starts a human message that is given again because the turn it was given for was cut off or discarded. */
const DISCARDED = "Your previous attempt at this turn was cut off or discarded; answer this message again.";

/** What the Agent is told of a human message: an answer as written, Feedback that reopens the conversation with its context. */
function humanMessage(turn: Turn): string {
  if (turn.kind !== "feedback") return turn.body;
  return `The Run was sent back to this conversation with the Feedback below, so it is reopened. Take it as the human's next message: ask what is still unclear, or propose a revised summary.\n\n${turn.body}`;
}

/** When the Runner no longer has the session to resume, a new one starts from the transcript, in the same Step attempt. */
function withSessionFallback(seat: AgentSeat, seed: string): AgentSeat {
  const runner: Runner = {
    async run(step, onEvent) {
      const result = await seat.runner.run(step, onEvent);
      if (result.status !== "failed" || !result.sessionLost || !step.session || !("resume" in step.session)) return result;
      onEvent({ kind: "other", summary: "The Runner no longer has the session: starting a new one from the transcript.", raw: "" });
      return seat.runner.run({ ...step, session: { start: true }, prompt: seed }, onEvent);
    },
  };
  return { ...seat, runner };
}

/** The first message of a new session that takes over a conversation whose session is gone. */
function seededPrompt(transcript: string): string {
  return `You are taking over a conversation with the human that you no longer remember. Here is everything said so far, the last entry being the human's latest message, which you now answer.\n\n${transcript}\n\nGive your next turn, in the same format as before.`;
}

/**
 * The conversation Step type: an Agent and the human talk, in one Runner session, one round at a time. Each turn the
 * Agent ends with questions or a proposed summary; the Step opens a Conversation Gate and waits. An answer resumes the
 * session with the message; a confirmation commits what the Agent changed in the Project and ends the Step. What was
 * said is kept at each exchange (the Run's records, and the transcript in the Run Notes), so a restart picks the
 * conversation up where it was: waiting stays waiting, and a turn cut short is asked again with the human's last message.
 * A conversation that was confirmed is reopened when the Run is sent back to the Step with Feedback, which becomes the
 * human's next message.
 */
export function conversationStepType(agents: ReadonlyMap<string, ConversationAgent>, producers: ReadonlyMap<WorkflowInput, InputProducer> = new Map()): StepTypeModule {
  return {
    type: "conversation",
    async execute({ ctx, step }) {
      if (step.type !== "conversation") throw new Error(`Step "${step.id}" is not a conversation Step.`);
      const agent = agents.get(step.agent);
      if (!agent) throw new Error(`Step "${step.id}" names an unknown Agent "${step.agent}".`);
      const seat = await requireSeat(ctx, agent.seat, capitalised(agent.name));
      if (!seat) return stop;
      const { conversation } = ctx.records;
      const write = async () => writeNote(ctx.worktreePath, agent.transcriptPath, renderTranscript(agent.title, ctx.run.task, await conversation.turns(step.id)));

      let turns = await conversation.turns(step.id);
      const last = turns.at(-1);
      let message: string;
      if (!last) message = agent.opening(ctx);
      else if (last.author === "human" && last.kind !== "confirm") message = `${DISCARDED}\n\n${humanMessage(last)}`;
      else if (last.author === "human") {
        // Confirmed already. Only a Run sent back to this Step with Feedback reopens the conversation.
        const feedback = last.gateId === null ? null : await conversation.reopenFeedback(step.id, last.gateId);
        if (feedback !== null) message = humanMessage(await conversation.add(step.id, { author: "human", kind: "feedback", body: feedback }));
        else {
          // What the Agent produced is checked here, not only when the human confirms: a restart in between finds it unchecked.
          const invalid = await produceInputs(ctx, agent, step.id, producers);
          if (invalid === null) return done;
          message = humanMessage(await conversation.add(step.id, { author: "human", kind: "feedback", body: invalid }));
        }
      } else {
        // The Agent spoke last: the human's decision on its Gate is what comes next.
        const gateId = last.gateId ?? (await waitOnGate(ctx, agent, step.id, last));
        if (gateId === null) return stop;
        const decided = await conversation.answerOf(gateId);
        if (!decided?.decision) return stop;
        if (decided.decision === "confirm") {
          await commitDeliverables(ctx.worktreePath, agent.mayChange, agent.commitMessage);
          await conversation.add(step.id, { author: "human", kind: "confirm", body: "Confirmed.", gateId });
          await write();
          // What the Agent produced is checked now; if it is no good the conversation goes on, with the reasons as the human's next message.
          const invalid = await produceInputs(ctx, agent, step.id, producers);
          if (invalid === null) return done;
          message = humanMessage(await conversation.add(step.id, { author: "human", kind: "feedback", body: invalid }));
        } else {
          if (decided.decision !== "answer") return stop;
          message = decided.message ?? "";
          await conversation.add(step.id, { author: "human", kind: "answer", body: message, gateId });
        }
      }
      if (last) {
        await write();
        turns = await conversation.turns(step.id);
      }

      const session = [...turns].reverse().find((t) => t.author === "agent")?.sessionId ?? null;
      const spoken = await takeTurn(ctx, agent, seat, step.id, turns, message, session);
      if (!spoken) return stop;
      const turn = await conversation.add(step.id, { author: "agent", kind: spoken.kind, body: spoken.body, sessionId: spoken.sessionId });
      await write();
      await waitOnGate(ctx, agent, step.id, turn);
      return stop;
    },
  };
}

/**
 * Reads and validates the inputs the Agent produces, giving the Run each one it did produce. Returns what is wrong with
 * them, as the next message of the conversation, or null when they are all fine.
 */
async function produceInputs(ctx: WorkflowContext, agent: ConversationAgent, stepId: string, producers: ReadonlyMap<WorkflowInput, InputProducer>): Promise<string | null> {
  for (const input of agent.produces ?? []) {
    const producer = producers.get(input);
    if (!producer) throw new Error(`The ${capitalised(agent.name)} produces "${input}", but nothing reads that input.`);
    const produced = await producer(ctx);
    if ("invalid" in produced) {
      return `Forgequor could not use what you produced for the Run. Fix it or remove it, then propose the summary again for the human to confirm.\n\n${produced.invalid}`;
    }
    if (produced.given) await ctx.records.giveInput(input, stepId);
  }
  return null;
}

/**
 * Opens the Conversation Gate for an Agent turn (unless the Step already has one open, as after a restart between the
 * turn and its Gate) and remembers it with the turn. Returns the Gate's id, or null when the Run was abandoned meanwhile.
 */
async function waitOnGate(ctx: WorkflowContext, agent: ConversationAgent, stepId: string, turn: Turn): Promise<number | null> {
  const { conversation } = ctx.records;
  let gateId = await conversation.openGate(stepId);
  if (gateId === null) {
    const who = capitalised(agent.name);
    const reason = turn.kind === "summary" ? `The ${who} ${SUMMARY_PROPOSED} for you to confirm, or to answer if something is missing.` : `The ${who} has a round of questions for you.`;
    await ctx.openGate("conversation", reason, turn.body, stepId);
    gateId = await conversation.openGate(stepId);
  }
  if (gateId !== null) await conversation.attachGate(turn.id, gateId);
  return gateId;
}

/**
 * One turn of the Agent, answering `message` in its session (a new one when it has none, seeded from the transcript when
 * the conversation already has history). A turn that cannot be read is asked for again, in the same session. Returns the
 * turn, or null when the Run cannot go on: an Escalation opened (the Agent failed, changed what it may not, or never gave
 * a usable turn), the Run paused, or it was abandoned.
 */
async function takeTurn(
  ctx: WorkflowContext,
  agent: ConversationAgent,
  seat: AgentSeat,
  stepId: string,
  turns: Turn[],
  message: string,
  session: string | null,
): Promise<{ kind: "questions" | "summary"; body: string; sessionId?: string } | null> {
  const attempt = turns.filter((t) => t.author === "agent").length + 1;
  const seed = seededPrompt(renderTranscript(agent.title, ctx.run.task, turns));
  const runner = withSessionFallback(seat, seed);
  const notePath = join(ctx.worktreePath, agent.notePath);
  let prompt = !turns.length || session ? message : seed;
  let resume = session;
  let problem = "";
  for (let tries = 1; tries <= 1 + EXTRA_TURN_TRIES; tries++) {
    rmSync(notePath, { force: true });
    // Whatever an earlier turn (or a crash) left outside what the Agent may change goes first, so it cannot escape later.
    await sweepForbiddenChanges(ctx.worktreePath, agent.mayChange);
    const head = await headOf(ctx.worktreePath);
    let result;
    try {
      result = await runAgentStep(ctx, runner, {
        name: agent.name,
        stepId,
        attempt,
        instructions: agent.instructions,
        prompt,
        session: resume ? { resume } : { start: true },
      });
    } catch (e) {
      await sweepForbiddenChanges(ctx.worktreePath, agent.mayChange, head);
      throw e;
    }
    // A turn that did not succeed (failed, timed out, paused, abandoned) is swept silently: it is not used anyway.
    if (!result) {
      await sweepForbiddenChanges(ctx.worktreePath, agent.mayChange, head).catch(() => {});
      return null;
    }
    const forbidden = await sweepForbiddenChanges(ctx.worktreePath, agent.mayChange, head);
    if (forbidden.length) {
      await ctx.openGate(
        "escalation",
        `The ${capitalised(agent.name)} changed files it may not change, so they were put back as they were.`,
        forbidden.join("\n"),
        stepId,
      );
      return null;
    }
    resume = result.sessionId ?? resume;
    const parsed = agent.parse(existsSync(notePath) ? readFileSync(notePath, "utf8") : result.summary);
    if ("problem" in parsed && existsSync(notePath)) {
      const fallback = agent.parse(result.summary);
      if (!("problem" in fallback)) return { ...fallback, sessionId: resume ?? undefined };
    }
    if (!("problem" in parsed)) return { ...parsed, sessionId: resume ?? undefined };
    problem = parsed.problem;
    prompt = resume ? agent.retry(problem) : `${seed}\n\n${agent.retry(problem)}`;
  }
  await ctx.openGate("escalation", `The ${capitalised(agent.name)} gave no usable turn after ${1 + EXTRA_TURN_TRIES} tries.`, problem, stepId);
  return null;
}
