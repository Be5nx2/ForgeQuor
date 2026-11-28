<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { followRuns, getJson, type Project, type Run } from "../api";

const router = useRouter();
const openRun = (id: number) => router.push(`/runs/${id}`);

const STATES = ["queued", "running", "waiting", "paused", "approved", "merged", "closed", "abandoned"];

const projects = ref<Project[]>([]);
const runs = ref<Run[]>([]);
const filterProject = ref("");
const filterState = ref("");
/** Archived Runs (finished, their worktree removed) are hidden unless asked for. */
const showArchived = ref(false);
const visible = computed(() => (showArchived.value ? runs.value : runs.value.filter((r) => !r.archivedAt)));
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
});
onUnmounted(() => stopFollowing?.());
watch([filterProject, filterState], load);
</script>

<template>
  <h2>Runs</h2>
  <form class="filters">
    <select v-model="filterProject" aria-label="Filter by Project">
      <option value="">All Projects</option>
      <option v-for="p in projects" :key="p.id" :value="String(p.id)">{{ projectLabel(p) }}</option>
    </select>
    <select v-model="filterState" aria-label="Filter by state">
      <option value="">All states</option>
      <option v-for="s in STATES" :key="s" :value="s">{{ s }}</option>
    </select>
    <label><input v-model="showArchived" type="checkbox" /> Show archived</label>
  </form>
  <p v-if="loadError" class="error">{{ loadError }}</p>
  <p v-if="!loaded" class="muted">Loading the Runs…</p>
  <p v-else-if="!visible.length" class="muted">No Run{{ filterProject || filterState || (!showArchived && runs.length) ? " matches these filters" : "" }}.</p>
  <ul>
    <li v-for="r in visible" :key="r.id" class="clickable" @click="openRun(r.id)">
      <strong>{{ r.title }}</strong> <span class="badge">{{ r.state }}</span> <span v-if="r.archivedAt" class="badge">archived</span>
      <div class="muted">{{ r.workflow }} · {{ projectName(r.projectId) }}<span v-if="r.trackerRef"> · {{ r.trackerRef }}</span></div>
    </li>
  </ul>
</template>
