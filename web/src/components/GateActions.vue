<script setup lang="ts">
import { ref } from "vue";
import { decideGate, type Gate, type GateAction } from "../api";

const props = defineProps<{ gate: Gate }>();
const emit = defineEmits<{ decided: [] }>();

const busy = ref(false);
const error = ref("");
const rejecting = ref(false);
const feedback = ref("");

async function decide(action: GateAction) {
  if (action === "abandon" && !window.confirm("Abandon this Run? It stops for good; its branch and worktree are kept.")) return;
  busy.value = true;
  error.value = "";
  try {
    await decideGate(props.gate.id, action, action === "reject" ? feedback.value : undefined);
    emit("decided");
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="gate-actions" @click.stop>
    <button v-if="gate.actions.includes('approve')" type="button" :disabled="busy" @click="decide('approve')">Approve</button>
    <button v-if="gate.actions.includes('reject') && !rejecting" type="button" class="secondary" :disabled="busy" @click="rejecting = true">
      Reject…
    </button>
    <form v-if="rejecting" class="stack" @submit.prevent="decide('reject')">
      <textarea v-model="feedback" rows="3" placeholder="Feedback: what should change?" aria-label="Feedback" required />
      <div>
        <button type="submit" :disabled="busy || !feedback.trim()">Send Feedback</button>
        <button type="button" class="secondary" :disabled="busy" @click="rejecting = false">Cancel</button>
      </div>
    </form>
    <button v-if="gate.actions.includes('abandon') && !rejecting" type="button" class="secondary" :disabled="busy" @click="decide('abandon')">
      Abandon
    </button>
    <span v-if="error" class="error">{{ error }}</span>
  </div>
</template>
