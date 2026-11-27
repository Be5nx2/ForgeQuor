<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { followRuns, getJson, postJson, type ArtInfo, type AssetKind, type Project, type Run } from "../api";

const emit = defineEmits<{ open: [id: number] }>();

const STATES = ["queued", "running", "waiting", "paused", "approved", "merged", "closed", "abandoned"];

const projects = ref<Project[]>([]);
const runs = ref<Run[]>([]);
const filterProject = ref("");
const filterState = ref("");
const form = ref({ projectId: "", workflow: "developer", task: "", title: "", trackerRef: "" });

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

/** False until the first list arrives, so an empty page never reads as "No Run" while it is loading. */
const loaded = ref(false);
const loadError = ref("");
/** Loads overlap when Runs change quickly or a filter changes: only the latest may write, so an older answer never hides a Run. */
let latest = 0;

async function load() {
  const mine = ++latest;
  const q = new URLSearchParams();
  if (filterProject.value) q.set("projectId", filterProject.value);
  if (filterState.value) q.set("state", filterState.value);
  try {
    // Projects come along, so a Run of a Project registered since is named, not shown as a bare id.
    const [found, known] = await Promise.all([getJson<Run[]>(`/api/runs?${q}`), getJson<Project[]>("/api/projects")]);
    if (mine !== latest) return;
    runs.value = found;
    projects.value = known;
    loaded.value = true;
    loadError.value = "";
  } catch (e: any) {
    if (mine === latest) loadError.value = `Could not load the Runs: ${e.message}`;
  }
}

async function start() {
  error.value = "";
  try {
    const isAssets = form.value.workflow === "assets";
    const run = await postJson<Run>("/api/runs", {
      projectId: Number(form.value.projectId),
      workflow: form.value.workflow,
      task: isAssets ? undefined : form.value.task,
      assets: isAssets ? assets.value.map((a) => ({ name: a.name, kind: a.kind, description: a.description, fill: a.fill, replace: a.replace, references: a.references, frames: a.kind === "animation" ? a.frames : undefined, ...sizeOf(a) })) : undefined,
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

// Same-named Projects are told apart by their local path, in the menus and in the list: two Projects called alike once
// made a Run look missing from its Project.
const projectLabel = (p: Project) => `${p.name} (${p.localPath})`;
const projectName = (id: number) => {
  const p = projects.value.find((p) => p.id === id);
  if (!p) return `Project #${id}`;
  return projects.value.some((o) => o.id !== p.id && o.name === p.name) ? projectLabel(p) : p.name;
};

let stopFollowing: () => void;
onMounted(async () => {
  stopFollowing = followRuns((u) => u.type === "changed" && load(), load);
  await load();
  form.value.projectId ||= String(projects.value[0]?.id ?? "");
});
onUnmounted(() => stopFollowing?.());
watch([filterProject, filterState], load);
// The Art Direction's default size presets the Assets not yet filled in; a Project without images or Art Direction offers nothing.
watch(
  () => form.value.projectId,
  async (id) => {
    const none: ArtInfo = { present: false, defaultSize: null, references: [], images: [] };
    const fetched = id ? await getJson<ArtInfo>(`/api/projects/${id}/art-info`).catch(() => none) : none;
    // A quicker switch to another Project already moved on: drop this answer.
    if (form.value.projectId !== id) return;
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
    <select v-model="form.workflow" aria-label="Workflow">
      <option value="developer">developer: code a task</option>
      <option value="assets">assets: draw pixel art</option>
    </select>
    <textarea v-if="form.workflow === 'developer'" v-model="form.task" rows="4" placeholder="Task" aria-label="Task" required />
    <template v-else>
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
    <button type="submit">Start Run</button>
  </form>
  <p v-if="error" class="error">{{ error }}</p>

  <h2>Runs</h2>
  <form>
    <select v-model="filterProject" aria-label="Filter by Project">
      <option value="">All Projects</option>
      <option v-for="p in projects" :key="p.id" :value="String(p.id)">{{ projectLabel(p) }}</option>
    </select>
    <select v-model="filterState" aria-label="Filter by state">
      <option value="">All states</option>
      <option v-for="s in STATES" :key="s" :value="s">{{ s }}</option>
    </select>
  </form>
  <p v-if="loadError" class="error">{{ loadError }}</p>
  <p v-if="!loaded" class="muted">Loading the Runs…</p>
  <p v-else-if="!runs.length" class="muted">No Run{{ filterProject || filterState ? " matches these filters" : "" }}.</p>
  <ul>
    <li v-for="r in runs" :key="r.id" class="clickable" @click="emit('open', r.id)">
      <strong>{{ r.title }}</strong> <span class="badge">{{ r.state }}</span>
      <div class="muted">{{ r.workflow }} · {{ projectName(r.projectId) }}<span v-if="r.trackerRef"> · {{ r.trackerRef }}</span></div>
    </li>
  </ul>
</template>
