<script setup lang="ts">
import { onMounted, ref } from "vue";
import { getJson } from "./api";
import NewRunView from "./views/NewRunView.vue";
import ProjectsView from "./views/ProjectsView.vue";
import RunDetailView from "./views/RunDetailView.vue";
import RunsView from "./views/RunsView.vue";
import WaitingView from "./views/WaitingView.vue";

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

onMounted(async () => {
  tools.value = (await getJson<{ tools: Tool[] }>("/api/health")).tools;
});
</script>

<template>
  <main>
    <h1>FORGE<span>QUOR</span></h1>
    <div v-for="t in tools.filter((t) => t.status !== 'ok')" :key="t.tool" class="warn">{{ t.tool }}: {{ t.detail }}</div>

    <nav>
      <button v-for="t in tabs" :key="t.id" :class="{ active: tab === t.id }" @click="show(t.id)">{{ t.label }}</button>
    </nav>

    <WaitingView v-if="tab === 'waiting'" @open="openRun" />
    <NewRunView v-else-if="tab === 'new'" @open="openRun" />
    <ProjectsView v-else-if="tab === 'projects'" />
    <RunDetailView v-else-if="runId !== null" :id="runId" @back="runId = null" />
    <RunsView v-else @open="openRun" />
  </main>
</template>
