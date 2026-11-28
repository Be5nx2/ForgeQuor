<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { getJson, postJson, type ArtInfo, type AssetKind, type Project, type QuotaStatus, type ReviewMode, type Run, type Team, type TeamSeat, type WorkflowList, type WorkflowOption } from "../api";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import LoadingState from "../components/LoadingState.vue";
import { gatesSentence, previewOf, quotaHint } from "../newRun";

const router = useRouter();
const route = useRoute();

const projects = ref<Project[]>([]);
const form = ref({ projectId: "", workflow: "developer", task: "", title: "", trackerRef: "", review: "solo" as ReviewMode });
/** The chosen Project's Workflows (built-in and its own), and why its own could not be read. */
const workflows = ref<WorkflowOption[]>([]);
const workflowsProblem = ref("");
/** How many of the Project's Workflows are invalid, so not offered: the Workflows tab says why. */
const invalidWorkflows = ref(0);
/** True while the chosen Project's Workflows are being fetched (the remote is read, which takes a few seconds). */
const workflowsLoading = ref(false);
const chosen = computed(() => workflows.value.find((w) => w.name === form.value.workflow));
/** The form asks for what the chosen Workflow takes at launch. */
const asks = (input: "task" | "assets" | "review") => chosen.value?.inputs.includes(input) ?? false;
/** The review mode starts at the chosen Workflow's own default (solo for bugfix), and the human may change it. */
watch(chosen, (w) => {
  form.value.review = w?.reviewDefault ?? "solo";
});
/** Arrow keys move through the Workflow choice like a radio group. */
function pickNext(step: number) {
  const names = workflows.value.map((w) => w.name);
  if (!names.length) return;
  const at = names.indexOf(form.value.workflow);
  form.value.workflow = names[(at + step + names.length) % names.length]!;
  // Focus follows the choice, as in a native radio group.
  void nextTick(() => document.querySelector<HTMLElement>('.choices [role="radio"][aria-checked="true"]')?.focus());
}
const launchable = computed(() => !!chosen.value && !chosen.value.errors.length);

/** The size presets of an Asset Request; "custom" shows the width and height fields. */
const SIZES = ["16x16", "18x18", "32x32"];
/** What the chosen Project's Art Direction says, to preset the size and offer reference images. */
const art = ref<ArtInfo>({ present: false, defaultSize: null, references: [], images: [] });
const defaultSize = computed(() => (art.value.defaultSize ? `${art.value.defaultSize.width}x${art.value.defaultSize.height}` : null));
/** The Art Direction's default size comes first, then the usual ones. */
const sizes = computed(() => [...new Set([...(defaultSize.value ? [defaultSize.value] : []), ...SIZES])]);
interface AssetDraft {
  name: string;
  kind: AssetKind;
  description: string;
  size: string;
  fill: boolean;
  replace: boolean;
  references: string[];
  frames: number;
  width: number;
  height: number;
}
const newAsset = (): AssetDraft => ({
  name: "",
  kind: "sprite",
  description: "",
  size: defaultSize.value ?? "16x16",
  fill: false,
  replace: false,
  references: [],
  frames: 4,
  width: 16,
  height: 16,
});
const assets = ref<AssetDraft[]>([newAsset()]);
const sizeOf = (a: AssetDraft) => (a.size === "custom" ? { width: a.width, height: a.height } : { width: Number(a.size.split("x")[0]), height: Number(a.size.split("x")[1]) });
const error = ref("");

/** The Team as it is now: the "Seats" section starts from it, and a Run overrides only what the human changes here. */
const team = ref<Team | null>(null);
const seatDrafts = ref<Record<string, { runner: string; model: string }>>({});
/** Each vendor's latest Quota Reading, to warn next to a seat whose Runner is exhausted and to hint at the Quota left. */
const quota = ref<QuotaStatus[]>([]);

async function loadSeats() {
  const [t, q] = await Promise.all([getJson<Team>("/api/team").catch(() => null), getJson<QuotaStatus[]>("/api/quota").catch((): QuotaStatus[] => [])]);
  quota.value = q;
  team.value = t;
  seatDrafts.value = Object.fromEntries((t?.seats ?? []).map((s) => [s.seat, { runner: s.runner.value ?? "", model: s.model.value ?? "" }]));
}

const offeredModels = (s: TeamSeat) => team.value?.catalog[seatDrafts.value[s.seat]!.runner]?.models.map((m) => m.id) ?? [];
const lockedBy = (s: TeamSeat) => [s.runner.variable, s.model.variable].filter(Boolean).join(", ");

function exhaustion(s: TeamSeat): string {
  const runner = seatDrafts.value[s.seat]!.runner;
  const reading = quota.value.find((q) => q.vendor === runner)?.reading;
  if (!reading?.exhausted) return "";
  const used = (w: { percentUsed: number | null }) => w.percentUsed !== null && w.percentUsed >= 100;
  const window = used(reading.fiveHour) ? reading.fiveHour : used(reading.weekly) ? reading.weekly : reading.fiveHour.resetsAt ? reading.fiveHour : reading.weekly;
  return window.resetsAt ? `${runner}'s Quota is used up, it resets ${new Date(window.resetsAt).toLocaleString()}.` : `${runner}'s Quota is used up (reset time unknown).`;
}

/** Only the fields the human changed, and never one the environment holds. */
function seatOverrides(): Record<string, { runner?: string; model?: string }> | undefined {
  const out: Record<string, { runner?: string; model?: string }> = {};
  for (const s of team.value?.seats ?? []) {
    const draft = seatDrafts.value[s.seat]!;
    const change: { runner?: string; model?: string } = {};
    if (s.runner.source !== "env" && draft.runner && draft.runner !== (s.runner.value ?? "")) change.runner = draft.runner;
    if (s.model.source !== "env" && draft.model && draft.model !== (s.model.value ?? "")) change.model = draft.model;
    if (Object.keys(change).length) out[s.seat] = change;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The Project the URL asks for (`?project=7`, set by the sidebar's Project selector), or "". */
const queryProject = computed(() => {
  const q = route.query.project;
  return (Array.isArray(q) ? q[0] : q) ?? "";
});
// Picking another Project in the sidebar while this screen is open moves the form with it.
watch(queryProject, (id) => {
  if (id && projects.value.some((p) => String(p.id) === id)) form.value.projectId = id;
});

/** False until the Projects arrive, so the page never says "Register a Project first" while loading or after a failure. */
const projectsLoaded = ref(false);
const projectsError = ref("");

async function loadProjects() {
  try {
    const known = await getJson<Project[]>("/api/projects");
    projects.value = known;
    projectsError.value = "";
    // An unknown `?project=` is ignored: the first Project is offered.
    form.value.projectId ||= known.some((p) => String(p.id) === queryProject.value) ? queryProject.value : String(known[0]?.id ?? "");
    projectsLoaded.value = true;
  } catch (e: any) {
    projectsError.value = e.message;
  }
}

async function start() {
  error.value = "";
  try {
    const run = await postJson<Run>("/api/runs", {
      projectId: Number(form.value.projectId),
      workflow: form.value.workflow,
      task: asks("task") ? form.value.task : undefined,
      assets: asks("assets") ? assets.value.map((a) => ({ name: a.name, kind: a.kind, description: a.description, fill: a.fill, replace: a.replace, references: a.references, frames: a.kind === "animation" ? a.frames : undefined, ...sizeOf(a) })) : undefined,
      review: asks("review") ? form.value.review : undefined,
      title: form.value.title || undefined,
      trackerRef: form.value.trackerRef || undefined,
      seats: seatOverrides(),
    });
    form.value = { ...form.value, task: "", title: "", trackerRef: "" };
    assets.value = [newAsset()];
    void loadSeats();
    router.push(`/runs/${run.id}`);
  } catch (e: any) {
    error.value = e.message;
  }
}

// Same-named Projects are told apart by their local path in the menu.
const projectLabel = (p: Project) => `${p.name} (${p.localPath})`;

const projectName = computed(() => projects.value.find((p) => String(p.id) === form.value.projectId)?.name ?? "");
const runnerOf = (seat: string) => seatDrafts.value[seat]?.runner || null;
const capital = (name: string | null) => (name ? name.charAt(0).toUpperCase() + name.slice(1) : "");
const soloLabel = computed(() => `Solo · ${capital(runnerOf("reviewer-a")) || "one Reviewer"}`);
const duoLabel = computed(() => `Duo · ${[runnerOf("reviewer-a"), runnerOf("reviewer-b")].filter(Boolean).map(capital).join(" + ") || "two Reviewers"}`);
/** What the Run will do with the Workflow, the review mode and the seats as they are in the form now. */
const preview = computed(() => (chosen.value ? previewOf(chosen.value, form.value.review, runnerOf) : null));
const hint = computed(() => quotaHint(quota.value));
const lockedSeats = computed(() => (team.value?.seats ?? []).filter(lockedBy).length);

onMounted(loadProjects);
onMounted(loadSeats);
// The Art Direction's default size presets the Assets not yet filled in; a Project without images or Art Direction offers nothing.
watch(
  () => form.value.projectId,
  async (id) => {
    // Shown before any request: reading the Project's art facts already fetches its remote.
    workflows.value = [];
    workflowsProblem.value = "";
    workflowsLoading.value = !!id;
    const none: ArtInfo = { present: false, defaultSize: null, references: [], images: [] };
    const fetched = id ? await getJson<ArtInfo>(`/api/projects/${id}/art-info`).catch(() => none) : none;
    const noWorkflows: WorkflowList = { workflows: [], problem: null };
    const list = id ? await getJson<WorkflowList>(`/api/projects/${id}/workflows`).catch((e): WorkflowList => ({ workflows: [], problem: `Could not load the Workflows: ${e.message}` })) : noWorkflows;
    // A quicker switch to another Project already moved on: drop this answer.
    if (form.value.projectId !== id) return;
    workflowsLoading.value = false;
    workflows.value = list.workflows.filter((w) => !w.errors.length);
    invalidWorkflows.value = list.workflows.length - workflows.value.length;
    workflowsProblem.value = list.problem ?? "";
    // The Workflow picked for the previous Project may not exist here: fall back to the first one.
    if (!workflows.value.some((w) => w.name === form.value.workflow)) form.value.workflow = workflows.value[0]?.name ?? "developer";
    art.value = fetched;
    // References are the previous Project's images; the preset size is the new Project's.
    assets.value = assets.value.map((a) => (a.name || a.description ? { ...a, references: [] } : newAsset()));
  },
  { immediate: true },
);
</script>

<template>
  <ErrorState v-if="projectsError" title="Could not load the Projects" text="The Forgequor server did not answer. Check that it is running, then retry." :details="projectsError" @retry="loadProjects" />
  <LoadingState v-else-if="!projectsLoaded" what="Projects" />
  <EmptyState v-else-if="!projects.length" title="No Project yet" text="Forgequor works on a git repository. Register your first Project to start a Run.">
    <router-link class="btn btn-primary" to="/projects">Register a Project</router-link>
  </EmptyState>
  <template v-else>
    <div class="head">
      <div class="crumbs"><router-link to="/runs">Runs</router-link> / New</div>
      <h1>New Run</h1>
      <p class="lede">{{ projectName }} · one Run, one branch, one pull request</p>
    </div>

    <div class="formgrid">
      <form class="panel" @submit.prevent="start">
        <div class="field">
          <label for="nr-project">Project</label>
          <select id="nr-project" v-model="form.projectId">
            <option v-for="p in projects" :key="p.id" :value="String(p.id)">{{ projectLabel(p) }}</option>
          </select>
        </div>
        <div class="field">
          <span id="nr-wf" class="label">Workflow</span>
          <LoadingState v-if="workflowsLoading" what="Workflows" />
          <div v-else class="choices" role="radiogroup" aria-labelledby="nr-wf">
            <div
              v-for="w in workflows"
              :key="w.name"
              class="choice"
              role="radio"
              :aria-checked="w.name === form.workflow"
              :tabindex="w.name === form.workflow ? 0 : -1"
              @click="form.workflow = w.name"
              @keydown.enter.prevent="form.workflow = w.name"
              @keydown.space.prevent="form.workflow = w.name"
              @keydown.down.prevent="pickNext(1)"
              @keydown.right.prevent="pickNext(1)"
              @keydown.up.prevent="pickNext(-1)"
              @keydown.left.prevent="pickNext(-1)"
            >
              <strong>{{ w.name }}</strong>
              <small>{{ w.description || "No description." }}</small>
              <span v-if="w.origin === 'project'" class="origin">Project</span>
            </div>
          </div>
          <p v-if="workflowsProblem" class="error">{{ workflowsProblem }}</p>
          <span v-if="invalidWorkflows" class="hint">{{ invalidWorkflows }} invalid Workflow{{ invalidWorkflows > 1 ? "s are" : " is" }} not offered: see the Workflows tab.</span>
        </div>
        <div v-if="asks('task')" class="field">
          <label for="nr-subject">Subject</label>
          <textarea id="nr-subject" v-model="form.task" rows="4" placeholder="Task or bug description" required />
          <span class="hint">A few words are enough: the Griller will ask the rest.</span>
        </div>
        <div v-if="asks('review')" class="field">
          <span id="nr-review" class="label">Review</span>
          <div class="seg" role="group" aria-labelledby="nr-review">
            <button type="button" :aria-pressed="form.review === 'solo'" aria-label="Solo review" @click="form.review = 'solo'">{{ soloLabel }}</button>
            <button type="button" :aria-pressed="form.review === 'duo'" aria-label="Duo review" @click="form.review = 'duo'">{{ duoLabel }}</button>
          </div>
          <span class="hint">{{ chosen?.reviewDefault === form.review ? "Workflow default preselected. " : "" }}{{ form.review === "duo" ? "Two Reviewers, one consolidated Review: spends Quota on both Runners." : "One Reviewer." }}</span>
        </div>
        <template v-if="asks('assets')">
          <fieldset v-for="(a, i) in assets" :key="i" class="asset-request">
            <legend>Asset Request {{ i + 1 }}</legend>
            <input v-model="a.name" placeholder="Name (e.g. Hero idle)" aria-label="Asset name" required />
            <select v-model="a.kind" aria-label="Asset kind">
              <option value="sprite">sprite</option>
              <option value="tile">tile</option>
              <option value="animation">animation strip</option>
            </select>
            <label v-if="a.kind === 'animation'">
              Frames (side by side, each of the size below)
              <input v-model.number="a.frames" type="number" min="2" step="1" aria-label="Asset frames" />
            </label>
            <textarea v-model="a.description" rows="2" placeholder="What it shows" aria-label="Asset description" required />
            <select v-model="a.size" aria-label="Asset size">
              <option v-for="size in sizes" :key="size" :value="size">{{ size }}{{ size === defaultSize ? " (Art Direction)" : "" }}</option>
              <option value="custom">custom…</option>
            </select>
            <label v-if="art.images.length">
              Style references (existing images; those the Art Direction names are always given)
              <select v-model="a.references" multiple size="4" aria-label="Asset references">
                <option v-for="image in art.images" :key="image" :value="image">{{ image }}</option>
              </select>
            </label>
            <label class="fill"><input v-model="a.replace" type="checkbox" aria-label="Asset replaces an existing file" /> Replaces the existing file at its path</label>
            <label class="fill"><input v-model="a.fill" type="checkbox" aria-label="Asset fills its square" /> Fills its whole square (no transparency, e.g. a ground tile)</label>
            <div v-if="a.size === 'custom'">
              <input v-model.number="a.width" type="number" min="1" step="1" aria-label="Asset width" />
              ×
              <input v-model.number="a.height" type="number" min="1" step="1" aria-label="Asset height" />
            </div>
            <button v-if="assets.length > 1" type="button" class="btn" @click="assets.splice(i, 1)">Remove</button>
          </fieldset>
          <button type="button" class="btn add-asset" @click="assets.push(newAsset())">Add an Asset</button>
        </template>
        <details v-if="team" class="seats">
          <summary>Seats <span v-if="lockedSeats" class="muted">· {{ lockedSeats }} with a locked field</span></summary>
          <p class="hint">Each seat's Runner and model for this Run only; the Team page keeps the defaults. Left as they are, the Run uses the Team's settings as they are when it starts.</p>
          <div v-for="s in team.seats" :key="s.seat" class="seat">
            <strong>{{ s.seat }}</strong>
            <label>
              Runner
              <select v-model="seatDrafts[s.seat]!.runner" :disabled="s.runner.source === 'env'" :aria-label="`Runner of ${s.seat} for this Run`">
                <option v-for="r in Object.keys(team.catalog)" :key="r" :value="r">{{ r }}</option>
              </select>
            </label>
            <label>
              Model
              <input v-model="seatDrafts[s.seat]!.model" :list="`run-models-${s.seat}`" :disabled="s.model.source === 'env'" placeholder="the Runner's own default" :aria-label="`Model of ${s.seat} for this Run`" />
              <datalist :id="`run-models-${s.seat}`">
                <option v-for="m in offeredModels(s)" :key="m" :value="m" />
              </datalist>
            </label>
            <span v-if="lockedBy(s)" class="lock" title="Held by the environment: change it there, not here">Locked by {{ lockedBy(s) }}</span>
            <span v-if="exhaustion(s)" class="error" role="status">{{ exhaustion(s) }}</span>
          </div>
        </details>
        <div class="field">
          <label for="nr-title">Title</label>
          <input id="nr-title" v-model="form.title" type="text" placeholder="Derived from the task or Assets if empty" />
        </div>
        <div class="field">
          <label for="nr-ref">Tracker reference</label>
          <input id="nr-ref" v-model="form.trackerRef" type="text" placeholder="Optional, e.g. $12a" />
        </div>
        <p v-if="error" class="error">{{ error }}</p>
        <div class="actions">
          <router-link class="btn btn-ghost" to="/runs">Cancel</router-link>
          <button class="btn btn-primary" type="submit" :disabled="workflowsLoading || !launchable">Start Run</button>
        </div>
      </form>

      <aside aria-label="What will happen">
        <div class="panel tight">
          <h2>What will happen</h2>
          <LoadingState v-if="workflowsLoading" what="Workflows" />
          <template v-else-if="preview">
            <ul class="steps-preview">
              <li v-for="r in preview.rows" :key="r.id" :class="{ human: r.human }">
                <span>{{ r.label }}<span v-if="r.conditional" class="muted"> · if Assets</span></span>
                <span v-if="r.human && !r.runner" class="muted">you</span>
                <span v-else-if="r.human" class="runner">{{ r.runner }} · you</span>
                <span v-else-if="r.runner" class="runner">{{ r.runner }}</span>
              </li>
            </ul>
            <p class="lede">{{ gatesSentence(preview) }} <template v-if="hint">{{ hint }}</template></p>
          </template>
          <p v-else class="lede">Pick a Workflow to see its Steps.</p>
        </div>
      </aside>
    </div>
  </template>
</template>

<style scoped>
/* The New Run screen of new-run.html: the form panel beside "What will happen". */
.head { margin-bottom: var(--sp-5); }
.crumbs { font-size: var(--fs-sm); color: var(--text-muted); margin-bottom: var(--sp-1); }
.crumbs a { color: inherit; }
h1 { font: 700 var(--fs-xl, 1.5rem) var(--font-brand); letter-spacing: 0.06em; margin: 0; }
.lede { color: var(--text-muted); font-size: var(--fs-sm); margin: var(--sp-1) 0 0; }
.formgrid { display: grid; grid-template-columns: minmax(0, 1fr) 22rem; gap: var(--sp-6); align-items: start; }
@media (max-width: 60rem) { .formgrid { grid-template-columns: minmax(0, 1fr); } }
.panel { background: linear-gradient(180deg, rgb(23 40 61 / 0.85), rgb(16 29 45 / 0.85)); border: 1px solid var(--border-strong); border-radius: var(--radius-lg); padding: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-5); box-shadow: 0 0 0 1px rgb(56 189 248 / 0.06), 0 12px 40px rgb(0 0 0 / 0.35); }
.panel.tight { gap: var(--sp-3); }
.panel h2 { font: 700 var(--fs-sm) var(--font-brand); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ice-blue); margin: 0; }
.field { display: flex; flex-direction: column; gap: var(--sp-2); }
.field > label, .label { font-size: var(--fs-sm); font-weight: 600; }
.hint { font-size: var(--fs-xs); color: var(--text-muted); }
.field select, .field input, .field textarea { width: 100%; box-sizing: border-box; background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius-md); padding: 0.65rem 0.75rem; font: var(--fs-sm) var(--font-ui); }
.field textarea { min-height: 6rem; resize: vertical; }
.choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: var(--sp-3); }
.choice { border: 1px solid var(--border-strong); border-radius: var(--radius-md); padding: var(--sp-3) var(--sp-4); background: rgb(8 15 25 / 0.55); cursor: pointer; font-size: var(--fs-sm); position: relative; }
.choice strong { display: block; margin-bottom: 2px; }
.choice small { color: var(--text-muted); display: block; }
.choice[aria-checked="true"] { border-color: var(--ai); box-shadow: 0 0 16px rgb(56 189 248 / 0.2); background: rgb(56 189 248 / 0.08); }
.choice:focus-visible { outline: 2px solid var(--ice-blue); outline-offset: 2px; }
.origin { position: absolute; top: var(--sp-2); right: var(--sp-3); font-size: var(--fs-xs); color: var(--molten-gold); }
.seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--border-strong); border-radius: var(--radius-md); overflow: hidden; align-self: flex-start; }
.seg button { background: transparent; border: 0; border-radius: 0; color: var(--text-muted); padding: 0.5rem 1.1rem; font: 600 var(--fs-sm) var(--font-ui); cursor: pointer; }
.seg [aria-pressed="true"] { background: rgb(56 189 248 / 0.18); color: var(--text); }
.actions { display: flex; gap: var(--sp-3); justify-content: flex-end; }
.actions .btn { text-decoration: none; }
.actions .btn:disabled { opacity: 0.5; cursor: not-allowed; }
.steps-preview { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--sp-2); font-size: var(--fs-sm); }
.steps-preview li { display: flex; justify-content: space-between; gap: var(--sp-3); padding: 0.4rem 0.6rem; border: 1px solid var(--border); border-radius: var(--radius-md); }
.steps-preview li.human { border-color: var(--action); background: rgb(255 140 36 / 0.08); }
.runner { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ice-blue); }

/* Asset Requests and Seats keep their M3/M4 fields, restyled. */
fieldset.asset-request { display: flex; flex-direction: column; gap: var(--sp-2); border: 1px solid var(--border-strong); border-radius: var(--radius-md); margin: 0; padding: var(--sp-3) var(--sp-4); }
fieldset.asset-request legend { color: var(--ice-blue); font-size: var(--fs-sm); }
fieldset.asset-request label { display: flex; flex-direction: column; gap: 0.25rem; font-size: var(--fs-sm); }
fieldset.asset-request label.fill { flex-direction: row; align-items: center; }
fieldset.asset-request input, fieldset.asset-request select, fieldset.asset-request textarea { background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius-md); padding: 0.5rem 0.6rem; font: var(--fs-sm) var(--font-ui); }
fieldset.asset-request input[type="checkbox"] { flex: none; }
fieldset.asset-request input[type="number"] { width: 5rem; }
fieldset.asset-request .btn { align-self: flex-start; }
.add-asset { align-self: flex-start; }
.seats { border: 1px solid var(--border-strong); border-radius: var(--radius-md); padding: var(--sp-3) var(--sp-4); }
.seats summary { cursor: pointer; font-weight: 600; font-size: var(--fs-sm); }
.seat { display: grid; grid-template-columns: 8rem 1fr 1fr; gap: var(--sp-2) var(--sp-3); align-items: end; padding: var(--sp-3) 0; border-top: 1px solid var(--border); font-size: var(--fs-sm); }
.seat strong { align-self: center; }
.seat label { display: flex; flex-direction: column; gap: 0.25rem; font-size: var(--fs-xs); color: var(--text-muted); }
.seat select, .seat input { background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius-md); padding: 0.45rem 0.6rem; font: var(--fs-sm) var(--font-ui); min-width: 0; }
.seat :disabled { opacity: 0.55; cursor: not-allowed; }
.lock, .seat .error { grid-column: 2 / -1; font-size: var(--fs-xs); }
.lock { color: var(--molten-gold); }
.lock::before { content: "\1F512  "; }
@media (max-width: 40rem) { .seat { grid-template-columns: 1fr; } .lock, .seat .error { grid-column: 1; } }
</style>
