<script setup lang="ts">
import type { Status } from "../status";

/** One status as the mockups' chip: colour, glyph and label together. The mapping from server states lives in `status.ts`. */
defineProps<{ status: Status }>();
</script>

<template>
  <span class="chip" :data-s="status.kind" :data-g="status.glyph">{{ status.label }}</span>
</template>
