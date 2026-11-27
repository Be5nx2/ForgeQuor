import type pg from "pg";
import type { ConversationTurn } from "./types.js";

/** One message of a conversation, as the Step that drives it reads it back. */
export interface Turn {
  id: number;
  seq: number;
  author: ConversationTurn["author"];
  kind: ConversationTurn["kind"];
  body: string;
  /** The Runner session an Agent turn was given in; null for a human message, or for an Agent turn from before sessions were kept. */
  sessionId: string | null;
  /** The Gate that waited on an Agent turn, or that the human's reply decided. */
  gateId: number | null;
}

export interface NewTurn {
  author: Turn["author"];
  kind: Turn["kind"];
  body: string;
  sessionId?: string;
  gateId?: number;
}

/** What a Gate was decided with. */
export interface GateAnswer {
  decision: string | null;
  /** The human's message (an answer), or null. */
  message: string | null;
}

/**
 * What was said at a Run's Conversation Gates, and the Gates' decisions as the conversation reads them. The messages are
 * the state of a conversation, so a restart picks it up where it was.
 */
export interface ConversationRecords {
  /** What was said in a conversation Step, oldest first. */
  turns(stepId: string): Promise<Turn[]>;
  /** Appends a message to a conversation Step's chat. */
  add(stepId: string, turn: NewTurn): Promise<Turn>;
  /** Remembers the Gate that waits on an Agent turn. */
  attachGate(turnId: number, gateId: number): Promise<void>;
  /** The id of the Gate the Step has open (not yet decided), or null. */
  openGate(stepId: string): Promise<number | null>;
  /** How a Gate was decided; null for a Gate that does not exist. */
  answerOf(gateId: number): Promise<GateAnswer | null>;
  /**
   * The Feedback of the go back that sent the Run back to the conversation Step after the Gate `confirmedAt` confirmed it,
   * or null: only a go back that replays the Step reopens a confirmed conversation (the Step state remembers the Gate it
   * was last sent back at).
   */
  reopenFeedback(stepId: string, confirmedAt: number): Promise<string | null>;
  /** Whether the Agent turn the Gate waits on is a proposed summary (which the human can then confirm). */
  summaryAt(gateId: number): Promise<boolean>;
  /** The summary the human last confirmed (in the conversation Step `stepId` when given, else in any of the Run's), or null when there is none. */
  confirmedSummary(stepId?: string): Promise<string | null>;
  /** Every message of the Run, for its detail. */
  all(): Promise<ConversationTurn[]>;
}

const toTurn = (r: Record<string, any>): Turn => ({
  id: Number(r.id),
  seq: r.seq,
  author: r.author,
  kind: r.kind,
  body: r.body,
  sessionId: r.session_id,
  gateId: r.gate_id === null ? null : Number(r.gate_id),
});

export function createConversationRecords(pool: pg.Pool, runId: number): ConversationRecords {
  return {
    async turns(stepId) {
      const { rows } = await pool.query("SELECT * FROM conversation_turns WHERE run_id = $1 AND step_id = $2 ORDER BY seq", [runId, stepId]);
      return rows.map(toTurn);
    },
    async add(stepId, t) {
      const { rows } = await pool.query(
        `INSERT INTO conversation_turns (run_id, step_id, seq, author, kind, body, session_id, gate_id)
         VALUES ($1, $2, (SELECT COALESCE(max(seq), 0) + 1 FROM conversation_turns WHERE run_id = $1 AND step_id = $2), $3, $4, $5, $6, $7) RETURNING *`,
        [runId, stepId, t.author, t.kind, t.body, t.sessionId ?? null, t.gateId ?? null],
      );
      return toTurn(rows[0]);
    },
    async attachGate(turnId, gateId) {
      await pool.query("UPDATE conversation_turns SET gate_id = $2 WHERE id = $1", [turnId, gateId]);
    },
    async openGate(stepId) {
      const { rows } = await pool.query("SELECT id FROM gates WHERE run_id = $1 AND step = $2 AND kind = 'conversation' AND decided_at IS NULL ORDER BY id DESC LIMIT 1", [runId, stepId]);
      return rows[0] ? Number(rows[0].id) : null;
    },
    async answerOf(gateId) {
      const { rows } = await pool.query("SELECT decision, feedback FROM gates WHERE id = $1 AND run_id = $2", [gateId, runId]);
      return rows[0] ? { decision: rows[0].decision, message: rows[0].feedback } : null;
    },
    async reopenFeedback(stepId, confirmedAt) {
      const { rows } = await pool.query(
        `SELECT g.feedback FROM step_states s JOIN gates g ON g.id = s.since_gate
         WHERE s.run_id = $1 AND s.step = $2 AND s.since_gate > $3 AND g.decision = 'go_back' AND g.feedback IS NOT NULL
         ORDER BY s.iteration DESC LIMIT 1`,
        [runId, stepId, confirmedAt],
      );
      return rows[0]?.feedback ?? null;
    },
    async summaryAt(gateId) {
      const { rows } = await pool.query("SELECT 1 FROM conversation_turns WHERE run_id = $1 AND gate_id = $2 AND author = 'agent' AND kind = 'summary'", [runId, gateId]);
      return rows.length > 0;
    },
    async confirmedSummary(stepId) {
      const { rows } = await pool.query(
        `SELECT s.body FROM conversation_turns c JOIN conversation_turns s ON s.run_id = c.run_id AND s.step_id = c.step_id AND s.kind = 'summary' AND s.seq < c.seq
         WHERE c.run_id = $1 AND c.kind = 'confirm' AND ($2::text IS NULL OR c.step_id = $2) ORDER BY c.id DESC, s.seq DESC LIMIT 1`,
        [runId, stepId ?? null],
      );
      return rows[0]?.body ?? null;
    },
    async all() {
      const { rows } = await pool.query("SELECT * FROM conversation_turns WHERE run_id = $1 ORDER BY id", [runId]);
      return rows.map((r) => ({ id: Number(r.id), stepId: r.step_id, author: r.author, kind: r.kind, body: r.body, createdAt: r.created_at }));
    },
  };
}
