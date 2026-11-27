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
  /** The latest Feedback the human gave after the Gate `gateId` when sending the Run back (a go back, a retry, a rejection): what reopens a confirmed conversation. */
  feedbackAfter(gateId: number): Promise<string | null>;
  /** The summary the human last confirmed, or null when no conversation of the Run was confirmed. */
  confirmedSummary(): Promise<string | null>;
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
    async feedbackAfter(gateId) {
      const { rows } = await pool.query(
        "SELECT feedback FROM gates WHERE run_id = $1 AND id > $2 AND feedback IS NOT NULL AND decision IN ('go_back', 'retry', 'reject') ORDER BY id DESC LIMIT 1",
        [runId, gateId],
      );
      return rows[0]?.feedback ?? null;
    },
    async confirmedSummary() {
      const { rows } = await pool.query(
        `SELECT s.body FROM conversation_turns c JOIN conversation_turns s ON s.run_id = c.run_id AND s.step_id = c.step_id AND s.kind = 'summary' AND s.seq < c.seq
         WHERE c.run_id = $1 AND c.kind = 'confirm' ORDER BY c.id DESC, s.seq DESC LIMIT 1`,
        [runId],
      );
      return rows[0]?.body ?? null;
    },
    async all() {
      const { rows } = await pool.query("SELECT * FROM conversation_turns WHERE run_id = $1 ORDER BY id", [runId]);
      return rows.map((r) => ({ id: Number(r.id), stepId: r.step_id, author: r.author, kind: r.kind, body: r.body, createdAt: r.created_at }));
    },
  };
}
