<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { followRuns, getJson, postJson, type AssetKind, type Project, type Run } from "../api";

const emit = defineEmits<{ open: [id: number] }>();

const STATES = ["queued", "running", "waiting", "paused", "approved", "merged", "closed", "abandoned"];

const projects = ref<Project[]>([]);
const runs = ref<Run[]>([]);
const filterProject = ref("");
const filterState = ref("");
const form = ref({ projectId: "", workflow: "developer", task: "", title: "", trackerRef: "" });

/** The size presets of an Asset Request; "custom" shows the width and height fields. */
const SIZES = ["16x16", "18x18", "32x32"];
interface AssetDraft {
  name: string;
  kind: AssetKind;
  description: string;
  size: string;
  width: number;
  height: number;
}
const newAsset = (): AssetDraft => ({ name: "", kind: "sprite", description: "", size: "16x16", width: 16, height: 16 });
const assets = ref<AssetDraft[]>([newAsset()]);
const sizeOf = (a: AssetDraft) => (a.size === "custom" ? { width: a.width, height: a.height } : { width: Number(a.size.split("x")[0]), height: Number(a.size.split("x")[1]) });
const error = ref("");

async function load() {
  const q = new URLSearchParams();
  if (filterProject.value) q.set("projectId", filterProject.value);
  if (filterState.value) q.set("state", filterState.value);
  runs.value = await getJson(`/api/runs?${q}`);
}

async function start() {
  error.value = "";
  try {
    const isAssets = form.value.workflow === "assets";
    const run = await postJson<Run>("/api/runs", {
      projectId: Number(form.value.projectId),
      workflow: form.value.workflow,
      task: isAssets ? undefined : form.value.task,
      assets: isAssets ? assets.value.map((a) => ({ name: a.name, kind: a.kind, description: a.description, ...sizeOf(a) })) : undefined,
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

const projectName = (id: number) => projects.value.find((p) => p.id === id)?.name ?? `#${id}`;
// Same-named Projects are told apart by their local path.
const projectLabel = (p: Project) => `${p.name} (${p.localPath})`;

let stopFollowing: () => void;
onMounted(async () => {
  projects.value = await getJson("/api/projects");
  form.value.projectId = String(projects.value[0]?.id ?? "");
  await load();
  stopFollowing = followRuns((u) => u.type === "changed" && load(), load);
});
onUnmounted(() => stopFollowing?.());
watch([filterProject, filterState], load);
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
        </select>
        <textarea v-model="a.description" rows="2" placeholder="What it shows" aria-label="Asset description" required />
        <select v-model="a.size" aria-label="Asset size">
          <option v-for="size in SIZES" :key="size" :value="size">{{ size }}</option>
          <option value="custom">custom…</option>
        </select>
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
  <p v-if="!runs.length" class="muted">No Run.</p>
  <ul>
    <li v-for="r in runs" :key="r.id" class="clickable" @click="emit('open', r.id)">
      <strong>{{ r.title }}</strong> <span class="badge">{{ r.state }}</span>
      <div class="muted">{{ r.workflow }} · {{ projectName(r.projectId) }}<span v-if="r.trackerRef"> · {{ r.trackerRef }}</span></div>
    </li>
  </ul>
</template>
