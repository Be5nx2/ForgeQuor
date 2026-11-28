<script setup lang="ts">
import { computed } from "vue";
import { neighbour, type RailItem } from "../runDetail";

/** The Run's Steps as a rail (run-detail.html): state dot, name, Iteration, Runner; sub-Steps indented. Selecting a Step is the parent's business. */
const props = defineProps<{ rail: RailItem[]; selected: string }>();
const emit = defineEmits<{ select: [key: string] }>();

/** How far the lit line runs: down to the last Step that has started. */
const lit = computed(() => {
  let last = -1;
  props.rail.forEach((r, i) => {
    if (r.mark !== "idle") last = i;
  });
  return props.rail.length ? Math.round(((last + 1) / props.rail.length) * 100) : 0;
});

function onKey(e: KeyboardEvent) {
  const by = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
  if (!by) return;
  e.preventDefault();
  const key = neighbour(props.rail, props.selected, by);
  emit("select", key);
  (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
}
</script>

<template>
  <ol class="rail" role="tablist" aria-label="Steps" aria-orientation="vertical" :style="{ '--rail': `linear-gradient(180deg, var(--ai), var(--ai) ${lit}%, var(--border) ${lit}%)` }" @keydown="onKey">
    <li
      v-for="r in rail"
      :key="r.key"
      :data-key="r.key"
      role="tab"
      :class="[r.mark, { sub: r.sub }]"
      :aria-selected="r.key === selected"
      :tabindex="r.key === selected ? 0 : -1"
      @click="emit('select', r.key)"
      @keydown.enter.space.prevent="emit('select', r.key)"
    >
      <span class="what">
        {{ r.label }} <small>{{ r.note }}</small>
        <span class="sr-only"> · {{ r.status.label }}</span>
      </span>
      <span v-if="r.runner" class="runner" :title="r.model ? `${r.runner} · ${r.model}` : r.runner">{{ r.runner }}</span>
    </li>
  </ol>
</template>

<style scoped>
.rail { position: relative; padding: 0 0 0 28px; list-style: none; margin: 0; }
.rail::before { content: ""; position: absolute; left: 9px; top: 6px; bottom: 6px; width: 2px; background: var(--rail); box-shadow: 0 0 8px rgb(56 189 248 / 0.5); }
.rail li { position: relative; padding: 0.42rem 0.6rem; margin: 0 0 2px; background: none; border-radius: var(--radius-md); font-size: var(--fs-sm); display: flex; justify-content: space-between; align-items: center; gap: var(--sp-2); cursor: pointer; }
.rail li:hover { background: var(--surface); }
.rail li::before { content: ""; position: absolute; left: -24px; top: 50%; width: 10px; height: 10px; transform: translateY(-50%); border-radius: 50%; background: var(--st-ok); box-shadow: 0 0 8px var(--st-ok); }
.rail li.idle::before { background: var(--bg); border: 2px solid var(--border-strong); box-shadow: none; }
.rail li.bad::before { background: var(--st-bad); box-shadow: 0 0 8px var(--st-bad); }
.rail li.run::before { background: var(--ai); box-shadow: 0 0 12px 2px rgb(56 189 248 / 0.7); }
.rail li.wait::before { background: var(--action); width: 14px; height: 14px; left: -26px; box-shadow: 0 0 16px 3px rgb(255 140 36 / 0.7); }
.rail li.sub { margin-left: 1rem; font-size: var(--fs-xs); }
.rail li[aria-selected="true"] { background: linear-gradient(90deg, rgb(255 140 36 / 0.16), transparent); color: var(--text); }
.rail li:focus-visible { outline: 2px solid var(--ai); outline-offset: 1px; }
.rail small { color: var(--text-muted); margin-left: 0.4rem; }
.what { min-width: 0; }
</style>
