<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { getJson } from "./api";
import NoteButton from "./components/NoteButton.vue";
import QuotaBar from "./components/QuotaBar.vue";
import { navTabs, placeOf } from "./navigation";

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
  <main>
    <QuotaBar />
    <h1>FORGE<span>QUOR</span></h1>
    <div v-for="t in tools.filter((t) => t.status !== 'ok')" :key="t.tool" class="warn">{{ t.tool }}: {{ t.detail }}</div>

    <nav>
      <button v-for="t in navTabs" :key="t.name" :class="{ active: place.tab === t.name }" @click="router.push(t.path)">{{ t.label }}<span v-if="t.name === 'inbox' && newNotes" class="badge" :aria-label="`${newNotes} new notes`">{{ newNotes }}</span></button>
    </nav>

    <router-view v-slot="{ Component }">
      <!-- keyed by path so Back between /runs/1 and /runs/2 remounts the view instead of showing the stale Run -->
      <component :is="Component" :key="route.path" v-bind="route.name === 'inbox' ? { version: inboxVersion, onCount: (n: number) => (newNotes = n) } : {}" />
    </router-view>
    <NoteButton @saved="noteJotted" :tab="place.tab" :run-id="place.runId" :suggested-target="place.target" />
  </main>
</template>
