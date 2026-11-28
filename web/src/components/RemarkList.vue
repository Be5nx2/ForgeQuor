<script setup lang="ts">
import type { RemarkTable } from "../runDetail";

/** A Review's remarks (run-detail.html): each with where it points and how each Reviewer voted; a split vote is marked disputed. */
defineProps<{ table: RemarkTable }>();
</script>

<template>
  <div class="remarks" aria-label="Remarks">
    <p v-if="!table.remarks.length" class="muted">No remarks: the Review found nothing.</p>
    <div v-for="r in table.remarks" :key="r.id" class="remark" :class="{ disputed: r.disputed && !r.dropped }">
      <span class="id">{{ r.id }}</span>
      <div>
        {{ r.text }}<template v-if="r.where"><br /><span class="mono muted">{{ r.where }}</span></template>
      </div>
      <div class="votes">
        <span v-for="v in r.votes" :key="v.reviewer" class="chip" :data-s="v.vote === 'change' ? 'bad' : 'ok'" :data-g="v.vote === 'change' ? '✕' : '✓'">{{ v.reviewer }} {{ v.vote }}</span>
        <span v-if="r.dropped" class="chip" data-s="idle" data-g="–">dropped</span>
        <span v-else-if="r.disputed" class="chip" data-s="waiting" data-g="●">disputed</span>
        <span v-else-if="r.votes.length" class="chip" data-s="ok" data-g="✓">kept</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.remarks { display: grid; gap: var(--sp-3); }
.remark { display: grid; grid-template-columns: 2.4rem 1fr auto; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); background: rgb(8 15 25 / 0.55); border: 1px solid var(--border); border-radius: var(--radius-md); font-size: var(--fs-sm); }
.remark.disputed { border-color: var(--action); box-shadow: 0 0 14px rgb(255 140 36 / 0.2); }
.remark .id { font: 700 var(--fs-md) var(--font-brand); color: var(--steel-grey); }
.votes { display: flex; gap: var(--sp-1); flex-wrap: wrap; justify-content: flex-end; align-items: flex-start; }
</style>
