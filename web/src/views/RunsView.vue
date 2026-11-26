<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { followRuns, getJson, postJson, type Project, type Run } from "../api";

const emit = defineEmits<{ open: [id: number] }>();

const STATES = ["queued", "running", "waiting", "paused", "approved", "merged", "closed", "abandoned"];

const projects = ref<Project[]>([]);
const runs = ref<Run[]>([]);
const filterProject = ref("");
const filterState = ref("");
const form = ref({ projectId: "", task: "", title: "", trackerRef: "" });
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
    const run = await postJson<Run>("/api/runs", {
      projectId: Number(form.value.projectId),
      task: form.value.task,
      title: form.value.title || undefined,
      trackerRef: form.value.trackerRef || undefined,
    });
    form.value = { projectId: form.value.projectId, task: "", title: "", trackerRef: "" };
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
    <textarea v-model="form.task" rows="4" placeholder="Task" aria-label="Task" required />
    <input v-model="form.title" placeholder="Title (derived from the task if empty)" aria-label="Title" />
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
      <div class="muted">{{ projectName(r.projectId) }}<span v-if="r.trackerRef"> · {{ r.trackerRef }}</span></div>
    </li>
  </ul>
</template>
