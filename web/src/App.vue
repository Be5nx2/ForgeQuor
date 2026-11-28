<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute } from "vue-router";
import { getJson, type OpenGate } from "./api";
import AppShell from "./components/AppShell.vue";
import NoteButton from "./components/NoteButton.vue";
import { liveEvents } from "./liveEvents";
import { placeOf, sidebarNav } from "./navigation";

interface Tool {
  tool: string;
  status: string;
  detail: string;
}

const route = useRoute();
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

/** How many Gates wait for the human (the Runs badge); a Run's `changed` update covers a Gate opening or closing. */
const openGates = ref(0);
let gatesRead = 0;

async function refreshGates() {
  const mine = ++gatesRead;
  try {
    const gates = await getJson<OpenGate[]>("/api/gates");
    if (mine === gatesRead) openGates.value = gates.length;
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
  stopFollowing = liveEvents.follow((u) => u.type === "changed" && refreshGates(), refreshGates);
  tools.value = (await getJson<{ tools: Tool[] }>("/api/health")).tools;
});
onUnmounted(() => stopFollowing?.());
</script>

<template>
  <AppShell :nav="sidebarNav" :active-tab="place.tab" :new-notes="newNotes" :open-gates="openGates" :warnings="warnings">
    <template #note><NoteButton @saved="noteJotted" :tab="place.tab" :run-id="place.runId" :suggested-target="place.target" /></template>
    <router-view v-slot="{ Component }">
      <!-- keyed by path so Back between /runs/1 and /runs/2 remounts the view instead of showing the stale Run -->
      <component :is="Component" :key="route.path" v-bind="route.name === 'inbox' ? { version: inboxVersion, onCount: (n: number) => (newNotes = n) } : {}" />
    </router-view>
  </AppShell>
</template>
