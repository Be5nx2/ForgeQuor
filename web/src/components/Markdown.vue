<script setup lang="ts">
import { computed } from "vue";
import { renderMarkdown } from "../markdown";

/** Markdown an Agent wrote, rendered: the renderer escapes all HTML, so what v-html inserts is only its own tags. */
const props = defineProps<{ text: string }>();
const html = computed(() => renderMarkdown(props.text));
</script>

<template>
  <div class="markdown" v-html="html"></div>
</template>
