<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { getJson, postJson, putJson, type DogfoodExport, type DogfoodNote, type DogfoodNoteList } from "../api";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import LoadingState from "../components/LoadingState.vue";

/** The Dogfood Inbox: every note newest first, with filters and the buttons that triage or dismiss them. */
const props = defineProps<{
  /** Bumped when a note was jotted elsewhere, so the list reloads. */
  version: number;
}>();
const emit = defineEmits<{ count: [n: number] }>();

const notes = ref<DogfoodNote[]>([]);
const filter = ref({ status: "", nature: "", target: "" });
const error = ref("");
/** Why the list itself could not load (a failed triage or export stays in `error`, above the list). */
const loadError = ref("");
/** False until the first list arrives, so an empty page never reads as "No notes" while it is loading. */
const loaded = ref(false);
/** The reference being typed per note, kept until it is triaged. */
const refs = ref<Record<number, string>>({});
/** The notes ticked for export: only ever notes the current list shows. */
const selected = ref<number[]>([]);
const exporting = ref(false);
/** What the last export did, said in words. */
const exportedAs = ref("");
const allSelected = computed(() => notes.value.length > 0 && notes.value.every((n) => selected.value.includes(n.id)));
function toggleAll() {
  selected.value = allSelected.value ? [] : notes.value.map((n) => n.id);
}

async function load() {
  const query = new URLSearchParams(Object.entries(filter.value).filter(([, v]) => v));
  try {
    const list = await getJson<DogfoodNoteList>(`/api/dogfood-notes?${query}`);
    notes.value = list.notes;
    selected.value = selected.value.filter((id) => list.notes.some((n) => n.id === id));
    emit("count", list.newCount);
    error.value = "";
    loadError.value = "";
    loaded.value = true;
  } catch (e: any) {
    loadError.value = e.message;
  }
}

async function move(n: DogfoodNote, status: string) {
  let failure = "";
  try {
    await putJson(`/api/dogfood-notes/${n.id}/status`, { status, triageRef: status === "triaged" ? refs.value[n.id] || undefined : undefined });
    delete refs.value[n.id];
  } catch (e: any) {
    failure = `Not changed: ${e.message}`;
  }
  // Reload either way: after a refusal the list shows the note's real status.
  await load();
  if (failure) error.value = failure;
}

/** Asks the server to write the Dogfood Export, then offers the same file for download. No status changes. */
async function exportSelected() {
  exporting.value = true;
  exportedAs.value = "";
  try {
    const file = await postJson<DogfoodExport>("/api/dogfood-notes/export", { ids: selected.value });
    const url = URL.createObjectURL(new Blob([file.content], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = file.fileName;
    link.click();
    URL.revokeObjectURL(url);
    exportedAs.value = `Exported ${selected.value.length} note${selected.value.length === 1 ? "" : "s"} to ${file.path}`;
    error.value = "";
  } catch (e: any) {
    error.value = `Not exported: ${e.message}`;
  } finally {
    exporting.value = false;
  }
}

onMounted(load);
watch(filter, load, { deep: true });
watch(() => props.version, load);
</script>

<template>
  <h2>Dogfood Inbox</h2>
  <p class="muted">What you noticed while using Forgequor, newest first. Triaged and dismissed notes stay here.</p>
  <form class="filters" @submit.prevent>
    <select v-model="filter.status" aria-label="Status">
      <option value="">any status</option>
      <option value="new">new</option>
      <option value="triaged">triaged</option>
      <option value="dismissed">dismissed</option>
    </select>
    <select v-model="filter.nature" aria-label="Nature">
      <option value="">any nature</option>
      <option value="feedback">feedback</option>
      <option value="idea">idea</option>
    </select>
    <select v-model="filter.target" aria-label="Target">
      <option value="">any target</option>
      <option value="workflow">workflow</option>
      <option value="feature">feature</option>
      <option value="display">display</option>
      <option value="other">other</option>
    </select>
  </form>
  <div v-if="notes.length" class="gate-actions">
    <label><input type="checkbox" :checked="allSelected" @change="toggleAll" /> Select all {{ notes.length }} shown</label>
    <button type="button" :disabled="!selected.length || exporting" @click="exportSelected">Export {{ selected.length }} selected</button>
  </div>
  <p v-if="exportedAs" class="muted" role="status">{{ exportedAs }}</p>
  <p v-if="error" class="error" role="alert">{{ error }}</p>
  <ErrorState v-if="loadError" title="Could not load the notes" text="The Forgequor server did not answer. Check that it is running, then retry." :details="loadError" @retry="load" />
  <LoadingState v-else-if="!loaded" what="notes" />
  <EmptyState v-else-if="!notes.length && (filter.status || filter.nature || filter.target)" title="No note matches these filters" text="Change the filters to see more notes." />
  <EmptyState v-else-if="!notes.length" title="No note yet" text="Use + Note in the sidebar to jot down what you notice while using Forgequor." />
  <ul class="notes">
    <li v-for="n in notes" :key="n.id" class="stack">
      <div>
        <input v-model="selected" type="checkbox" :value="n.id" :aria-label="`Select note ${n.id} for export`" />
        <strong>{{ n.nature }}</strong> about <strong>{{ n.target }}</strong>
        <span class="muted"> · {{ new Date(n.createdAt).toLocaleString() }} · {{ n.origin }} · {{ n.status }}<template v-if="n.triageRef"> → {{ n.triageRef }}</template></span>
      </div>
      <p class="note-text">{{ n.text }}</p>
      <div v-if="n.status === 'new'" class="gate-actions">
        <input v-model="refs[n.id]" placeholder="Where it went (optional)" aria-label="Triage reference" maxlength="200" />
        <button type="button" @click="move(n, 'triaged')">Triaged</button>
        <button type="button" class="secondary" @click="move(n, 'dismissed')">Dismiss</button>
      </div>
      <div v-else class="gate-actions">
        <button type="button" class="secondary" @click="move(n, 'new')">Back to new</button>
      </div>
    </li>
  </ul>
</template>

<style scoped>
.notes { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 0.75rem; }
.notes li { border: 1px solid #1c2e45; border-radius: 6px; padding: 0.75rem; }
.note-text { margin: 0; white-space: pre-wrap; }
</style>
