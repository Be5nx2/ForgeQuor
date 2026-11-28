<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { followRuns, getJson, type ApprovedRun, type OpenGate, type RunDetail } from "../api";
import AssetGallery from "../components/AssetGallery.vue";
import GateActions from "../components/GateActions.vue";
import Markdown from "../components/Markdown.vue";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import LoadingState from "../components/LoadingState.vue";
import StatusChip from "../components/StatusChip.vue";
import { gateStatus, runStatus } from "../status";

const router = useRouter();
const openRun = (id: number) => router.push(`/runs/${id}`);
const gates = ref<OpenGate[]>([]);
const runs = ref<Record<number, RunDetail>>({});
/** The merge list: Approved Runs whose pull request waits for the human's merge. */
const merges = ref<ApprovedRun[]>([]);
/** False until the first answer, so an empty page never reads as "Nothing needs you" while it is loading. */
const loaded = ref(false);
const loadError = ref("");
/** Loads overlap when Runs change quickly: only the latest may write, so an older answer never shows a stale list. */
let latest = 0;

async function load() {
  const mine = ++latest;
  try {
    // The merge list failing to load must not hide the open Gates.
    const [open, approved] = await Promise.all([
      getJson<OpenGate[]>("/api/gates"),
      getJson<ApprovedRun[]>("/api/approved-runs").catch(() => merges.value),
    ]);
    // An Asset Gate is judged on the images, so its Run comes along to show them.
    const assetRuns = await Promise.all(open.filter((g) => g.kind === "asset").map((g) => getJson<RunDetail>(`/api/runs/${g.runId}`)));
    if (mine !== latest) return;
    runs.value = Object.fromEntries(assetRuns.map((r) => [r.id, r]));
    gates.value = open;
    merges.value = approved;
    loaded.value = true;
    loadError.value = "";
  } catch (e: any) {
    if (mine === latest) loadError.value = e.message;
  }
}

let stopFollowing: () => void;
onMounted(() => {
  load();
  stopFollowing = followRuns((u) => u.type === "changed" && load(), load);
});
onUnmounted(() => stopFollowing?.());
</script>

<template>
  <h2>Waiting for you</h2>
  <ErrorState v-if="loadError" title="Could not load what waits for you" text="The Forgequor server did not answer. Check that it is running, then retry." :details="loadError" @retry="load" />
  <LoadingState v-else-if="!loaded" what="Gates" />
  <EmptyState v-else-if="!gates.length" title="Nothing needs you" text="Every Run is moving on its own. Gates will show up here.">
    <router-link class="btn" to="/new">+ New Run</router-link>
  </EmptyState>
  <ul>
    <li v-for="g in gates" :key="g.id" class="clickable" @click="openRun(g.runId)">
      <strong>{{ g.runTitle }}</strong>
      <StatusChip :status="gateStatus(null)" />
      <span class="muted"> {{ g.kind === "final" ? "final Gate" : g.kind === "asset" ? "Asset Gate" : g.kind === "review" ? "review Gate" : g.kind === "spec" ? "spec Gate" : g.kind === "conversation" ? "Conversation Gate" : "Escalation" }}</span>
      <div class="muted">{{ g.projectName }} · {{ g.reason }}</div>
      <Markdown v-if="g.evidence && (g.kind === 'spec' || g.kind === 'conversation')" :text="g.evidence" />
      <pre v-else-if="g.evidence">{{ g.evidence }}</pre>
      <div v-if="g.kind === 'asset' && runs[g.runId]" @click.stop>
        <AssetGallery :run-id="g.runId" :iteration="runs[g.runId]!.iteration" :assets="runs[g.runId]!.assets" :gate="g" @decided="load" />
      </div>
      <GateActions :gate="g" @decided="load" />
    </li>
  </ul>

  <h2>Waiting for your merge</h2>
  <LoadingState v-if="!loaded && !loadError" what="pull requests" />
  <EmptyState v-else-if="loaded && !merges.length" title="No pull request waits for your merge" text="An approved Run's pull request will show up here." />
  <ul>
    <li v-for="r in merges" :key="r.id" class="clickable" @click="openRun(r.id)">
      <strong>{{ r.title }}</strong>
      <StatusChip :status="runStatus('approved')" />
      <div class="muted">
        {{ r.projectName }} ·
        <a v-if="r.prUrl" :href="r.prUrl" target="_blank" rel="noopener" @click.stop>pull request #{{ r.prNumber }}</a>
        <span v-else>no pull request</span>
      </div>
    </li>
  </ul>
</template>
