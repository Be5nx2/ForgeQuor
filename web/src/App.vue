<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useRouter } from "vue-router";
import { getJson, type OpenGate, type Project } from "./api";
import AppShell from "./components/AppShell.vue";
import NoteButton from "./components/NoteButton.vue";
import { liveEvents } from "./liveEvents";
import { placeOf, sidebarNav } from "./navigation";
import { inProject, projectLabels, resolveProject, withProject, type Query } from "./projectScope";

interface Tool {
  tool: string;
  status: string;
  detail: string;
}

const route = useRoute();
const router = useRouter();
/** Where the URL puts the human: the tab to highlight, the Run in view, the note popup's suggested target. */
const place = computed(() => placeOf(route.name, route.params));
const tools = ref<Tool[]>([]);
const warnings = computed(() => tools.value.filter((t) => t.status !== "ok").map((t) => `${t.tool}: ${t.detail}`));
/** How many Dogfood Notes are new (the Inbox badge) and a counter that tells the Inbox to reload. */
const newNotes = ref(0);
const inboxVersion = ref(0);

async function refreshBadge() {
  try {
    newNotes.value = (await getJson<{ newCount: number }>("/api/dogfood-notes?status=new")).newCount;
  } catch {
    // The badge is a convenience: a failed read leaves the last count.
  }
}

/** The registered Projects (the selector's options) and the one the URL chooses, null for "All Projects". */
const projects = ref<Project[]>([]);
const projectId = computed(() => resolveProject(route.query as Query, projects.value));
const projectOptions = computed(() => {
  const labels = projectLabels(projects.value);
  return projects.value.map((p) => ({ id: p.id, label: labels.get(p.id)! }));
});

async function refreshProjects() {
  try {
    projects.value = await getJson<Project[]>("/api/projects");
  } catch {
    // The selector keeps the last list; the screens show their own errors.
  }
}

function chooseProject(id: number | null) {
  router.push({ path: route.path, query: withProject(route.query as Query, id) });
}

/** How many Gates wait for the human in the chosen Project (the Runs badge); a Run's `changed` update covers a Gate opening or closing. */
const allGates = ref<OpenGate[]>([]);
const openGates = computed(() => inProject(allGates.value, projectId.value).length);
let gatesRead = 0;

async function refreshGates() {
  const mine = ++gatesRead;
  try {
    const gates = await getJson<OpenGate[]>("/api/gates");
    if (mine === gatesRead) allGates.value = gates;
  } catch {
    // The badge is a convenience: a failed read leaves the last count.
  }
}

function noteJotted() {
  inboxVersion.value++;
  refreshBadge();
}

let stopFollowing: () => void;
onMounted(async () => {
  refreshBadge();
  refreshGates();
  refreshProjects();
  stopFollowing = liveEvents.follow((u) => u.type === "changed" && refreshGates(), refreshGates);
  tools.value = (await getJson<{ tools: Tool[] }>("/api/health")).tools;
});
onUnmounted(() => stopFollowing?.());
// A Project registered on the Projects screen shows in the selector as soon as the human leaves it.
watch(() => route.path, refreshProjects);
</script>

<template>
  <AppShell :nav="sidebarNav" :active-tab="place.tab" :new-notes="newNotes" :open-gates="openGates" :warnings="warnings" :projects="projectOptions" :project-id="projectId" @choose-project="chooseProject">
    <template #note><NoteButton @saved="noteJotted" :tab="place.tab" :run-id="place.runId" :suggested-target="place.target" /></template>
    <router-view v-slot="{ Component }">
      <!-- keyed by path so Back between /runs/1 and /runs/2 remounts the view instead of showing the stale Run -->
      <component :is="Component" :key="route.path" v-bind="route.name === 'inbox' ? { version: inboxVersion, onCount: (n: number) => (newNotes = n) } : {}" />
    </router-view>
  </AppShell>
</template>
