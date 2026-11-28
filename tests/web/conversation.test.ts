import { describe, expect, it } from "vitest";
import type { ConversationTurn } from "../../web/src/api.js";
import { chatOf, parseRound } from "../../web/src/conversation.js";

const turn = (id: number, author: "agent" | "human", kind: ConversationTurn["kind"], body: string) =>
  ({ id, stepId: "grill", author, kind, body, createdAt: "2026-01-01T10:00:00Z" }) as unknown as ConversationTurn;

describe("parseRound", () => {
  it("splits the intro, the questions and their recommended answers", () => {
    const r = parseRound("Now the art.\n\n1. Should it open with Tab? (My recommendation: Yes, Tab.)\n2. Stack size? (My recommendation: 99)");
    expect(r.intro).toBe("Now the art.");
    expect(r.questions).toEqual([
      { number: "1", text: "Should it open with Tab?", recommendation: "Yes, Tab." },
      { number: "2", text: "Stack size?", recommendation: "99" },
    ]);
  });

  it("reads other spellings and a recommendation on its own line", () => {
    const r = parseRound("**Q1.** What now?\n   **Recommended answer:** A menu.\n2) And then? Recommendation - nothing");
    expect(r.questions.map((q) => q.recommendation)).toEqual(["A menu.", "nothing"]);
    expect(r.questions[0]!.text).toBe("What now?");
  });

  it("keeps a question without a recommendation, and a body without a list", () => {
    expect(parseRound("1. Just this?").questions).toEqual([{ number: "1", text: "Just this?", recommendation: null }]);
    expect(parseRound("Only words, no list.")).toEqual({ intro: "Only words, no list.", questions: [] });
  });
});

describe("chatOf", () => {
  const turns = [
    turn(1, "agent", "questions", "1. A? (My recommendation: yes)"),
    turn(2, "human", "answer", "yes"),
    turn(3, "agent", "questions", "2. B?"),
    turn(4, "agent", "summary", "All settled."),
    turn(5, "human", "confirm", ""),
  ];

  it("numbers the Agent's rounds and names who speaks", () => {
    const chat = chatOf(turns, "Griller");
    expect(chat.map((m) => m.who)).toEqual(["Griller · round 1", "You", "Griller · round 2", "Griller", "You"]);
    expect(chat[0]!.round?.questions).toHaveLength(1);
    expect(chat[1]!.round).toBeNull();
  });

  it("badges the summary and the confirmation", () => {
    expect(chatOf(turns, "Griller").map((m) => m.badge)).toEqual([null, null, null, "proposed summary", "confirmed"]);
  });
});
