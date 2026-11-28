import { describe, expect, it } from "vitest";
import { createLiveStream, type EventSourceLike } from "../../web/src/liveStream.js";

class FakeSource implements EventSourceLike {
  static all: FakeSource[] = [];
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  closed = false;
  constructor() {
    FakeSource.all.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(update: object) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(update) }));
  }
}

function setup() {
  FakeSource.all = [];
  return createLiveStream<{ type: string; runId: number }>(() => new FakeSource());
}

describe("liveStream", () => {
  it("opens one stream for any number of subscribers, and delivers every update to each", () => {
    const live = setup();
    const a: unknown[] = [];
    const b: unknown[] = [];
    live.follow((u) => a.push(u));
    live.follow((u) => b.push(u));
    expect(FakeSource.all).toHaveLength(1);
    FakeSource.all[0]!.emit({ type: "changed", runId: 3 });
    expect(a).toEqual([{ type: "changed", runId: 3 }]);
    expect(b).toEqual(a);
  });

  it("opens nothing before the first subscriber and closes with the last", () => {
    const live = setup();
    expect(FakeSource.all).toHaveLength(0);
    const stopA = live.follow(() => {});
    const stopB = live.follow(() => {});
    stopA();
    stopA();
    expect(FakeSource.all[0]!.closed).toBe(false);
    stopB();
    expect(FakeSource.all[0]!.closed).toBe(true);
    live.follow(() => {});
    expect(FakeSource.all).toHaveLength(2);
  });

  it("stops delivering to a subscriber that left", () => {
    const live = setup();
    const heard: unknown[] = [];
    const stop = live.follow((u) => heard.push(u));
    live.follow(() => {});
    stop();
    FakeSource.all[0]!.emit({ type: "changed", runId: 1 });
    expect(heard).toEqual([]);
  });

  it("tells subscribers to reload on a reconnection, not on the first connection", () => {
    const live = setup();
    let reloads = 0;
    let other = 0;
    live.follow(() => {}, () => reloads++);
    live.follow(() => {}, () => other++);
    const s = FakeSource.all[0]!;
    s.onopen?.(new Event("open"));
    expect(reloads).toBe(0);
    s.onopen?.(new Event("open"));
    expect([reloads, other]).toEqual([1, 1]);
  });

  it("treats a fresh stream after everyone left as a first connection", () => {
    const live = setup();
    let reloads = 0;
    live.follow(() => {}, () => reloads++)();
    live.follow(() => {}, () => reloads++);
    FakeSource.all[1]!.onopen?.(new Event("open"));
    expect(reloads).toBe(0);
  });
});
