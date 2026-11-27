<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { followRuns, getJson, type QuotaReading, type QuotaStatus } from "../api";

const VENDORS = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
] as const;

/** The latest reading per vendor; a vendor without one reads "unknown". */
const readings = ref<Record<string, QuotaReading | null>>({});
/** Ticks so that the ages move without a new reading. */
const clock = ref(Date.now());

async function load() {
  const status = await getJson<QuotaStatus[]>("/api/quota").catch(() => null);
  if (status) readings.value = Object.fromEntries(status.map((s) => [s.vendor, s.reading]));
}

function age(reading: QuotaReading): string {
  const seconds = Math.max(0, Math.round((clock.value - Date.parse(reading.readAt)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return `${Math.floor(seconds / 3600)} h ago`;
}

function percent(w: QuotaReading["fiveHour"]): string {
  return w.percentUsed === null ? "?" : `${Math.round(w.percentUsed)}%`;
}

function resets(w: QuotaReading["fiveHour"]): string {
  if (!w.resetsAt) return "";
  const at = new Date(w.resetsAt);
  const sameDay = at.toDateString() === new Date(clock.value).toDateString();
  return `resets ${sameDay ? "" : at.toLocaleDateString([], { month: "short", day: "numeric" }) + " "}${at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function known(r: QuotaReading | null | undefined): r is QuotaReading {
  return !!r && (r.exhausted || r.fiveHour.percentUsed !== null || r.weekly.percentUsed !== null || !!r.fiveHour.resetsAt || !!r.weekly.resetsAt);
}

let stopFollowing: () => void;
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  load();
  stopFollowing = followRuns((u) => {
    if (u.type === "quota") readings.value = { ...readings.value, [u.vendor]: u.reading };
  }, load);
  timer = setInterval(() => (clock.value = Date.now()), 30_000);
});
onUnmounted(() => {
  stopFollowing?.();
  clearInterval(timer);
});
</script>

<template>
  <div class="quota-bar">
    <span v-for="v in VENDORS" :key="v.id" class="quota" :class="{ unknown: !known(readings[v.id]), exhausted: readings[v.id]?.exhausted }">
      <strong>{{ v.label }}</strong>
      <template v-if="known(readings[v.id])">
        <span>5h {{ percent(readings[v.id]!.fiveHour) }} <span class="muted">{{ resets(readings[v.id]!.fiveHour) }}</span></span>
        <span>week {{ percent(readings[v.id]!.weekly) }} <span class="muted">{{ resets(readings[v.id]!.weekly) }}</span></span>
        <span v-if="readings[v.id]!.exhausted" class="badge">exhausted</span>
        <span class="muted">{{ age(readings[v.id]!) }}</span>
      </template>
      <span v-else class="muted">unknown</span>
    </span>
  </div>
</template>
