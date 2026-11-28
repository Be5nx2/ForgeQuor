<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { getJson, postJson, type ArtInfo, type AssetKind, type Project, type QuotaStatus, type ReviewMode, type Run, type Team, type TeamSeat, type WorkflowList, type WorkflowOption } from "../api";

const router = useRouter();

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
const launchable = computed(() => !!chosen.value && !chosen.value.errors.length);
const originLabel = (w: WorkflowOption) => (w.origin === "project" ? "Project" : "built-in");

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
/** Each vendor's latest Quota Reading, to warn next to a seat whose Runner is exhausted. */
const quota = ref<QuotaStatus[]>([]);

async function loadSeats() {
  const [t, q] = await Promise.all([getJson<Team>("/api/team").catch(() => null), getJson<QuotaStatus[]>("/api/quota").catch((): QuotaStatus[] => [])]);
  quota.value = q;
  team.value = t;
  seatDrafts.value = Object.fromEntries((t?.seats ?? []).map((s) => [s.seat, { runner: s.runner.value ?? "", model: s.model.value ?? "" }]));
}

const offeredModels = (s: TeamSeat) => team.value?.models[seatDrafts.value[s.seat]!.runner] ?? [];
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

/** False until the Projects arrive, so the page never says "Register a Project first" while loading or after a failure. */
const projectsLoaded = ref(false);
const projectsError = ref("");

async function loadProjects() {
  try {
    const known = await getJson<Project[]>("/api/projects");
    projects.value = known;
    form.value.projectId ||= String(known[0]?.id ?? "");
    projectsLoaded.value = true;
  } catch (e: any) {
    projectsError.value = `Could not load the Projects: ${e.message}`;
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
  <h2>New Run</h2>
  <p v-if="projectsError" class="error">{{ projectsError }}</p>
  <p v-else-if="!projectsLoaded" class="muted" role="status">Loading…</p>
  <p v-else-if="!projects.length" class="muted">Register a Project first.</p>
  <form v-else class="stack" @submit.prevent="start">
    <select v-model="form.projectId" aria-label="Project">
      <option v-for="p in projects" :key="p.id" :value="String(p.id)">{{ projectLabel(p) }}</option>
    </select>
    <p v-if="workflowsLoading" class="muted" role="status">Loading Workflows…</p>
    <select v-else v-model="form.workflow" aria-label="Workflow">
      <option v-for="w in workflows" :key="w.name" :value="w.name">{{ w.name }} ({{ originLabel(w) }}){{ w.description ? `: ${w.description}` : "" }}</option>
    </select>
    <p v-if="workflowsProblem" class="error">{{ workflowsProblem }}</p>
    <p v-if="invalidWorkflows" class="muted">{{ invalidWorkflows }} invalid Workflow{{ invalidWorkflows > 1 ? "s are" : " is" }} not offered: see the Workflows tab.</p>
    <textarea v-if="asks('task')" v-model="form.task" rows="4" placeholder="Task or bug description" aria-label="Task" required />
    <fieldset v-if="asks('review')" class="review-choice">
      <legend>Review</legend>
      <label><input v-model="form.review" type="radio" value="solo" aria-label="Solo review" /> Solo: one Reviewer</label>
      <label><input v-model="form.review" type="radio" value="duo" aria-label="Duo review" /> Duo: two Reviewers, one consolidated Review</label>
    </fieldset>
    <template v-if="asks('assets')">
      <fieldset v-for="(a, i) in assets" :key="i" class="stack asset-request">
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
        <button v-if="assets.length > 1" type="button" class="secondary" @click="assets.splice(i, 1)">Remove</button>
      </fieldset>
      <button type="button" class="secondary" @click="assets.push(newAsset())">Add an Asset</button>
    </template>
    <details v-if="team" class="seats">
      <summary>Seats</summary>
      <p class="muted">Each seat's Runner and model for this Run only; the Team page keeps the defaults. Left as they are, the Run uses the Team's settings as they are when it starts.</p>
      <div v-for="s in team.seats" :key="s.seat" class="stack seat">
        <strong>{{ s.seat }}</strong>
        <label>
          Runner
          <select v-model="seatDrafts[s.seat]!.runner" :disabled="s.runner.source === 'env'" :aria-label="`Runner of ${s.seat} for this Run`">
            <option v-for="r in Object.keys(team.models)" :key="r" :value="r">{{ r }}</option>
          </select>
        </label>
        <label>
          Model
          <input v-model="seatDrafts[s.seat]!.model" :list="`run-models-${s.seat}`" :disabled="s.model.source === 'env'" placeholder="the Runner's own default" :aria-label="`Model of ${s.seat} for this Run`" />
          <datalist :id="`run-models-${s.seat}`">
            <option v-for="m in offeredModels(s)" :key="m" :value="m" />
          </datalist>
        </label>
        <span v-if="lockedBy(s)" class="muted">locked by {{ lockedBy(s) }}</span>
        <span v-if="exhaustion(s)" class="error" role="status">{{ exhaustion(s) }}</span>
      </div>
    </details>
    <input v-model="form.title" placeholder="Title (derived from the task or Assets if empty)" aria-label="Title" />
    <input v-model="form.trackerRef" placeholder="Tracker reference (optional, e.g. $12a)" aria-label="Tracker reference" />
    <button type="submit" :disabled="workflowsLoading || !launchable">Start Run</button>
  </form>
  <p v-if="error" class="error">{{ error }}</p>
</template>
