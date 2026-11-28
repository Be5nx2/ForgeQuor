<script setup lang="ts">
import { onMounted, ref } from "vue";
import { getJson, type DogfoodTarget } from "./api";
import NoteButton from "./components/NoteButton.vue";
import QuotaBar from "./components/QuotaBar.vue";
import InboxView from "./views/InboxView.vue";
import NewRunView from "./views/NewRunView.vue";
import ProjectsView from "./views/ProjectsView.vue";
import RunDetailView from "./views/RunDetailView.vue";
import RunsView from "./views/RunsView.vue";
import TeamView from "./views/TeamView.vue";
import WaitingView from "./views/WaitingView.vue";
import WorkflowsView from "./views/WorkflowsView.vue";

interface Tool {
  tool: string;
  status: string;
  detail: string;
}

const tabs = [
  { id: "waiting", label: "Waiting for you" },
  { id: "new", label: "New Run" },
  { id: "runs", label: "Runs" },
  { id: "projects", label: "Projects" },
  { id: "workflows", label: "Workflows" },
  { id: "team", label: "Team" },
  { id: "inbox", label: "Inbox" },
] as const;

const tab = ref<(typeof tabs)[number]["id"]>("waiting");
const runId = ref<number | null>(null);
const tools = ref<Tool[]>([]);
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

function noteJotted() {
  inboxVersion.value++;
  refreshBadge();
}

function show(id: (typeof tabs)[number]["id"]) {
  tab.value = id;
  runId.value = null;
}

function openRun(id: number) {
  tab.value = "runs";
  runId.value = id;
}

/** What each tab is most likely about, for the note popup's pre-selected target. */
const targetOf: Record<(typeof tabs)[number]["id"], DogfoodTarget> = {
  waiting: "workflow",
  new: "workflow",
  runs: "workflow",
  projects: "feature",
  workflows: "workflow",
  team: "feature",
  inbox: "feature",
};

onMounted(async () => {
  refreshBadge();
  tools.value = (await getJson<{ tools: Tool[] }>("/api/health")).tools;
});
</script>

<template>
  <main>
    <QuotaBar />
    <h1>FORGE<span>QUOR</span></h1>
    <div v-for="t in tools.filter((t) => t.status !== 'ok')" :key="t.tool" class="warn">{{ t.tool }}: {{ t.detail }}</div>

    <nav>
      <button v-for="t in tabs" :key="t.id" :class="{ active: tab === t.id }" @click="show(t.id)">{{ t.label }}<span v-if="t.id === 'inbox' && newNotes" class="badge" :aria-label="`${newNotes} new notes`">{{ newNotes }}</span></button>
    </nav>

    <WaitingView v-if="tab === 'waiting'" @open="openRun" />
    <NewRunView v-else-if="tab === 'new'" @open="openRun" />
    <ProjectsView v-else-if="tab === 'projects'" />
    <WorkflowsView v-else-if="tab === 'workflows'" />
    <TeamView v-else-if="tab === 'team'" />
    <InboxView v-else-if="tab === 'inbox'" :version="inboxVersion" @count="newNotes = $event" />
    <RunDetailView v-else-if="runId !== null" :id="runId" @back="runId = null" />
    <RunsView v-else @open="openRun" />
    <NoteButton @saved="noteJotted" :tab="tab" :run-id="tab === 'runs' ? runId : null" :suggested-target="targetOf[tab]" />
  </main>
</template>
