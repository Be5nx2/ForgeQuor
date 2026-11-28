<script setup lang="ts">
/** The shared error state (states.html): says what could not load, offers Retry, and keeps the server's words under Details. */
defineProps<{ title: string; text?: string; details?: string }>();
defineEmits<{ retry: [] }>();
</script>

<template>
  <div class="state err" role="alert">
    <h3>{{ title }}</h3>
    <p v-if="text">{{ text }}</p>
    <button class="btn btn-outline-action" type="button" @click="$emit('retry')">Retry</button>
    <details v-if="details"><summary>Details</summary><span class="mono">{{ details }}</span></details>
  </div>
</template>
