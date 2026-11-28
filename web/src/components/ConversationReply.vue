<script setup lang="ts">
import { ref } from "vue";
import { decideGate, type Gate, type GateAction } from "../api";

/** The human's side of a Conversation Gate: the answer box, "Send answers" and "Confirm summary" (when the Agent proposed one). */
const props = defineProps<{ gate: Gate }>();
const emit = defineEmits<{ decided: [] }>();

const message = ref("");
const busy = ref(false);
const error = ref("");

async function send(action: GateAction, text?: string) {
  busy.value = true;
  error.value = "";
  try {
    await decideGate(props.gate.id, action, undefined, undefined, undefined, text);
    if (action === "answer") message.value = "";
    emit("decided");
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form v-if="gate.actions.includes('answer')" class="compose" @submit.prevent="send('answer', message)">
    <label class="label" for="conversation-answer">Your answers</label>
    <textarea id="conversation-answer" v-model="message" class="feedback" rows="5" placeholder="Your answers, all in one message" required />
    <div class="row">
      <span class="muted hint">Saved to the Run Notes at each exchange.</span>
      <span class="buttons">
        <button v-if="gate.actions.includes('confirm')" type="button" class="btn btn-outline-action" :disabled="busy" @click="send('confirm')">Confirm summary</button>
        <button type="submit" class="btn btn-primary" :disabled="busy || !message.trim()">Send answers</button>
      </span>
    </div>
    <span v-if="error" class="error" role="alert">{{ error }}</span>
  </form>
</template>

<style scoped>
.compose { border: 1px solid var(--action); border-radius: var(--radius-lg); padding: var(--sp-4); background: rgb(8 15 25 / 0.7); display: grid; gap: var(--sp-3); box-shadow: 0 0 20px rgb(255 140 36 / 0.12); }
.compose .row { display: flex; gap: var(--sp-2); justify-content: space-between; align-items: center; flex-wrap: wrap; }
.buttons { display: flex; gap: var(--sp-2); }
.hint { font-size: var(--fs-xs); }
.label { font-size: var(--fs-sm); font-weight: 600; }
.feedback { width: 100%; min-height: 4.5rem; max-height: 40vh; background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius-md); padding: 0.7rem; font: var(--fs-sm) var(--font-ui); resize: vertical; }
.btn:disabled { opacity: 0.5; cursor: wait; }
.btn:focus-visible, .feedback:focus-visible { outline: 2px solid var(--ai); outline-offset: 2px; }
</style>
