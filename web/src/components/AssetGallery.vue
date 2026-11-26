<script setup lang="ts">
import { ref } from "vue";
import type { Asset } from "../api";

defineProps<{ runId: number; iteration: number; assets: Asset[] }>();

/** The preview's backdrop: the UI's own grey, so transparency is visible; not saved anywhere. */
const UI_GREY = "#101d2d";
const backdrop = ref(UI_GREY);

const HAS_IMAGE = ["waiting", "approved"];
/** Magnification that brings the longest side to about 256 screen pixels, in whole steps so pixels stay square. */
const zoom = (a: Asset) => Math.min(16, Math.max(2, Math.floor(256 / Math.max(a.width, a.height))));
</script>

<template>
  <div class="gallery">
    <label class="backdrop">
      Background
      <input v-model="backdrop" type="color" aria-label="Background colour" />
      <button type="button" class="secondary" :disabled="backdrop === UI_GREY" @click="backdrop = UI_GREY">Reset</button>
    </label>
    <ul>
      <li v-for="a in assets" :key="a.id">
        <strong>{{ a.name }}</strong> <span class="badge">{{ a.status }}</span>
        <div class="muted">{{ a.kind }} · {{ a.width }}x{{ a.height }}<span v-if="a.fill"> · fills its square</span> · <code>{{ a.targetPath }}</code></div>
        <ul v-if="a.warnings.length" class="warnings" aria-label="Palette warnings">
          <li v-for="w in a.warnings" :key="w" class="error">⚠ {{ w }}</li>
        </ul>
        <div v-if="HAS_IMAGE.includes(a.status)" class="previews" :style="{ background: backdrop }">
          <img
            :src="`/api/runs/${runId}/assets/${a.id}/image?i=${iteration}`"
            :width="a.width"
            :height="a.height"
            :alt="`${a.name} at real size`"
            class="pixels"
          />
          <img
            :src="`/api/runs/${runId}/assets/${a.id}/image?i=${iteration}`"
            :width="a.width * zoom(a)"
            :height="a.height * zoom(a)"
            :alt="`${a.name} magnified ${zoom(a)} times`"
            class="pixels"
          />
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.warnings { margin: 0.25rem 0 0; }
.warnings li { background: transparent; padding: 0; margin: 0; }
.backdrop { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem; }
.backdrop input { flex: none; padding: 0; width: 2.5rem; height: 2rem; }
.previews { display: flex; gap: 1.5rem; align-items: flex-start; padding: 0.75rem; margin-top: 0.5rem; border-radius: 6px; border: 1px solid #94a3b8; overflow-x: auto; }
.pixels { image-rendering: crisp-edges; image-rendering: pixelated; flex: none; }
</style>
