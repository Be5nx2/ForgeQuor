<script setup lang="ts">
/** The shared empty state (states.html): says what is missing and leads to the next step, passed as the default slot. */
defineProps<{ title: string; text?: string }>();
</script>

<template>
  <div class="state">
    <h3>{{ title }}</h3>
    <p v-if="text">{{ text }}</p>
    <slot />
  </div>
</template>
