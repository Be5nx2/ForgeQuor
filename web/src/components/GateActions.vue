<script setup lang="ts">
import { ref } from "vue";
import { decideGate, type Gate, type GateAction } from "../api";

const props = defineProps<{ gate: Gate }>();
const emit = defineEmits<{ decided: [] }>();

const busy = ref(false);
const error = ref("");

async function decide(action: GateAction) {
  if (action === "abandon" && !window.confirm("Abandon this Run? It stops for good; its branch and worktree are kept.")) return;
  busy.value = true;
  error.value = "";
  try {
    await decideGate(props.gate.id, action);
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
    <button v-if="gate.actions.includes('abandon')" type="button" class="secondary" :disabled="busy" @click="decide('abandon')">
      Abandon
    </button>
    <span v-if="error" class="error">{{ error }}</span>
  </div>
</template>
