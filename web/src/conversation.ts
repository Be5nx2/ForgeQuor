// What the conversation with an Agent (the Griller) shows: its turns as chat messages, and a round of questions taken apart
// into the intro, each question and its recommended answer. Plain data in, plain data out, so the screen only draws it.
import type { ConversationTurn } from "./api.js";

/** One question of a round, with the answer the Agent recommends (null when it gave none). */
export interface Question {
  number: string;
  text: string;
  recommendation: string | null;
}

/** A round of questions: what the Agent said before the list, then the numbered questions. */
export interface Round {
  intro: string;
  questions: Question[];
}

const ITEM = /^\s*(?:[-*]\s*)?(?:\*\*)?Q?(\d+)[.):]?(?:\*\*)?[.):]?\s+(.*)$/i;
/** "(My recommendation: ...)", "Recommended answer: ...", "**Recommendation**: ..." at the end of a question or on its own line. */
const RECOMMENDATION = /[(\[]?\s*(?:\*\*|_)?\s*(?:my\s+)?recommend(?:ation|ed(?:\s+answer)?)\s*(?:\*\*|_)?\s*[:\-–—]\s*(?:\*\*|_)?\s*([\s\S]*?)\s*$/i;

function toQuestion(number: string, lines: string[]): Question {
  const text = lines.join("\n").trim();
  const found = RECOMMENDATION.exec(text);
  if (!found) return { number, text, recommendation: null };
  const before = text.slice(0, found.index).trim();
  const recommendation = found[1]!.trim().replace(/[)\]]+$/, "").trim() || null;
  return { number, text: before, recommendation };
}

/** Takes a round of questions apart. A body with no numbered list comes back as an intro only. */
export function parseRound(body: string): Round {
  const intro: string[] = [];
  const items: { number: string; lines: string[] }[] = [];
  for (const line of body.split("\n")) {
    const item = ITEM.exec(line);
    if (item) items.push({ number: item[1]!, lines: [item[2]!] });
    else if (items.length) items[items.length - 1]!.lines.push(line);
    else intro.push(line);
  }
  return { intro: intro.join("\n").trim(), questions: items.map((i) => toQuestion(i.number, i.lines)) };
}

/** One message of the chat. */
export interface ChatMessage {
  id: number;
  author: "agent" | "human";
  /** "Griller · round 2", "You". */
  who: string;
  /** What kind of turn it is, for a small badge ("proposed summary", "confirmed"); null for plain questions and answers. */
  badge: string | null;
  /** The questions, taken apart, for a round of questions. */
  round: Round | null;
  /** Otherwise, the Markdown to show. */
  body: string;
}

const BADGE: Partial<Record<ConversationTurn["kind"], string>> = { summary: "proposed summary", confirm: "confirmed", feedback: "feedback" };

/** The turns of one conversation Step as chat messages, the Agent's rounds numbered in order. */
export function chatOf(turns: ConversationTurn[], agent: string): ChatMessage[] {
  let rounds = 0;
  return turns.map((t) => {
    const asks = t.author === "agent" && t.kind === "questions";
    if (asks) rounds++;
    return {
      id: t.id,
      author: t.author,
      who: t.author === "human" ? "You" : asks ? `${agent} · round ${rounds}` : agent,
      badge: BADGE[t.kind] ?? null,
      round: asks ? parseRound(t.body) : null,
      body: t.body,
    };
  });
}
