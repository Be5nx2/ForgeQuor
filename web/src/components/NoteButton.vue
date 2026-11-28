<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from "vue";
import { postJson, type DogfoodNature, type DogfoodTarget } from "../api";

/** The sidebar's "+ Note" button and its popup: jots a Dogfood Note with the tab and the Run in view. Only records. */
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
const opener = ref<HTMLButtonElement | null>(null);
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
  opener.value?.focus();
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
    <button ref="opener" type="button" class="btn note-button" :aria-expanded="open" aria-haspopup="dialog" @click="open ? close() : show()">+ Note</button>
    <Teleport to="body">
      <form v-if="open" class="note-popup" role="dialog" aria-label="New note" @submit.prevent="save" @keydown.esc="close">
        <h3>New note</h3>
        <label class="field">
          <span class="label">Nature</span>
          <select v-model="nature">
            <option value="feedback">feedback</option>
            <option value="idea">idea</option>
          </select>
        </label>
        <label class="field">
          <span class="label">About</span>
          <select v-model="target">
            <option value="workflow">workflow</option>
            <option value="feature">feature</option>
            <option value="display">display</option>
            <option value="other">other</option>
          </select>
        </label>
        <label class="field">
          <span class="label">Note</span>
          <textarea ref="textarea" v-model="text" rows="4" placeholder="What did you notice?" />
        </label>
        <p v-if="error" class="err" role="alert">{{ error }}</p>
        <div class="actions">
          <button type="submit" class="btn btn-primary" :disabled="saving">{{ saving ? "Saving..." : "Save" }}</button>
          <button type="button" class="btn" @click="close">Cancel</button>
        </div>
      </form>
    </Teleport>
  </div>
</template>

<style scoped>
.note-widget { display: flex; flex-direction: column; gap: var(--sp-2); }
.note-button { width: 100%; }
/* Teleported to <body> and fixed beside the sidebar button, so it always stays fully on screen (a backdrop-filter on the sidebar would otherwise trap it). */
.note-popup { position: fixed; left: var(--sp-3); bottom: 4.5rem; z-index: 10; width: min(22rem, calc(100vw - 1.5rem)); max-height: calc(100vh - 6rem); overflow-y: auto; background: var(--surface); border: 1px solid var(--ai); border-radius: var(--radius-md); padding: var(--sp-4); margin: 0; box-shadow: 0 4px 24px rgb(0 0 0 / 0.7); }
.note-popup { display: flex; flex-direction: column; gap: var(--sp-3); background: linear-gradient(180deg, rgb(23 40 61 / 0.97), rgb(16 29 45 / 0.97)); }
.note-popup h3 { font: 700 var(--fs-sm) var(--font-brand); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ice-blue); }
.field { display: flex; flex-direction: column; gap: var(--sp-2); }
.label { font-size: var(--fs-sm); font-weight: 600; }
.note-popup select, .note-popup textarea { width: 100%; box-sizing: border-box; padding: 0.65rem 0.75rem; background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius-md); font: var(--fs-sm) var(--font-ui); }
.note-popup textarea { resize: vertical; min-height: 5rem; }
.actions { display: flex; gap: var(--sp-2); }
.btn:disabled { opacity: 0.5; cursor: wait; }
.err { margin: 0; color: var(--st-bad); font-size: var(--fs-sm); }
.noted { margin: 0; background: var(--surface); border: 1px solid var(--ai); border-radius: var(--radius-md); padding: var(--sp-1) var(--sp-3); color: var(--ice-blue); font-size: var(--fs-sm); }
</style>
