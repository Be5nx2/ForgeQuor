import type { RunUpdate } from "./api";
import { createLiveStream } from "./liveStream";

/** The browser tab's one live-events stream: every screen and the sidebar follow it, none opens its own. */
export const liveEvents = createLiveStream<RunUpdate>(() => new EventSource("/api/events"));
