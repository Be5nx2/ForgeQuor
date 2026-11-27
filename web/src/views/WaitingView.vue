<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { followRuns, getJson, type ApprovedRun, type OpenGate, type RunDetail } from "../api";
import AssetGallery from "../components/AssetGallery.vue";
import GateActions from "../components/GateActions.vue";

const emit = defineEmits<{ open: [id: number] }>();
const gates = ref<OpenGate[]>([]);
const runs = ref<Record<number, RunDetail>>({});
/** The merge list: Approved Runs whose pull request waits for the human's merge. */
const merges = ref<ApprovedRun[]>([]);
/** Loads overlap when Runs change quickly: only the latest may write, so an older answer never shows a stale list. */
let latest = 0;

async function load() {
  const mine = ++latest;
  // The merge list failing to load must not hide the open Gates.
  const [open, approved] = await Promise.all([
    getJson<OpenGate[]>("/api/gates"),
    getJson<ApprovedRun[]>("/api/approved-runs").catch(() => merges.value),
  ]);
  // An Asset Gate is judged on the images, so its Run comes along to show them.
  const assetRuns = await Promise.all(open.filter((g) => g.kind === "asset").map((g) => getJson<RunDetail>(`/api/runs/${g.runId}`)));
  if (mine !== latest) return;
  runs.value = Object.fromEntries(assetRuns.map((r) => [r.id, r]));
  gates.value = open;
  merges.value = approved;
}

let stopFollowing: () => void;
onMounted(() => {
  load();
  stopFollowing = followRuns((u) => u.type === "changed" && load(), load);
});
onUnmounted(() => stopFollowing?.());
</script>

<template>
  <h2>Waiting for you</h2>
  <p v-if="!gates.length" class="muted">Nothing is waiting for you.</p>
  <ul>
    <li v-for="g in gates" :key="g.id" class="clickable" @click="emit('open', g.runId)">
      <strong>{{ g.runTitle }}</strong>
      <span class="badge">{{ g.kind === "final" ? "final Gate" : g.kind === "asset" ? "Asset Gate" : "Escalation" }}</span>
      <div class="muted">{{ g.projectName }} · {{ g.reason }}</div>
      <pre v-if="g.evidence">{{ g.evidence }}</pre>
      <div v-if="g.kind === 'asset' && runs[g.runId]" @click.stop>
        <AssetGallery :run-id="g.runId" :iteration="runs[g.runId]!.iteration" :assets="runs[g.runId]!.assets" :gate="g" @decided="load" />
      </div>
      <GateActions :gate="g" @decided="load" />
    </li>
  </ul>

  <h2>Waiting for your merge</h2>
  <p v-if="!merges.length" class="muted">No pull request is waiting for your merge.</p>
  <ul>
    <li v-for="r in merges" :key="r.id" class="clickable" @click="emit('open', r.id)">
      <strong>{{ r.title }}</strong>
      <span class="badge">approved</span>
      <div class="muted">
        {{ r.projectName }} ·
        <a v-if="r.prUrl" :href="r.prUrl" target="_blank" rel="noopener" @click.stop>pull request #{{ r.prNumber }}</a>
        <span v-else>no pull request</span>
      </div>
    </li>
  </ul>
</template>
