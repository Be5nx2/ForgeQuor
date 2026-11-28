<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from "vue";
import { postJson, type DogfoodNature, type DogfoodTarget } from "../api";

/** The floating "+ Note" button and its popup: jots a Dogfood Note with the tab and the Run in view. Only records. */
const props = defineProps<{
  /** The active tab's id, sent as the note's origin tab. */
  tab: string;
  /** The Run being looked at, when there is one. */
  runId: number | null;
  /** The target the active tab suggests. */
  suggestedTarget: DogfoodTarget;
}>();

const emit = defineEmits<{ saved: [] }>();

const open = ref(false);
const nature = ref<DogfoodNature>("idea");
const target = ref<DogfoodTarget>(props.suggestedTarget);
const text = ref("");
const error = ref("");
const saving = ref(false);
const noted = ref(false);
const textarea = ref<HTMLTextAreaElement | null>(null);
let hideNoted: ReturnType<typeof setTimeout> | undefined;

async function show() {
  target.value = props.suggestedTarget;
  error.value = "";
  open.value = true;
  await nextTick();
  textarea.value?.focus();
}

/** Closing keeps what was typed, so an accidental close loses nothing. */
function close() {
  open.value = false;
}

async function save() {
  if (!text.value.trim()) {
    error.value = "Type something first: an empty note is not saved.";
    return;
  }
  saving.value = true;
  error.value = "";
  try {
    await postJson("/api/dogfood-notes", { nature: nature.value, target: target.value, text: text.value, tab: props.tab, runId: props.runId ?? undefined });
    text.value = "";
    open.value = false;
    noted.value = true;
    emit("saved");
    clearTimeout(hideNoted);
    hideNoted = setTimeout(() => (noted.value = false), 3000);
  } catch (e: any) {
    // The text stays in the form so the thought is not lost.
    error.value = `Not saved: ${e.message}`;
  } finally {
    saving.value = false;
  }
}

watch(
  () => props.suggestedTarget,
  (t) => {
    if (!open.value) target.value = t;
  },
);
onUnmounted(() => clearTimeout(hideNoted));
</script>

<template>
  <div class="note-widget">
    <p v-if="noted" class="noted" role="status">Noted.</p>
    <button v-if="!open" type="button" class="note-fab" @click="show">+ Note</button>
    <form v-else class="note-popup stack" role="dialog" aria-label="New note" @submit.prevent="save" @keydown.esc="close">
      <strong>New note</strong>
      <label>
        Nature
        <select v-model="nature">
          <option value="feedback">feedback</option>
          <option value="idea">idea</option>
        </select>
      </label>
      <label>
        About
        <select v-model="target">
          <option value="workflow">workflow</option>
          <option value="feature">feature</option>
          <option value="display">display</option>
          <option value="other">other</option>
        </select>
      </label>
      <label>
        Note
        <textarea ref="textarea" v-model="text" rows="4" placeholder="What did you notice?" />
      </label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div class="gate-actions">
        <button type="submit" :disabled="saving">{{ saving ? "Saving..." : "Save" }}</button>
        <button type="button" class="secondary" @click="close">Cancel</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.note-widget { position: fixed; right: 1rem; bottom: 1rem; z-index: 10; display: flex; flex-direction: column; align-items: flex-end; gap: 0.5rem; }
.note-fab { box-shadow: 0 2px 12px rgba(0, 0, 0, 0.6); border-radius: 999px; padding: 0.6rem 1.2rem; }
.note-popup { width: min(22rem, calc(100vw - 2rem)); background: #101d2d; border: 1px solid #38bdf8; border-radius: 8px; padding: 1rem; margin: 0; box-shadow: 0 4px 24px rgba(0, 0, 0, 0.7); }
.note-popup textarea { resize: vertical; }
.noted { margin: 0; background: #101d2d; border: 1px solid #38bdf8; border-radius: 6px; padding: 0.4rem 0.8rem; color: #a5e4ff; }
</style>
