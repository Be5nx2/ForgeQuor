<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { getJson, type OpenGate } from "../api";

const emit = defineEmits<{ open: [id: number] }>();
const gates = ref<OpenGate[]>([]);

async function load() {
  gates.value = await getJson("/api/gates");
}

let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  load();
  timer = setInterval(load, 3000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <h2>Waiting for you</h2>
  <p v-if="!gates.length" class="muted">Nothing is waiting for you.</p>
  <ul>
    <li v-for="g in gates" :key="g.id" class="clickable" @click="emit('open', g.runId)">
      <strong>{{ g.runTitle }}</strong>
      <span class="badge">{{ g.kind === "final" ? "final Gate" : "Escalation" }}</span>
      <div class="muted">{{ g.projectName }} · {{ g.reason }} · {{ g.actions.join(" / ") }}</div>
      <pre v-if="g.evidence">{{ g.evidence }}</pre>
    </li>
  </ul>
</template>
