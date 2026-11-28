<script setup lang="ts">
/** The shared loading state (states.html): a skeleton that fills the panel, announced to screen readers as `what`. */
defineProps<{ what: string }>();
</script>

<template>
  <div class="state" role="status" aria-busy="true">
    <div class="skeleton" aria-hidden="true"><i></i><i></i><i></i></div>
    <p class="sr-only">Loading {{ what }}</p>
  </div>
</template>
