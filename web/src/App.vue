<script setup lang="ts">
import { onMounted, ref } from "vue";
import { getJson, type DogfoodTarget } from "./api";
import NoteButton from "./components/NoteButton.vue";
import QuotaBar from "./components/QuotaBar.vue";
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
] as const;

const tab = ref<(typeof tabs)[number]["id"]>("waiting");
const runId = ref<number | null>(null);
const tools = ref<Tool[]>([]);

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
};

onMounted(async () => {
  tools.value = (await getJson<{ tools: Tool[] }>("/api/health")).tools;
});
</script>

<template>
  <main>
    <QuotaBar />
    <h1>FORGE<span>QUOR</span></h1>
    <div v-for="t in tools.filter((t) => t.status !== 'ok')" :key="t.tool" class="warn">{{ t.tool }}: {{ t.detail }}</div>

    <nav>
      <button v-for="t in tabs" :key="t.id" :class="{ active: tab === t.id }" @click="show(t.id)">{{ t.label }}</button>
    </nav>

    <WaitingView v-if="tab === 'waiting'" @open="openRun" />
    <NewRunView v-else-if="tab === 'new'" @open="openRun" />
    <ProjectsView v-else-if="tab === 'projects'" />
    <WorkflowsView v-else-if="tab === 'workflows'" />
    <TeamView v-else-if="tab === 'team'" />
    <RunDetailView v-else-if="runId !== null" :id="runId" @back="runId = null" />
    <RunsView v-else @open="openRun" />
    <NoteButton :tab="tab" :run-id="tab === 'runs' ? runId : null" :suggested-target="targetOf[tab]" />
  </main>
</template>
