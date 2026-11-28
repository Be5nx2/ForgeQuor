<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { getJson, type ApprovedRun, type OpenGate, type Project, type Run, type RunDetail } from "../api";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import LoadingState from "../components/LoadingState.vue";
import StatusChip from "../components/StatusChip.vue";
import { liveEvents } from "../liveEvents";
import { gateAction, gateLabel, isActive, keepsState, nowOf, startedLabel, statePills, waitingFor, type PillId } from "../runsHome";
import { runStatus } from "../status";

/** The Runs home: what waits for the human (Gates, then pull requests to merge) pinned above every Run. */
const projects = ref<Project[]>([]);
const runs = ref<Run[]>([]);
const gates = ref<OpenGate[]>([]);
/** The merge list: Approved Runs whose pull request waits for the human's merge. */
const merges = ref<ApprovedRun[]>([]);
/** The detail of each active Run, for its "Now" cell. */
const details = ref<Record<number, RunDetail>>({});
const filterProject = ref("");
const pill = ref<PillId>("all");
/** Archived Runs (finished, their worktree removed) are hidden unless asked for. */
const showArchived = ref(false);
/** False until the first answer, so an empty page never reads as "No Run" while it is loading. */
const loaded = ref(false);
const loadError = ref("");
/** Loads overlap when Runs change quickly or a filter changes: only the latest may write, so an older answer never hides a Run. */
let latest = 0;

async function load() {
  const mine = ++latest;
  const q = new URLSearchParams();
  if (filterProject.value) q.set("projectId", filterProject.value);
  try {
    // Projects come along, so a Run of a Project registered since is named, not shown as a bare id.
    const [found, known, open] = await Promise.all([
      getJson<Run[]>(`/api/runs?${q}`),
      getJson<Project[]>("/api/projects"),
      getJson<OpenGate[]>("/api/gates"),
    ]);
    // The merge list, and a Run's detail, failing to load must not hide the Runs and the open Gates.
    const [approved, active] = await Promise.all([
      getJson<ApprovedRun[]>("/api/approved-runs").catch(() => merges.value),
      Promise.all(found.filter((r) => isActive(r.state)).map((r) => getJson<RunDetail>(`/api/runs/${r.id}`).catch(() => details.value[r.id]))),
    ]);
    if (mine !== latest) return;
    runs.value = found;
    projects.value = known;
    gates.value = open;
    merges.value = approved;
    details.value = Object.fromEntries(active.filter((d): d is RunDetail => !!d).map((d) => [d.id, d]));
    loaded.value = true;
    loadError.value = "";
  } catch (e: any) {
    if (mine === latest) loadError.value = e.message;
  }
}

// Same-named Projects are told apart by their local path, in the menu and in the list: two Projects called alike once
// made a Run look missing from its Project.
const projectLabel = (p: Project) => `${p.name} (${p.localPath})`;

const shown = computed(() => runs.value.filter((r) => (showArchived.value || !r.archivedAt) && keepsState(pill.value, r.state)));
const activeCount = computed(() => runs.value.filter((r) => isActive(r.state) && !r.archivedAt).length);
const filtered = computed(() => pill.value !== "all" || !!filterProject.value || (!showArchived.value && runs.value.some((r) => r.archivedAt)));
const nothing = computed(() => !gates.value.length && !merges.value.length && !runs.value.length);

let stopFollowing: () => void;
onMounted(async () => {
  stopFollowing = liveEvents.follow((u) => u.type === "changed" && load(), load);
  await load();
});
onUnmounted(() => stopFollowing?.());
watch(filterProject, load);
</script>

<template>
  <div class="head">
    <div>
      <h1>Runs</h1>
      <p v-if="loaded" class="lede">{{ activeCount }} active</p>
    </div>
  </div>

  <ErrorState v-if="loadError" title="Could not load the Runs" text="The Forgequor server did not answer. Check that it is running, then retry." :details="loadError" @retry="load" />
  <LoadingState v-else-if="!loaded" what="Runs" />
  <EmptyState v-else-if="nothing && !filterProject" title="No Run yet" text="A Run is one Workflow carried out on a Project. Start one to see it here.">
    <router-link class="btn btn-primary" to="/new">+ New Run</router-link>
  </EmptyState>
  <template v-else>
    <section aria-label="Waiting for you">
      <h2>Waiting for you<span class="n">{{ gates.length }}</span></h2>
      <div v-if="gates.length" class="cards">
        <article v-for="g in gates" :key="g.id" class="wcard">
          <span class="kind">{{ gateLabel(g.kind) }}</span>
          <h3>#{{ g.runId }} {{ g.runTitle }}</h3>
          <p>{{ g.reason }}</p>
          <div class="row">
            <span class="muted when">{{ waitingFor(g.openedAt) }}</span>
            <router-link class="btn btn-primary" :to="`/runs/${g.runId}`">{{ gateAction(g.kind) }}</router-link>
          </div>
        </article>
      </div>
      <EmptyState v-else title="Nothing needs you" text="Every Run is moving on its own. Gates will show up here." />
    </section>

    <section aria-label="Waiting for your merge">
      <h2>Waiting for your merge<span class="n">{{ merges.length }}</span></h2>
      <div v-if="merges.length" class="cards">
        <article v-for="r in merges" :key="r.id" class="wcard merge">
          <span class="kind">Approved<template v-if="r.prNumber"> · pull request #{{ r.prNumber }}</template></span>
          <h3><router-link :to="`/runs/${r.id}`">#{{ r.id }} {{ r.title }}</router-link></h3>
          <p>{{ r.projectName }}. Holds no slot; stays here until merged, closed or abandoned.</p>
          <div class="row">
            <StatusChip :status="runStatus('approved')" />
            <a v-if="r.prUrl" class="btn" :href="r.prUrl" target="_blank" rel="noopener">Open pull request ↗</a>
            <span v-else class="muted when">no pull request</span>
          </div>
        </article>
      </div>
      <EmptyState v-else title="No pull request waits for your merge" text="An approved Run's pull request will show up here." />
    </section>

    <section aria-label="All Runs">
      <h2>All Runs</h2>
      <div class="panel tight">
        <div class="tools">
          <div class="pills" role="group" aria-label="Filter by state">
            <button v-for="p in statePills" :key="p.id" type="button" :aria-pressed="pill === p.id" @click="pill = p.id">{{ p.label }}</button>
          </div>
          <select v-model="filterProject" aria-label="Filter by Project">
            <option value="">All Projects</option>
            <option v-for="p in projects" :key="p.id" :value="String(p.id)">{{ projectLabel(p) }}</option>
          </select>
          <label class="muted"><input v-model="showArchived" type="checkbox" /> Show archived</label>
        </div>
        <EmptyState v-if="!shown.length && filtered" title="No Run matches these filters" text="Change the filters, or show the archived Runs, to see more." />
        <EmptyState v-else-if="!shown.length" title="No Run yet" text="A Run is one Workflow carried out on a Project. Start one to see it here.">
          <router-link class="btn btn-primary" to="/new">+ New Run</router-link>
        </EmptyState>
        <div v-else class="scroll">
          <table>
            <thead><tr><th>State</th><th>Run</th><th>Workflow</th><th>Now</th><th>Iteration</th><th>Started</th></tr></thead>
            <tbody>
              <tr v-for="r in shown" :key="r.id">
                <td><StatusChip :status="runStatus(r.state)" /></td>
                <td>
                  <router-link :to="`/runs/${r.id}`">#{{ r.id }} {{ r.title }}</router-link>
                  <span v-if="r.archivedAt" class="badge">archived</span>
                  <span v-if="r.trackerRef" class="sub">{{ r.trackerRef }}</span>
                </td>
                <td>{{ r.workflow }}</td>
                <td>
                  {{ nowOf(r, details[r.id]).text }}
                  <span v-if="nowOf(r, details[r.id]).sub" class="sub">{{ nowOf(r, details[r.id]).sub }}</span>
                </td>
                <td>{{ r.state === "queued" ? "–" : r.iteration }}</td>
                <td>{{ startedLabel(r.createdAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  </template>
</template>

<style scoped>
/* The Runs home of runs.html: the page head, the waiting cards, and the state-filtered table. */
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-4); flex-wrap: wrap; margin-bottom: var(--sp-5); }
h1 { font: 700 var(--fs-xl, 1.5rem) var(--font-brand); letter-spacing: 0.06em; }
.lede { color: var(--text-muted); font-size: var(--fs-sm); margin: var(--sp-1) 0 0; }
section { margin-bottom: var(--sp-6); }
section h2 { font: 700 var(--fs-sm) var(--font-brand); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ice-blue); margin: 0 0 var(--sp-3); }
section h2 .n { color: var(--action); margin-left: 0.4rem; }
.state { min-height: 0; margin: 0; }

.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(22rem, 100%), 1fr)); gap: var(--sp-4); }
.wcard { border: 1px solid var(--action); border-radius: var(--radius-lg); padding: var(--sp-4) var(--sp-5); background: linear-gradient(90deg, rgb(255 140 36 / 0.12), rgb(16 29 45 / 0.9)); box-shadow: 0 0 20px rgb(255 140 36 / 0.14); display: flex; flex-direction: column; gap: var(--sp-3); }
.wcard.merge { border-color: var(--border-strong); background: rgb(16 29 45 / 0.9); box-shadow: none; }
.wcard .kind { font: 700 var(--fs-xs) var(--font-brand); letter-spacing: 0.08em; text-transform: uppercase; color: var(--molten-gold); }
.wcard.merge .kind { color: var(--ice-blue); }
.wcard h3 { font-size: var(--fs-md); font-weight: 600; }
.wcard p { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
.wcard .row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); margin-top: auto; }
.wcard .btn { text-decoration: none; }
.when { font-size: var(--fs-xs); }

.panel { background: linear-gradient(180deg, rgb(23 40 61 / 0.85), rgb(16 29 45 / 0.85)); border: 1px solid var(--border-strong); border-radius: var(--radius-lg); padding: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-3); box-shadow: 0 0 0 1px rgb(56 189 248 / 0.06), 0 12px 40px rgb(0 0 0 / 0.35); }
.tools { display: flex; gap: var(--sp-3); flex-wrap: wrap; align-items: center; }
.pills { display: flex; gap: var(--sp-2); flex-wrap: wrap; margin-right: auto; }
.pills button { background: transparent; border: 1px solid var(--border-strong); color: var(--text-muted); border-radius: 999px; padding: 0.35rem 0.8rem; font: 500 var(--fs-xs) var(--font-ui); cursor: pointer; }
.pills button[aria-pressed="true"] { color: var(--text); border-color: var(--ai); background: rgb(56 189 248 / 0.12); }
.tools select { max-width: 100%; min-width: 0; }
.tools label { font-size: var(--fs-xs); display: flex; align-items: center; gap: 0.35rem; }
.tools input[type="checkbox"] { flex: none; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
th { text-align: left; color: var(--text-muted); font-weight: 500; font-size: var(--fs-xs); padding: 0.5rem 0.7rem; border-bottom: 1px solid var(--border-strong); }
td { padding: 0.7rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
tbody tr:hover { background: rgb(56 189 248 / 0.05); }
td .sub { display: block; color: var(--text-muted); font-size: var(--fs-xs); }
</style>
