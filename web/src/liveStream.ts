/** The slice of the browser's EventSource that the live stream uses, so a test can stand in for it. */
export interface EventSourceLike {
  onopen: ((e: Event) => void) | null;
  onmessage: ((e: MessageEvent) => void) | null;
  close(): void;
}

export interface LiveStream<U> {
  /**
   * Follows the stream's updates. `onReconnect` fires when the stream comes back after a drop (not on the first
   * connection), so the subscriber can reload what it missed meanwhile. Returns the function that stops following.
   */
  follow(onUpdate: (update: U) => void, onReconnect?: () => void): () => void;
}

/** One stream shared by every subscriber: opened with the first, closed when the last leaves. */
export function createLiveStream<U>(open: () => EventSourceLike): LiveStream<U> {
  const subscribers = new Set<{ onUpdate: (u: U) => void; onReconnect?: () => void }>();
  let source: EventSourceLike | null = null;

  function connect() {
    let connected = false;
    const s = open();
    source = s;
    s.onopen = () => {
      // The first open is the connection itself; a later one is the browser reconnecting after a drop.
      if (connected) [...subscribers].forEach((sub) => sub.onReconnect?.());
      connected = true;
    };
    s.onmessage = (m) => {
      const update = JSON.parse(m.data) as U;
      [...subscribers].forEach((sub) => sub.onUpdate(update));
    };
  }

  return {
    follow(onUpdate, onReconnect) {
      const sub = { onUpdate, onReconnect };
      subscribers.add(sub);
      if (!source) connect();
      return () => {
        if (!subscribers.delete(sub) || subscribers.size) return;
        source?.close();
        source = null;
      };
    },
  };
}
