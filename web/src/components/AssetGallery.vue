<script setup lang="ts">
import { ref } from "vue";
import type { Asset } from "../api";
import { checksOf, earlierVersions, hasImage, historyOf, zoomOf, type VerdictDraft, type VerdictDrafts } from "../assetGate";
import { assetStatus } from "../status";
import StatusChip from "./StatusChip.vue";

/**
 * The Asset Gate's gallery: each Asset at real size and magnified (pixel-sharp), its Asset Checks, its history and, while the
 * Gate waits, the human's Verdict. The Verdicts live in the screen (`drafts`), which sends them from the Gate bar.
 */
const props = defineProps<{ runId: number; iteration: number; assets: Asset[]; filesRemoved?: boolean; judging?: boolean; drafts?: VerdictDrafts }>();
const emit = defineEmits<{ verdict: [assetId: number, patch: Partial<VerdictDraft>] }>();

/** The preview's backdrop: the UI's own grey, so transparency is visible; not saved anywhere. */
const UI_GREY = "#101d2d";
const backdrop = ref(UI_GREY);

/** The whole image's width: an Animation Strip is its frames side by side. */
const imageWidth = (a: Asset) => a.width * a.frames;
const current = (a: Asset, i: number) => `/api/runs/${props.runId}/assets/${a.id}/image?i=${i}`;
const replacedArt = (a: Asset) => `/api/runs/${props.runId}/assets/${a.id}/image?replaced=1`;
/** Replaced art that could not be loaded (nothing was there to set aside) is not shown. */
const replacedMissing = ref<Record<number, boolean>>({});
const showReplaced = (a: Asset) => a.replace && !replacedMissing.value[a.id] && hasImage(a);
const version = (a: Asset, id: number) => `/api/runs/${props.runId}/assets/${a.id}/image?version=${id}`;
/** The Artist's attempts that did not pass, each with why: what made the Artist try again. */
const retried = (a: Asset) => a.attempts.filter((t) => !t.written || t.failures.length);
const draft = (a: Asset) => (props.judging ? props.drafts?.[a.id] : undefined);
const cardState = (a: Asset) => {
  const d = draft(a);
  return d ? (d.action === "reject" ? "rejected" : "approved") : a.status;
};
</script>

<template>
  <div class="gallery-wrap">
    <label class="backdrop">
      Background
      <input v-model="backdrop" type="color" aria-label="Background colour" />
      <button type="button" class="btn btn-ghost" :disabled="backdrop === UI_GREY" @click="backdrop = UI_GREY">Reset</button>
    </label>
    <div class="gallery">
      <article v-for="a in assets" :key="a.id" class="asset" :class="cardState(a)" :aria-label="a.name">
        <header>
          <h3>{{ a.name }}</h3>
          <fieldset v-if="draft(a)" class="verdict">
            <legend class="sr-only">Verdict on {{ a.name }}</legend>
            <label :class="{ on: draft(a)!.action === 'approve' }" data-action="approve">
              <input type="radio" :name="`verdict-${a.id}`" value="approve" :checked="draft(a)!.action === 'approve'" @change="emit('verdict', a.id, { action: 'approve' })" /> ✓ Approve
            </label>
            <label :class="{ on: draft(a)!.action === 'reject' }" data-action="reject">
              <input type="radio" :name="`verdict-${a.id}`" value="reject" :checked="draft(a)!.action === 'reject'" @change="emit('verdict', a.id, { action: 'reject' })" /> ✕ Reject
            </label>
          </fieldset>
          <StatusChip v-else :status="assetStatus(a.status)" />
        </header>
        <div class="muted spec">
          {{ a.kind }} · {{ a.width }}x{{ a.height }}<span v-if="a.kind === 'animation'"> × {{ a.frames }} frames</span><span v-if="a.fill"> · fills its square</span><span v-if="a.replace"> · replaces an existing file</span> · <code>{{ a.targetPath }}</code>
        </div>
        <ul v-if="a.warnings.length" class="warnings" aria-label="Palette warnings">
          <li v-for="w in a.warnings" :key="w" class="warn">⚠ {{ w }}</li>
        </ul>
        <p v-if="filesRemoved" class="muted">files removed, see the pull request</p>
        <template v-else>
          <div v-if="showReplaced(a)" class="view" :style="{ background: backdrop }">
            <figure>
              <img :src="replacedArt(a)" :width="imageWidth(a)" :height="a.height" :alt="`${a.name}, the art being replaced, at real size`" class="pixels" @error="replacedMissing[a.id] = true" />
              <figcaption>replaced art · real size</figcaption>
            </figure>
            <figure>
              <img :src="replacedArt(a)" :width="imageWidth(a) * zoomOf(a)" :height="a.height * zoomOf(a)" :alt="`${a.name}, the art being replaced, magnified ${zoomOf(a)} times`" class="pixels" />
              <figcaption>replaced art · ×{{ zoomOf(a) }}</figcaption>
            </figure>
          </div>
          <div v-if="hasImage(a)" class="view" :style="{ background: backdrop }">
            <figure>
              <img :src="current(a, iteration)" :width="imageWidth(a)" :height="a.height" :alt="`${a.name} at real size`" class="pixels" />
              <figcaption>real size</figcaption>
            </figure>
            <figure>
              <img :src="current(a, iteration)" :width="imageWidth(a) * zoomOf(a)" :height="a.height * zoomOf(a)" :alt="`${a.name} magnified ${zoomOf(a)} times`" class="pixels" />
              <figcaption>×{{ zoomOf(a) }}</figcaption>
            </figure>
          </div>
        </template>
        <div v-if="checksOf(a).length" class="checks" aria-label="Asset Checks">
          <span v-for="c in checksOf(a)" :key="c.label" class="chip" :data-s="c.state" :data-g="c.state === 'ok' ? '✓' : c.state === 'warn' ? '!' : '✕'">{{ c.label }}</span>
        </div>
        <div v-if="draft(a)?.action === 'reject'" class="field">
          <label :for="`feedback-${a.id}`" class="label">Feedback <span class="muted opt">required to reject</span></label>
          <textarea :id="`feedback-${a.id}`" class="feedback" :value="draft(a)!.feedback" placeholder="Feedback: what should change?" :aria-label="`Feedback on ${a.name}`" @input="emit('verdict', a.id, { feedback: ($event.target as HTMLTextAreaElement).value })" />
        </div>
        <details v-if="earlierVersions(a).length" class="past">
          <summary>{{ earlierVersions(a).length }} earlier {{ earlierVersions(a).length === 1 ? "version" : "versions" }}</summary>
          <div v-for="v in earlierVersions(a)" :key="v.id" class="earlier">
            <div v-if="!filesRemoved" class="view" :style="{ background: backdrop }">
              <figure>
                <img :src="version(a, v.id)" :width="imageWidth(a)" :height="a.height" :alt="`${a.name}, iteration ${v.iteration}`" class="pixels" />
              </figure>
              <figure>
                <img :src="version(a, v.id)" :width="imageWidth(a) * zoomOf(a)" :height="a.height * zoomOf(a)" :alt="`${a.name}, iteration ${v.iteration}, magnified ${zoomOf(a)} times`" class="pixels" />
              </figure>
            </div>
            <div class="muted">v{{ v.n }} · Iteration {{ v.iteration }}</div>
            <pre v-if="v.feedback">{{ v.feedback }}</pre>
          </div>
        </details>
        <details v-if="retried(a).length" class="past">
          <summary>{{ retried(a).length }} {{ retried(a).length === 1 ? "attempt" : "attempts" }} sent back by the Asset Checks</summary>
          <div v-for="t in retried(a)" :key="`${t.iteration}-${t.attempt}`" class="earlier">
            <div class="muted">Iteration {{ t.iteration }}, attempt {{ t.attempt }}</div>
            <pre v-if="!t.written">Nothing was written at the target path.</pre>
            <pre v-else>{{ t.failures.join("\n") }}</pre>
          </div>
        </details>
        <div v-if="historyOf(a).length" class="history">
          History:
          <span v-for="v in historyOf(a)" :key="v.id">v{{ v.n }}<template v-if="v.current"> (current)</template></span>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.gallery-wrap { display: flex; flex-direction: column; gap: var(--sp-3); }
.backdrop { display: flex; gap: var(--sp-2); align-items: center; font-size: var(--fs-sm); color: var(--text-muted); }
.backdrop input { flex: none; padding: 0; width: 2.5rem; height: 2rem; background: none; border: 0; }
.gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(22rem, 1fr)); gap: var(--sp-4); }
.asset { border: 1px solid var(--border-strong); border-radius: var(--radius-lg); padding: var(--sp-4); background: rgb(8 15 25 / 0.55); display: grid; gap: var(--sp-3); align-content: start; min-width: 0; }
.asset.rejected { border-color: var(--st-bad); }
.asset.approved { border-color: rgb(93 187 138 / 0.6); }
.asset header { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.asset h3 { font-size: var(--fs-md); font-weight: 600; margin: 0; }
.spec { font-size: var(--fs-xs); }
.warnings { list-style: none; margin: 0; padding: 0; font-size: var(--fs-xs); }
.warn { color: var(--highlight); }
.view { display: flex; gap: var(--sp-4); align-items: flex-end; padding: var(--sp-3); border-radius: var(--radius-md); border: 1px solid var(--border); overflow-x: auto; }
.view figure { margin: 0; display: grid; gap: 4px; justify-items: center; font-size: var(--fs-xs); color: var(--text-muted); flex: none; }
.pixels { image-rendering: crisp-edges; image-rendering: pixelated; display: block; }
.checks { display: flex; gap: var(--sp-1); flex-wrap: wrap; }
.verdict { display: flex; gap: var(--sp-1); border: 0; padding: 0; margin: 0; }
.verdict label { display: inline-flex; gap: 0.3rem; align-items: center; padding: 0.28rem 0.6rem; border: 1px solid var(--border-strong); border-radius: 999px; font: 600 var(--fs-xs)/1 var(--font-ui); color: var(--text-muted); cursor: pointer; position: relative; }
.verdict input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.verdict label.on[data-action="approve"] { color: var(--st-ok); border-color: currentColor; }
.verdict label.on[data-action="reject"] { color: var(--st-bad); border-color: currentColor; }
.verdict label:focus-within { outline: 2px solid var(--ai); outline-offset: 2px; }
.field { display: flex; flex-direction: column; gap: var(--sp-2); }
.field > label { font-size: var(--fs-sm); font-weight: 600; }
.field .opt { font-weight: 400; }
.feedback { width: 100%; min-height: 4.5rem; background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius-md); padding: 0.7rem; font: var(--fs-sm) var(--font-ui); resize: vertical; }
.feedback:focus-visible { outline: 2px solid var(--ai); outline-offset: 2px; }
.history { font-size: var(--fs-xs); color: var(--text-muted); display: flex; gap: var(--sp-3); align-items: center; flex-wrap: wrap; }
.past { font-size: var(--fs-sm); color: var(--text-muted); }
.past summary { cursor: pointer; }
.earlier { margin-top: var(--sp-2); }
pre { white-space: pre-wrap; background: rgb(8 15 25 / 0.7); border: 1px solid var(--border); padding: var(--sp-3); border-radius: var(--radius-md); margin: var(--sp-2) 0 0; font: var(--fs-xs)/1.6 var(--font-mono); color: var(--text); }
</style>
