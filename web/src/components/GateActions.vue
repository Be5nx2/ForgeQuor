<script setup lang="ts">
import { ref } from "vue";
import { decideGate, type Gate, type GateAction } from "../api";

/** `held`: the Feedback, when the screen holds the Feedback field itself (the Spec Gate shows it beside the spec), "Reject" sends that text at once. */
const props = defineProps<{ gate: Gate; held?: string }>();
const emit = defineEmits<{ decided: [] }>();

const busy = ref(false);
const error = ref("");
/** The form open under the buttons: a rejection, or an Escalation's retry or go back. */
const form = ref<"reject" | "retry" | "go_back" | null>(null);
const feedback = ref("");
const target = ref("");
const keeps = () => props.held !== undefined;

function open(which: "reject" | "retry" | "go_back") {
  form.value = which;
  target.value = props.gate.redo?.goBack[0]?.stepId ?? "";
  feedback.value = "";
}

async function decide(action: GateAction) {
  if (action === "abandon" && !window.confirm("Abandon this Run? It stops for good; its branch and worktree are kept.")) return;
  busy.value = true;
  error.value = "";
  try {
    const withFeedback = action === "reject" || action === "retry" || action === "go_back";
    await decideGate(props.gate.id, action, withFeedback ? (action === "reject" && keeps() ? props.held : feedback.value) : undefined, undefined, action === "go_back" ? target.value : undefined);
    emit("decided");
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

const stepLabel = (s: { stepId: string; type: string; detail: string | null }) => `${s.stepId} (${s.detail ?? s.type})`;
</script>

<template>
  <div class="gate-actions" @click.stop>
    <button v-if="gate.actions.includes('approve')" type="button" class="btn btn-primary" :disabled="busy" @click="decide('approve')">
      {{ gate.kind === "spec" ? "Approve spec" : "Approve" }}
    </button>
    <button v-if="gate.actions.includes('reject') && keeps()" type="button" class="btn btn-outline-action" :disabled="busy || !held?.trim()" :title="held?.trim() ? undefined : 'Write the Feedback first'" @click="decide('reject')">
      Reject with Feedback
    </button>
    <button v-else-if="gate.actions.includes('reject') && !form" type="button" class="btn btn-outline-action" :disabled="busy" @click="open('reject')">
      Reject…
    </button>
    <button v-if="gate.redo && !form" type="button" class="btn btn-primary" :disabled="busy" @click="open('retry')">
      Retry…
    </button>
    <button v-if="gate.redo?.goBack.length && !form" type="button" class="btn btn-outline-action" :disabled="busy" @click="open('go_back')">
      Go back…
    </button>
    <form v-if="form" class="stack" @submit.prevent="decide(form)">
      <label v-if="form === 'go_back'">
        Go back to
        <select v-model="target" aria-label="Step to go back to" required>
          <option v-for="s in gate.redo!.goBack" :key="s.stepId" :value="s.stepId">{{ stepLabel(s) }}</option>
        </select>
        <span class="muted"> · it and every Step after it replay; files are kept as they are.</span>
      </label>
      <textarea
        v-model="feedback"
        rows="3"
        :placeholder="form === 'retry' ? 'Feedback (optional): what should the Step do differently?' : 'Feedback: what should change?'"
        aria-label="Feedback"
        :required="form !== 'retry'"
      />
      <div>
        <button type="submit" class="btn btn-primary" :disabled="busy || (form !== 'retry' && !feedback.trim())">
          {{ form === "retry" ? "Retry the Step" : form === "go_back" ? "Go back" : "Send Feedback" }}
        </button>
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="form = null">Cancel</button>
      </div>
    </form>
    <button v-if="gate.actions.includes('abandon') && !form" type="button" class="btn btn-danger" :disabled="busy" @click="decide('abandon')">
      Abandon
    </button>
    <span v-if="error" class="error">{{ error }}</span>
  </div>
</template>

<style scoped>
.gate-actions { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: center; margin: 0; }
.gate-actions form { flex: 1 1 100%; margin: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
.gate-actions form > div { display: flex; gap: var(--sp-2); }
.gate-actions textarea { width: 100%; min-height: 4.5rem; max-height: 40vh; background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius-md); padding: 0.7rem; font: var(--fs-sm) var(--font-ui); resize: vertical; }
.gate-actions select { background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius-md); padding: 0.4rem; font: var(--fs-sm) var(--font-ui); }
.btn:disabled { opacity: 0.5; cursor: wait; }
.btn:focus-visible { outline: 2px solid var(--ai); outline-offset: 2px; }
</style>
