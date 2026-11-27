<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { followRuns, getJson, type OpenGate, type RunDetail } from "../api";
import AssetGallery from "../components/AssetGallery.vue";
import GateActions from "../components/GateActions.vue";

const emit = defineEmits<{ open: [id: number] }>();
const gates = ref<OpenGate[]>([]);
const runs = ref<Record<number, RunDetail>>({});

async function load() {
  const open = await getJson<OpenGate[]>("/api/gates");
  // An Asset Gate is judged on the images, so its Run comes along to show them.
  const assetRuns = await Promise.all(open.filter((g) => g.kind === "asset").map((g) => getJson<RunDetail>(`/api/runs/${g.runId}`)));
  runs.value = Object.fromEntries(assetRuns.map((r) => [r.id, r]));
  gates.value = open;
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
</template>
