<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { followRuns, getJson, type OpenGate } from "../api";
import GateActions from "../components/GateActions.vue";

const emit = defineEmits<{ open: [id: number] }>();
const gates = ref<OpenGate[]>([]);

async function load() {
  gates.value = await getJson("/api/gates");
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
      <span class="badge">{{ g.kind === "final" ? "final Gate" : "Escalation" }}</span>
      <div class="muted">{{ g.projectName }} · {{ g.reason }}</div>
      <pre v-if="g.evidence">{{ g.evidence }}</pre>
      <GateActions :gate="g" @decided="load" />
    </li>
  </ul>
</template>
