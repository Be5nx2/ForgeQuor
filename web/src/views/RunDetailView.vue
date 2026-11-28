<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { getJson, postJson, type Project, type RunDetail, type RunNote } from "../api";
import { liveEvents } from "../liveEvents";
import { gateTitle, railOf, resolveSelection, stepViewOf } from "../runDetail";
import AssetGallery from "../components/AssetGallery.vue";
import ErrorState from "../components/ErrorState.vue";
import GateActions from "../components/GateActions.vue";
import LoadingState from "../components/LoadingState.vue";
import Markdown from "../components/Markdown.vue";
import RemarkList from "../components/RemarkList.vue";
import StatusChip from "../components/StatusChip.vue";
import StepRail from "../components/StepRail.vue";
import { attemptStatus, checkStatus, gateStatus, runStatus, stepStatus, verdictStatus } from "../status";

const props = defineProps<{ id: number }>();
const route = useRoute();
const router = useRouter();

const run = ref<RunDetail | null>(null);
const projectName = ref("");
const error = ref("");
/** Why the Run could not load (a failed action stays in `error`, above the Run). */
const loadError = ref("");

async function load() {
  try {
    run.value = await getJson(`/api/runs/${props.id}`);
    loadError.value = "";
  } catch (e: any) {
    loadError.value = e.message;
  }
}

/** The kept Run Note the human opened (clicking it again closes it). */
const note = ref<RunNote | null>(null);
async function openNote(path: string) {
  if (note.value?.path === path) return void (note.value = null);
  try {
    note.value = await getJson(`/api/runs/${props.id}/notes?path=${encodeURIComponent(path)}`);
  } catch (e: any) {
    error.value = e.message;
  }
}

const abandoning = ref(false);
const OVER = ["merged", "closed", "abandoned"];
async function abandon() {
  if (!window.confirm("Abandon this Run? Its pull request is closed, and its worktree and branches are removed.")) return;
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

// ---- The Step in view: the URL keeps it (`?step=`), so a refresh or a shared link lands on the same Step ----
const rail = computed(() => (run.value ? railOf(run.value) : []));
const wanted = computed(() => (typeof route.query.step === "string" ? route.query.step : null));
const selected = computed(() => (run.value ? resolveSelection(rail.value, wanted.value, run.value) : ""));
const view = computed(() => (run.value ? stepViewOf(run.value, selected.value) : null));
function select(key: string) {
  router.replace({ query: { ...route.query, step: key } });
}

const openGates = computed(() => run.value?.gates.filter((g) => !g.decidedAt) ?? []);
const stepName = (stepId: string | null) => rail.value.find((r) => r.key === stepId)?.label ?? null;
/** The Step labelled in the Gate bar's link: shown only when it is not the Step in view. */
const gateElsewhere = (stepId: string | null) => (stepId && stepId !== selected.value && rail.value.some((r) => r.key === stepId) ? stepId : null);

/** The running Step's latest events, newest last. */
const live = ref<{ attemptId: number; kind: "text" | "tool" | "other"; summary: string; at: string }[]>([]);
const LIVE_LINES = 100;
const liveNow = computed(() => live.value.filter((l) => l.attemptId === view.value?.running?.id));
/** For an `assets` Run: how far the batch is, and the Asset the Artist is drawing now. */
const DRAWN = ["waiting", "approved"];
const drawnCount = computed(() => run.value?.assets.filter((a) => DRAWN.includes(a.status)).length ?? 0);
const runningAttempt = computed(() => run.value?.attempts.find((a) => a.status === "running"));
const drawing = computed(() => run.value?.assets.find((a) => a.id === runningAttempt.value?.assetId));
const showAssets = computed(() => !!run.value?.assets.length && !!view.value && (view.value.step.type === "artist" || view.value.gates.some((g) => g.kind === "asset")));
const turns = computed(() => (run.value && view.value?.step.type === "conversation" ? run.value.conversation.filter((t) => t.stepId === view.value!.step.id) : []));
const agentName = (stepId: string) => (run.value?.steps.find((s) => s.id === stepId)?.detail ?? "Agent").replace(/^./, (c) => c.toUpperCase());
const time = (d: string) => new Date(d).toLocaleTimeString();

let stopFollowing: () => void;
onMounted(() => {
  load();
  getJson<Project[]>("/api/projects").then(
    (all) => (projectName.value = all.find((p) => p.id === run.value?.projectId)?.name ?? ""),
    () => {}, // the Project's name is a convenience in the header
  );
  stopFollowing = liveEvents.follow((u) => {
    if (u.type === "quota" || u.runId !== props.id) return;
    if (u.type === "changed") return void load();
    live.value = [...live.value, { attemptId: u.attemptId, kind: u.kind, summary: u.summary, at: new Date().toLocaleTimeString() }].slice(-LIVE_LINES);
  }, load);
});
onUnmounted(() => stopFollowing?.());
</script>

<template>
  <ErrorState v-if="loadError && !run" title="Could not load this Run" text="The Forgequor server did not answer. Check that it is running, then retry." :details="loadError" @retry="load" />
  <LoadingState v-else-if="!run" what="the Run" />
  <div v-else class="run-detail">
    <div class="head">
      <div>
        <div class="crumbs"><router-link to="/runs">Runs</router-link> / <template v-if="projectName">{{ projectName }} / </template>#{{ run.id }}</div>
        <h1>{{ run.title }}</h1>
        <div class="meta">
          <span>Workflow <b>{{ run.workflow }}</b></span>
          <span v-if="projectName">Project <b>{{ projectName }}</b></span>
          <span v-if="run.branch">Branch <b class="mono">{{ run.branch }}</b></span>
          <span v-if="run.prUrl">Pull request <a :href="run.prUrl" target="_blank" rel="noopener">#{{ run.prNumber }}</a></span>
          <span>Iteration <b>{{ run.iteration }}</b></span>
          <span v-if="run.review">Review <b>{{ run.review }}</b></span>
          <span v-if="run.trackerRef">Tracker <b>{{ run.trackerRef }}</b></span>
          <span>Started <b>{{ new Date(run.createdAt).toLocaleString() }}</b></span>
        </div>
      </div>
      <div class="head-side">
        <StatusChip :status="runStatus(run.state)" />
        <button v-if="!OVER.includes(run.state) && !openGates.some((g) => g.actions.includes('abandon'))" type="button" class="btn btn-danger" :disabled="abandoning" @click="abandon">Abandon Run</button>
      </div>
    </div>
    <p v-if="error || loadError" class="error" role="alert">{{ error || loadError }}</p>
    <p v-if="run.state === 'paused' && run.resumeAt" class="muted">
      The Runner's Quota is used up. This Run restarts its current Step after {{ new Date(run.resumeAt).toLocaleString() }}.
    </p>
    <details class="task">
      <summary>Task</summary>
      <pre>{{ run.task }}</pre>
      <p v-if="run.branch" class="muted">
        <template v-if="!run.archivedAt">Worktree <code>{{ run.worktreePath }}</code></template>
        <template v-else>Archived {{ new Date(run.archivedAt).toLocaleString() }}: the worktree is removed, see the pull request for the files.</template>
      </p>
    </details>

    <div v-if="openGates.length" class="gates" role="region" aria-label="Gate actions">
      <div v-for="g in openGates" :key="g.id" class="gate">
        <div class="why">
          <strong>{{ gateTitle(g) }}</strong>
          {{ g.reason }}
          <button v-if="gateElsewhere(g.stepId)" type="button" class="link" @click="select(gateElsewhere(g.stepId)!)">Show the {{ stepName(g.stepId) }} Step</button>
          <details v-if="g.evidence && !stepName(g.stepId)"><summary>Evidence</summary><pre>{{ g.evidence }}</pre></details>
        </div>
        <GateActions :gate="g" @decided="load" />
      </div>
    </div>

    <div class="layout">
      <StepRail :rail="rail" :selected="selected" @select="select" />

      <section v-if="view" class="panel" role="tabpanel" :aria-label="`Step detail: ${view.item.label}`">
        <div class="panel-head">
          <h2>{{ view.item.label }}</h2>
          <StatusChip :status="view.item.status" />
          <span v-if="view.item.runner" class="runner">{{ view.item.runner }}<template v-if="view.item.model"> · {{ view.item.model }}</template></span>
          <span class="muted note">{{ view.item.note }}</span>
        </div>

        <div v-if="view.remarks?.recommendation && view.openGate" class="reco"><strong>Consolidator's recommendation.</strong> {{ view.remarks.recommendation }}</div>

        <div v-if="view.remarks">
          <h2>Remarks</h2>
          <RemarkList :table="view.remarks" />
        </div>

        <div v-for="g in view.gates" :key="g.id" class="gate-record">
          <h2>{{ gateTitle(g) }} <span class="n">Iteration {{ g.iteration }}</span></h2>
          <p class="muted">{{ g.kind === "asset" && g.decidedAt ? `${g.verdicts.length} ${g.verdicts.length === 1 ? "Asset" : "Assets"} judged.` : g.reason }}</p>
          <Markdown v-if="g.evidence && (g.kind === 'spec' || g.kind === 'conversation')" :text="g.evidence" />
          <details v-else-if="g.evidence" :open="g.kind !== 'review'"><summary>{{ g.kind === "review" ? "What each side said" : "Evidence" }}</summary><pre>{{ g.evidence }}</pre></details>
          <p v-if="g.decidedAt" class="muted">
            <StatusChip :status="gateStatus(g.decision ?? 'abandon')" /> {{ new Date(g.decidedAt).toLocaleString() }}
          </p>
          <pre v-if="g.feedback">{{ g.feedback }}</pre>
        </div>

        <div v-if="showAssets">
          <h2>Assets</h2>
          <p class="progress muted" aria-label="Progress">
            {{ drawnCount }} of {{ run.assets.length }} drawn<span v-if="drawing"> · the Artist is drawing <strong>{{ drawing.name }}</strong> (Asset {{ drawing.position + 1 }}, attempt {{ runningAttempt?.attempt }})</span>
          </p>
          <AssetGallery :run-id="run.id" :iteration="run.iteration" :assets="run.assets" :files-removed="!!run.archivedAt" :gate="run.gates.find((g) => g.kind === 'asset' && !g.decidedAt)" @decided="load" />
        </div>

        <div v-if="turns.length">
          <h2>Conversation</h2>
          <ol class="chat" aria-label="Conversation">
            <li v-for="t in turns" :key="t.id" :class="t.author">
              <strong>{{ t.author === "agent" ? agentName(t.stepId) : "You" }}</strong>
              <span class="badge">{{ { questions: "questions", summary: "proposed summary", answer: "answer", confirm: "confirmed", feedback: "feedback" }[t.kind] }}</span>
              <Markdown :text="t.body" />
            </li>
          </ol>
          <p v-if="view.openGate?.kind === 'conversation'" class="muted">Reply in the Gate bar above.</p>
        </div>

        <div v-if="view.step.type === 'checks'">
          <h2>Checks</h2>
          <p v-if="!run.checks.length" class="muted">None ran.</p>
          <ul class="plain">
            <li v-for="c in run.checks" :key="c.id">
              <code>{{ c.command }}</code> <span class="muted">· iteration {{ c.iteration }} · attempt {{ c.attempt }}</span> <StatusChip :status="checkStatus(c.exitStatus)" />
              <pre v-if="c.output.trim()">{{ c.output }}</pre>
            </li>
          </ul>
        </div>

        <div v-if="view.reviews.length">
          <h2>Reviews</h2>
          <ul class="plain">
            <li v-for="r in view.reviews" :key="r.id">
              <strong>{{ r.author }}</strong> <span class="muted">· iteration {{ r.iteration }} · attempt {{ r.attempt }}</span> <StatusChip :status="verdictStatus(r.verdict)" /><span v-if="r.final" class="badge">final</span>
              <pre>{{ r.body }}</pre>
            </li>
          </ul>
        </div>

        <div v-if="view.feedback.length">
          <h2>Feedback</h2>
          <ul class="plain" aria-label="Feedback">
            <li v-for="i in view.feedback" :key="i.number"><span class="muted">Iteration {{ i.number }}</span><pre>{{ i.feedback }}</pre></li>
          </ul>
        </div>

        <div v-if="view.running">
          <h2>Live events</h2>
          <div class="log" role="log" aria-live="polite" aria-label="Live progress">
            <div v-if="!liveNow.length" class="muted">Waiting for the Agent's first event…</div>
            <div v-for="(l, i) in liveNow" :key="i"><span class="t">{{ l.at }}</span> <span class="kind">{{ l.kind }}</span> {{ l.summary }}</div>
          </div>
        </div>

        <div v-if="view.attempts.length">
          <h2>Output</h2>
          <ul class="plain" aria-label="Step attempts">
            <li v-for="a in [...view.attempts].reverse()" :key="a.id">
              <strong>Iteration {{ a.iteration }} · attempt {{ a.attempt }}</strong>
              <span v-if="a.assetId" class="muted"> · {{ run.assets.find((x) => x.id === a.assetId)?.name }}</span>
              <StatusChip :status="attemptStatus(a.status)" />
              <div class="muted">{{ time(a.startedAt) }}<span v-if="a.endedAt"> → {{ time(a.endedAt) }}</span></div>
              <pre v-if="a.error">{{ a.error }}</pre>
              <pre v-else-if="a.summary">{{ a.summary }}</pre>
            </li>
          </ul>
        </div>
        <p v-else-if="!view.gates.length && !view.remarks && !turns.length && view.step.type !== 'checks'" class="muted">Nothing to show for this Step yet.</p>

        <div v-if="view.seats.length">
          <h2>Seats used</h2>
          <ul class="plain seats" aria-label="Seats used">
            <li v-for="s in view.seats" :key="`${s.agent}-${s.runner}-${s.model}`">
              {{ s.agent }} <span class="runner">{{ s.runner }}<template v-if="s.model"> · {{ s.model }}</template></span>
              <span class="muted"> · {{ s.attempts }} {{ s.attempts === 1 ? "attempt" : "attempts" }}</span>
            </li>
          </ul>
        </div>

        <div v-if="run.runNotes.length">
          <h2>Run Notes</h2>
          <p class="muted">Kept from the removed worktree.</p>
          <ul class="plain" aria-label="Run Notes">
            <li v-for="n in run.runNotes" :key="n.path">
              <a href="#" @click.prevent="openNote(n.path)"><code>{{ n.path }}</code></a>
              <span class="muted"> · {{ n.size }} bytes</span>
              <template v-if="note?.path === n.path">
                <Markdown v-if="/\.(md|markdown)$/i.test(n.path)" :text="note.content" />
                <pre v-else>{{ note.content }}</pre>
              </template>
            </li>
          </ul>
        </div>
      </section>
    </div>
  </div>
</template>

<style>
/* The Run detail needs the width the rail and the panel share: lift the shell's reading-width cap for it. */
.app .content:has(.run-detail) { max-width: none; }
</style>

<style scoped>
.run-detail { display: flex; flex-direction: column; gap: var(--sp-5); }
.crumbs { font-size: var(--fs-sm); color: var(--text-muted); margin-bottom: var(--sp-1); }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-4); flex-wrap: wrap; }
.head-side { display: flex; align-items: center; gap: var(--sp-3); }
h1 { font: 700 var(--fs-xl)/1.2 var(--font-brand); letter-spacing: 0.03em; }
.run-detail h2 { font: 700 var(--fs-sm) var(--font-brand); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ice-blue); margin: 0 0 var(--sp-3); }
.run-detail h2 .n { color: var(--action); margin-left: 0.4rem; letter-spacing: 0.04em; text-transform: none; font-family: var(--font-ui); font-weight: 500; }
.meta { margin-top: var(--sp-2); display: flex; gap: var(--sp-4); flex-wrap: wrap; font-size: var(--fs-xs); color: var(--text-muted); }
.meta b { color: var(--ice-blue); font-weight: 500; }
.run-detail p { margin: 0; }
.task { font-size: var(--fs-sm); color: var(--text-muted); }
.task summary { cursor: pointer; }
.task pre, pre { white-space: pre-wrap; background: rgb(8 15 25 / 0.7); border: 1px solid var(--border); padding: var(--sp-3); border-radius: var(--radius-md); margin: var(--sp-2) 0 0; font: var(--fs-xs)/1.6 var(--font-mono); color: var(--text); }

/* Gate bar: fixed at the top of the content while a Gate is open */
.gates { position: sticky; top: 0; z-index: 2; display: flex; flex-direction: column; gap: var(--sp-2); }
.gate { border: 1px solid var(--action); border-radius: var(--radius-lg); padding: var(--sp-4) var(--sp-5); background: linear-gradient(90deg, rgb(255 140 36 / 0.16), rgb(16 29 45 / 0.97)); box-shadow: 0 0 28px rgb(255 140 36 / 0.18); display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; max-height: 70vh; overflow-y: auto; }
.gate .why { flex: 1; min-width: 18rem; font-size: var(--fs-sm); }
.gate strong { font: 700 var(--fs-sm) var(--font-brand); letter-spacing: 0.06em; color: var(--molten-gold); display: block; margin-bottom: 2px; text-transform: uppercase; }
.link { background: none; border: 0; padding: 0; margin-left: var(--sp-2); color: var(--link); font: inherit; font-size: var(--fs-xs); cursor: pointer; text-decoration: underline; }
.gate details { font-size: var(--fs-xs); }

.layout { display: grid; grid-template-columns: 290px minmax(0, 1fr); gap: var(--sp-6); align-items: start; }
.panel { background: linear-gradient(180deg, rgb(23 40 61 / 0.85), rgb(16 29 45 / 0.85)); border: 1px solid var(--border-strong); border-radius: var(--radius-lg); padding: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-5); box-shadow: 0 0 0 1px rgb(56 189 248 / 0.06), 0 12px 40px rgb(0 0 0 / 0.35); min-width: 0; }
.panel-head { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
.run-detail .panel-head h2 { margin: 0; font-size: var(--fs-md); }
.note { font-size: var(--fs-xs); }
.reco { border-radius: var(--radius-md); padding: var(--sp-4); border: 1px solid rgb(56 189 248 / 0.45); background: rgb(56 189 248 / 0.08); font-size: var(--fs-sm); box-shadow: 0 0 20px rgb(56 189 248 / 0.12); }
.reco strong { color: var(--ai); }
.gate-record { display: flex; flex-direction: column; gap: var(--sp-2); font-size: var(--fs-sm); }
.gate-record details summary { cursor: pointer; color: var(--text-muted); }
.plain { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--sp-3); font-size: var(--fs-sm); }
.plain li { background: none; padding: 0; margin: 0; }
.seats .runner { margin-left: var(--sp-2); }
.log { background: #050a12; border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--sp-3); font: var(--fs-xs)/1.6 var(--font-mono); color: #b9c6d6; max-height: 18rem; overflow-y: auto; }
.log .t { color: var(--ai); }
.log .kind { color: var(--text-muted); }
.chat { list-style: none; padding: 0; margin: 0; font-size: var(--fs-sm); }
.chat li { margin: var(--sp-2) 0; padding: var(--sp-3); border-radius: var(--radius-md); border: 1px solid var(--border); background: rgb(8 15 25 / 0.55); }
.chat li.human { margin-left: 2rem; border-color: var(--border-strong); }
.badge { margin-left: var(--sp-2); padding: 0 0.45rem; border-radius: 999px; background: var(--ai); color: var(--bg); font-size: var(--fs-xs); font-weight: 700; }
</style>
