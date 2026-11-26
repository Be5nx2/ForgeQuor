<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { getJson, type RunDetail } from "../api";
import GateActions from "../components/GateActions.vue";

const props = defineProps<{ id: number }>();
defineEmits<{ back: [] }>();

const run = ref<RunDetail | null>(null);
const error = ref("");

async function load() {
  try {
    run.value = await getJson(`/api/runs/${props.id}`);
  } catch (e: any) {
    error.value = e.message;
  }
}

let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  load();
  timer = setInterval(load, 3000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <p><a href="#" @click.prevent="$emit('back')">&larr; Runs</a></p>
  <p v-if="error" class="error">{{ error }}</p>
  <template v-if="run">
    <h2>{{ run.title }} <span class="badge">{{ run.state }}</span></h2>
    <p class="muted" v-if="run.trackerRef">Tracker: {{ run.trackerRef }}</p>
    <pre class="task">{{ run.task }}</pre>
    <p class="muted" v-if="run.branch">Branch <code>{{ run.branch }}</code><br />Worktree <code>{{ run.worktreePath }}</code></p>

    <h3>Gates</h3>
    <p v-if="!run.gates.length" class="muted">None yet.</p>
    <ul>
      <li v-for="g in run.gates" :key="g.id">
        <strong>{{ g.kind === "final" ? "Final Gate" : "Escalation" }}</strong>: {{ g.reason }}
        <pre v-if="g.evidence">{{ g.evidence }}</pre>
        <div v-if="g.decidedAt" class="muted">
          {{ g.decision === "approve" ? "Approved" : "Abandoned" }} · {{ new Date(g.decidedAt).toLocaleString() }}
        </div>
        <GateActions v-else :gate="g" @decided="load" />
      </li>
    </ul>

    <h3>Steps</h3>
    <p v-if="!run.attempts.length" class="muted">None yet.</p>
    <ul>
      <li v-for="a in run.attempts" :key="a.id">
        <strong>{{ a.step }}</strong> · attempt {{ a.attempt }} · <span class="badge">{{ a.status }}</span>
        <div class="muted">
          {{ a.runner }}<span v-if="a.model"> ({{ a.model }})</span> · {{ new Date(a.startedAt).toLocaleString() }}
          <span v-if="a.endedAt"> → {{ new Date(a.endedAt).toLocaleTimeString() }}</span>
        </div>
        <pre v-if="a.error">{{ a.error }}</pre>
        <pre v-else-if="a.summary">{{ a.summary }}</pre>
      </li>
    </ul>
  </template>
</template>
