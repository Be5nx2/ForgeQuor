<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { decideGate, type Asset, type Gate, type Verdict } from "../api";

const props = defineProps<{ runId: number; iteration: number; assets: Asset[]; gate?: Gate }>();
const emit = defineEmits<{ decided: [] }>();

/** The preview's backdrop: the UI's own grey, so transparency is visible; not saved anywhere. */
const UI_GREY = "#101d2d";
const backdrop = ref(UI_GREY);

const HAS_IMAGE = ["waiting", "approved", "rejected"];
/** Magnification that brings the longest side to about 256 screen pixels, in whole steps so pixels stay square. */
const zoom = (a: Asset) => Math.min(16, Math.max(2, Math.floor(256 / Math.max(a.width, a.height))));
const current = (a: Asset, i: number) => `/api/runs/${props.runId}/assets/${a.id}/image?i=${i}`;
const version = (a: Asset, id: number) => `/api/runs/${props.runId}/assets/${a.id}/image?version=${id}`;
/** The versions before the current one, with the Feedback that sent each back. While an Asset is being redone it has no current version yet. */
const past = (a: Asset) => (HAS_IMAGE.includes(a.status) ? a.versions.slice(0, -1) : a.versions);

/** What the human decides for each Asset waiting at the open Gate. */
const judging = computed(() => !!props.gate && !props.gate.decidedAt && props.gate.actions.includes("judge"));
const verdicts = ref<Record<number, { action: "approve" | "reject"; feedback: string }>>({});
watch(
  () => props.assets.filter((a) => a.status === "waiting").map((a) => a.id).join(),
  () => {
    verdicts.value = Object.fromEntries(props.assets.filter((a) => a.status === "waiting").map((a) => [a.id, { action: "approve", feedback: "" }]));
  },
  { immediate: true },
);
const complete = computed(() => Object.values(verdicts.value).every((v) => v.action === "approve" || v.feedback.trim()));

const busy = ref(false);
const error = ref("");
async function submit() {
  busy.value = true;
  error.value = "";
  const all: Verdict[] = Object.entries(verdicts.value).map(([id, v]) =>
    v.action === "reject" ? { assetId: Number(id), action: "reject", feedback: v.feedback } : { assetId: Number(id), action: "approve" },
  );
  try {
    await decideGate(props.gate!.id, "judge", undefined, all);
    emit("decided");
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
function approveAll() {
  for (const v of Object.values(verdicts.value)) v.action = "approve";
  return submit();
}
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
          <img :src="current(a, iteration)" :width="a.width" :height="a.height" :alt="`${a.name} at real size`" class="pixels" />
          <img :src="current(a, iteration)" :width="a.width * zoom(a)" :height="a.height * zoom(a)" :alt="`${a.name} magnified ${zoom(a)} times`" class="pixels" />
        </div>
        <details v-if="past(a).length" class="past">
          <summary>{{ past(a).length }} earlier {{ past(a).length === 1 ? "version" : "versions" }}</summary>
          <div v-for="v in past(a)" :key="v.id" class="earlier">
            <div class="previews" :style="{ background: backdrop }">
              <img :src="version(a, v.id)" :width="a.width" :height="a.height" :alt="`${a.name}, iteration ${v.iteration}`" class="pixels" />
            </div>
            <div class="muted">Iteration {{ v.iteration }}</div>
            <pre v-if="v.feedback">{{ v.feedback }}</pre>
          </div>
        </details>
        <fieldset v-if="judging && verdicts[a.id]" class="verdict">
          <legend>Verdict</legend>
          <label><input v-model="verdicts[a.id]!.action" type="radio" :name="`verdict-${a.id}`" value="approve" /> Approve</label>
          <label><input v-model="verdicts[a.id]!.action" type="radio" :name="`verdict-${a.id}`" value="reject" /> Reject</label>
          <textarea
            v-if="verdicts[a.id]!.action === 'reject'"
            v-model="verdicts[a.id]!.feedback"
            rows="2"
            placeholder="Feedback: what should change?"
            :aria-label="`Feedback on ${a.name}`"
          />
        </fieldset>
      </li>
    </ul>
    <div v-if="judging" class="gate-actions" @click.stop>
      <button type="button" :disabled="busy || !complete" @click="submit">Submit verdicts</button>
      <button type="button" class="secondary" :disabled="busy" @click="approveAll">Approve all</button>
      <span v-if="error" class="error">{{ error }}</span>
    </div>
  </div>
</template>

<style scoped>
.backdrop { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem; }
.backdrop input { flex: none; padding: 0; width: 2.5rem; height: 2rem; }
.warnings { margin: 0.25rem 0 0; }
.warnings li { background: transparent; padding: 0; margin: 0; }
.previews { display: flex; gap: 1.5rem; align-items: flex-start; padding: 0.75rem; margin-top: 0.5rem; border-radius: 6px; border: 1px solid #94a3b8; overflow-x: auto; }
.pixels { image-rendering: crisp-edges; image-rendering: pixelated; flex: none; }
.verdict { display: flex; flex-direction: column; gap: 0.25rem; margin-top: 0.5rem; border: 1px solid #38bdf8; border-radius: 6px; }
.verdict label { display: flex; gap: 0.5rem; align-items: center; }
.verdict input[type="radio"] { flex: none; }
.earlier { margin-top: 0.5rem; }
</style>
