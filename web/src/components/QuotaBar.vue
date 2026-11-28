<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { getJson, type QuotaReading, type QuotaStatus } from "../api";
import { vendorQuota } from "../quotaGauge";
import { liveEvents } from "../liveEvents";

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

let stopFollowing: () => void;
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  load();
  stopFollowing = liveEvents.follow((u) => {
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
    <section v-for="v in VENDORS" :key="v.id" class="quota" :class="{ unknown: !vendorQuota(readings[v.id], clock).known, exhausted: vendorQuota(readings[v.id], clock).exhausted }" :aria-label="`${v.label} Quota`">
      <template v-for="q in [vendorQuota(readings[v.id], clock)]" :key="v.id">
        <header>
          <strong>{{ v.label }}</strong>
          <span v-if="q.exhausted" class="badge">exhausted</span>
          <span class="muted age">{{ q.known ? q.age : "unknown" }}</span>
        </header>
        <div v-if="q.known" class="gauges">
          <div v-for="g in q.gauges" :key="g.label" class="gauge" :data-level="g.level">
            <div class="top"><span class="label">{{ g.label }}</span><span class="pct">{{ g.percent }}</span></div>
            <div class="track" role="meter" :aria-label="`${v.label} ${g.label} used`" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.round(g.fill)"><div class="fill" :style="{ width: g.fill + '%' }" /></div>
            <div class="resets muted">{{ g.resets || "reset unknown" }}</div>
          </div>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.quota-bar { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-3); }
.quota { flex: 1 1 22rem; font-size: var(--fs-xs); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--sp-2) var(--sp-3); }
.quota header { display: flex; align-items: baseline; gap: var(--sp-2); margin-bottom: var(--sp-1); }
.quota strong { font: 700 var(--fs-xs) var(--font-brand); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ice-blue); }
.quota .age { margin-left: auto; }
.gauges { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); }
.gauge .top { display: flex; justify-content: space-between; align-items: baseline; }
.gauge .label { color: var(--text-muted); font-weight: 600; }
.gauge .pct { font: 700 var(--fs-sm) var(--font-ui); font-variant-numeric: tabular-nums; }
.track { height: 6px; margin: 3px 0; border-radius: 999px; background: var(--border); overflow: hidden; }
.fill { height: 100%; border-radius: 999px; background: var(--ai); transition: width 0.3s; }
.gauge[data-level="warn"] .fill { background: var(--action); }
.gauge[data-level="warn"] .pct { color: var(--action); }
.gauge[data-level="exhausted"] .fill { background: var(--st-bad); }
.gauge[data-level="exhausted"] .pct { color: var(--st-bad); }
.quota.unknown { opacity: 0.6; }
.quota.exhausted { border-color: var(--st-bad); }
.quota .badge { background: var(--st-bad); color: var(--midnight-black); }
.quota.exhausted strong { color: var(--st-bad); }
</style>
