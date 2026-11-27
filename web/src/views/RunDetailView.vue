<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { followRuns, getJson, postJson, type RunDetail } from "../api";
import AssetGallery from "../components/AssetGallery.vue";
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

/** The running Step's latest events, newest last. */
const live = ref<{ attemptId: number; kind: "text" | "tool" | "other"; summary: string }[]>([]);
const LIVE_LINES = 100;
const runningAttempt = computed(() => run.value?.attempts.find((a) => a.status === "running"));
const liveNow = computed(() => live.value.filter((l) => l.attemptId === runningAttempt.value?.id));
/** For an `assets` Run: how far the batch is, and the Asset the Artist is drawing now. */
const DRAWN = ["waiting", "approved"];
const drawnCount = computed(() => run.value?.assets.filter((a) => DRAWN.includes(a.status)).length ?? 0);
const drawing = computed(() => run.value?.assets.find((a) => a.id === runningAttempt.value?.assetId));

let stopFollowing: () => void;
onMounted(() => {
  load();
  stopFollowing = followRuns((u) => {
    if (u.runId !== props.id) return;
    if (u.type === "changed") return void load();
    live.value = [...live.value, { attemptId: u.attemptId, kind: u.kind, summary: u.summary }].slice(-LIVE_LINES);
  }, load);
});
onUnmounted(() => stopFollowing?.());
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
    <p class="muted">Workflow: {{ run.workflow }}</p>
    <p class="muted" v-if="run.trackerRef">Tracker: {{ run.trackerRef }}</p>
    <pre class="task">{{ run.task }}</pre>
    <p class="muted" v-if="run.branch">Branch <code>{{ run.branch }}</code><br />Worktree <code>{{ run.worktreePath }}</code></p>

    <p v-if="run.prUrl">Pull request <a :href="run.prUrl" target="_blank" rel="noopener">#{{ run.prNumber }}</a></p>

    <template v-if="run.assets.length">
      <h3>Assets</h3>
      <p class="progress" aria-label="Progress">
        {{ drawnCount }} of {{ run.assets.length }} drawn<span v-if="drawing"> · the Artist is drawing <strong>{{ drawing.name }}</strong> (Asset {{ drawing.position + 1 }}, attempt {{ runningAttempt?.attempt }})</span>
      </p>
      <p v-if="drawing" class="muted">The Artist's live events are listed under Step attempts.</p>
      <AssetGallery
        :run-id="run.id"
        :iteration="run.iteration"
        :assets="run.assets"
        :gate="run.gates.find((g) => g.kind === 'asset' && !g.decidedAt)"
        @decided="load"
      />
    </template>

    <template v-if="run.conversation.length">
      <h3>Conversation</h3>
      <ol class="chat" aria-label="Conversation">
        <li v-for="t in run.conversation" :key="t.id" :class="t.author">
          <strong>{{ t.author === "agent" ? "Griller" : "You" }}</strong>
          <span class="badge">{{ { questions: "questions", summary: "proposed summary", answer: "answer", confirm: "confirmed", feedback: "feedback" }[t.kind] }}</span>
          <pre>{{ t.body }}</pre>
        </li>
      </ol>
      <p v-if="run.gates.some((g) => g.kind === 'conversation' && !g.decidedAt)" class="muted">Reply under the open Conversation Gate below.</p>
    </template>

    <template v-if="run.steps.length">
      <h3>Steps</h3>
      <ol class="steps" aria-label="Workflow steps">
        <li v-for="s in run.steps" :key="s.id">
          <strong>{{ s.id }}</strong>
          <span class="muted">{{ " · " + s.type + (s.detail ? ` (${s.detail})` : "") }}</span>
          {{ " " }}<span class="badge">{{ s.status }}</span>
          <span v-if="s.attempts" class="muted"> · {{ s.attempts }} {{ s.attempts === 1 ? "pass" : "passes" }}</span>
          <span v-if="s.status === 'waiting' && s.needs.length" class="muted"> · after {{ s.needs.join(", ") }}</span>
        </li>
      </ol>
    </template>

    <h3>Iterations</h3>
    <ul>
      <li v-for="i in run.iterations" :key="i.number">
        <strong>Iteration {{ i.number }}</strong><span v-if="i.number === run.iteration" class="badge">current</span>
        <pre v-if="i.feedback">{{ i.feedback }}</pre>
        <span v-else-if="i.number === 1" class="muted"> · first pass</span>
      </li>
    </ul>

    <h3>Gates</h3>
    <p v-if="!run.gates.length" class="muted">None yet.</p>
    <ul>
      <li v-for="g in run.gates" :key="g.id">
        <strong>{{ g.kind === "final" ? "Final Gate" : g.kind === "asset" ? "Asset Gate" : g.kind === "review" ? "Review Gate" : g.kind === "conversation" ? "Conversation Gate" : "Escalation" }}</strong> · iteration {{ g.iteration }}:
        {{ g.kind === "asset" && g.decidedAt ? `${g.verdicts.length} ${g.verdicts.length === 1 ? "Asset" : "Assets"} judged.` : g.reason }}
        <pre v-if="g.evidence">{{ g.evidence }}</pre>
        <div v-if="g.decidedAt" class="muted">
          {{ { approve: "Approved", reject: "Rejected", retry: "Retried", go_back: "Went back", abandon: "Abandoned", answer: "Answered", confirm: "Confirmed" }[g.decision ?? "abandon"] }} · {{ new Date(g.decidedAt).toLocaleString() }}
          <pre v-if="g.feedback">{{ g.feedback }}</pre>
        </div>
        <GateActions v-else :gate="g" @decided="load" />
      </li>
    </ul>

    <template v-if="run.reviews.length">
      <h3>Reviews</h3>
      <ul>
        <li v-for="r in run.reviews" :key="r.id">
          <strong>{{ r.author }}</strong> · iteration {{ r.iteration }} · attempt {{ r.attempt }} ·
          <span class="badge">{{ r.verdict }}</span><span v-if="r.final" class="badge">final</span>
          <pre>{{ r.body }}</pre>
        </li>
      </ul>
    </template>

    <h3>Checks</h3>
    <p v-if="!run.checks.length" class="muted">None ran.</p>
    <ul>
      <li v-for="c in run.checks" :key="c.id">
        <code>{{ c.command }}</code> · iteration {{ c.iteration }} · attempt {{ c.attempt }} ·
        <span class="badge">{{ c.exitStatus === 0 ? "passed" : c.exitStatus === null ? "killed" : `exit ${c.exitStatus}` }}</span>
        <pre v-if="c.output.trim()">{{ c.output }}</pre>
      </li>
    </ul>

    <h3>Step attempts</h3>
    <p v-if="!run.attempts.length" class="muted">None yet.</p>
    <ul>
      <li v-for="a in run.attempts" :key="a.id">
        <strong>{{ a.step }}</strong><span v-if="a.assetId"> · {{ run.assets.find((x) => x.id === a.assetId)?.name }}</span> · iteration {{ a.iteration }} · attempt {{ a.attempt }} · <span class="badge">{{ a.status }}</span>
        <div class="muted">
          {{ a.runner }}<span v-if="a.model"> ({{ a.model }})</span> · {{ new Date(a.startedAt).toLocaleString() }}
          <span v-if="a.endedAt"> → {{ new Date(a.endedAt).toLocaleTimeString() }}</span>
        </div>
        <ul v-if="a.status === 'running'" class="live" aria-label="Live progress">
          <li v-if="!liveNow.length" class="muted">Waiting for the Agent's first event…</li>
          <li v-for="(l, i) in liveNow" :key="i"><span class="badge">{{ l.kind }}</span> {{ l.summary }}</li>
        </ul>
        <pre v-if="a.error">{{ a.error }}</pre>
        <pre v-else-if="a.summary">{{ a.summary }}</pre>
      </li>
    </ul>
  </template>
</template>
