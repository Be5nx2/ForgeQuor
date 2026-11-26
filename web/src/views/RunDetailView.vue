<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { getJson, postJson, type RunDetail } from "../api";
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

const abandoning = ref(false);
const OVER = ["merged", "closed", "abandoned"];
async function abandon() {
  if (!window.confirm("Abandon this Run? Its pull request is closed; its branch and worktree are kept.")) return;
  abandoning.value = true;
  error.value = "";
  try {
    run.value = await postJson(`/api/runs/${props.id}/abandon`, {});
  } catch (e: any) {
    error.value = e.message;
  } finally {
    abandoning.value = false;
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
    <p v-if="run.state === 'paused' && run.resumeAt" class="muted">
      The Runner's Quota is used up. This Run restarts its current Step after {{ new Date(run.resumeAt).toLocaleString() }}.
    </p>
    <p v-if="!OVER.includes(run.state)">
      <button type="button" class="secondary" :disabled="abandoning" @click="abandon">Abandon Run</button>
    </p>
    <p class="muted" v-if="run.trackerRef">Tracker: {{ run.trackerRef }}</p>
    <pre class="task">{{ run.task }}</pre>
    <p class="muted" v-if="run.branch">Branch <code>{{ run.branch }}</code><br />Worktree <code>{{ run.worktreePath }}</code></p>

    <p v-if="run.prUrl">Pull request <a :href="run.prUrl" target="_blank" rel="noopener">#{{ run.prNumber }}</a></p>

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

    <h3>Checks</h3>
    <p v-if="!run.checks.length" class="muted">None ran.</p>
    <ul>
      <li v-for="c in run.checks" :key="c.id">
        <code>{{ c.command }}</code> · attempt {{ c.attempt }} ·
        <span class="badge">{{ c.exitStatus === 0 ? "passed" : c.exitStatus === null ? "killed" : `exit ${c.exitStatus}` }}</span>
        <pre v-if="c.output.trim()">{{ c.output }}</pre>
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
