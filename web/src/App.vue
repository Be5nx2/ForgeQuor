<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { getJson } from "./api";
import AppShell from "./components/AppShell.vue";
import NoteButton from "./components/NoteButton.vue";
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

function noteJotted() {
  inboxVersion.value++;
  refreshBadge();
}

onMounted(async () => {
  refreshBadge();
  tools.value = (await getJson<{ tools: Tool[] }>("/api/health")).tools;
});
</script>

<template>
  <AppShell :nav="sidebarNav" :active-tab="place.tab" :new-notes="newNotes" :warnings="warnings">
    <template #note><NoteButton @saved="noteJotted" :tab="place.tab" :run-id="place.runId" :suggested-target="place.target" /></template>
    <router-view v-slot="{ Component }">
      <!-- keyed by path so Back between /runs/1 and /runs/2 remounts the view instead of showing the stale Run -->
      <component :is="Component" :key="route.path" v-bind="route.name === 'inbox' ? { version: inboxVersion, onCount: (n: number) => (newNotes = n) } : {}" />
    </router-view>
  </AppShell>
</template>
