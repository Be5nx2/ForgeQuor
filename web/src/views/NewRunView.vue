<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { getJson, postJson, type ArtInfo, type AssetKind, type Project, type Run, type WorkflowList, type WorkflowOption } from "../api";

const emit = defineEmits<{ open: [id: number] }>();

const projects = ref<Project[]>([]);
const form = ref({ projectId: "", workflow: "developer", task: "", title: "", trackerRef: "" });
/** The chosen Project's Workflows (built-in and its own), and why its own could not be read. */
const workflows = ref<WorkflowOption[]>([]);
const workflowsProblem = ref("");
/** True while the chosen Project's Workflows are being fetched (the remote is read, which takes a few seconds). */
const workflowsLoading = ref(false);
const chosen = computed(() => workflows.value.find((w) => w.name === form.value.workflow));
/** The form asks for what the chosen Workflow takes at launch. */
const asks = (input: "task" | "assets") => chosen.value?.inputs.includes(input) ?? false;
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

async function loadProjects() {
  const known = await getJson<Project[]>("/api/projects").catch(() => [] as Project[]);
  projects.value = known;
  // Whichever load wins sets the form's default Project.
  form.value.projectId ||= String(known[0]?.id ?? "");
}

async function start() {
  error.value = "";
  try {
    const run = await postJson<Run>("/api/runs", {
      projectId: Number(form.value.projectId),
      workflow: form.value.workflow,
      task: asks("task") ? form.value.task : undefined,
      assets: asks("assets") ? assets.value.map((a) => ({ name: a.name, kind: a.kind, description: a.description, fill: a.fill, replace: a.replace, references: a.references, frames: a.kind === "animation" ? a.frames : undefined, ...sizeOf(a) })) : undefined,
      title: form.value.title || undefined,
      trackerRef: form.value.trackerRef || undefined,
    });
    form.value = { ...form.value, task: "", title: "", trackerRef: "" };
    assets.value = [newAsset()];
    emit("open", run.id);
  } catch (e: any) {
    error.value = e.message;
  }
}

// Same-named Projects are told apart by their local path in the menu.
const projectLabel = (p: Project) => `${p.name} (${p.localPath})`;

onMounted(loadProjects);
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
    workflows.value = list.workflows;
    workflowsProblem.value = list.problem ?? "";
    // The Workflow picked for the previous Project may not exist here: fall back to the first one.
    if (!list.workflows.some((w) => w.name === form.value.workflow)) form.value.workflow = list.workflows[0]?.name ?? "developer";
    art.value = fetched;
    // References are the previous Project's images; the preset size is the new Project's.
    assets.value = assets.value.map((a) => (a.name || a.description ? { ...a, references: [] } : newAsset()));
  },
  { immediate: true },
);
</script>

<template>
  <h2>New Run</h2>
  <p v-if="!projects.length" class="muted">Register a Project first.</p>
  <form v-else class="stack" @submit.prevent="start">
    <select v-model="form.projectId" aria-label="Project">
      <option v-for="p in projects" :key="p.id" :value="String(p.id)">{{ projectLabel(p) }}</option>
    </select>
    <p v-if="workflowsLoading" class="muted" role="status">Loading Workflows…</p>
    <select v-else v-model="form.workflow" aria-label="Workflow">
      <option v-for="w in workflows" :key="w.name" :value="w.name">{{ w.name }} ({{ originLabel(w) }}){{ w.errors.length ? " - invalid" : w.description ? `: ${w.description}` : "" }}</option>
    </select>
    <p v-if="workflowsProblem" class="error">{{ workflowsProblem }}</p>
    <div v-if="chosen && chosen.errors.length" class="error" role="alert">
      <strong>{{ chosen.file }} is invalid and cannot be launched:</strong>
      <ul>
        <li v-for="(e, i) in chosen.errors" :key="i">{{ e.line ? `line ${e.line}: ` : e.path ? `${e.path}: ` : "" }}{{ e.message }}</li>
      </ul>
    </div>
    <textarea v-if="asks('task')" v-model="form.task" rows="4" placeholder="Task" aria-label="Task" required />
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
    <input v-model="form.title" placeholder="Title (derived from the task or Assets if empty)" aria-label="Title" />
    <input v-model="form.trackerRef" placeholder="Tracker reference (optional, e.g. $12a)" aria-label="Tracker reference" />
    <button type="submit" :disabled="workflowsLoading || !launchable">Start Run</button>
  </form>
  <p v-if="error" class="error">{{ error }}</p>
</template>
