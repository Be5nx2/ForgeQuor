<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { getJson, putJson, type Team, type TeamField, type TeamSeat } from "../api";
import { effortChoice, effortOptions } from "../effort";
import ErrorState from "../components/ErrorState.vue";
import LoadingState from "../components/LoadingState.vue";

const team = ref<Team | null>(null);
const error = ref("");
/** Why the Team could not load (a failed save stays in `error`). */
const loadError = ref("");
/** What is being typed per seat: its Runner, model and effort (empty effort is the Runner's default). */
const drafts = ref<Record<string, { runner: string; model: string; effort: string }>>({});

function fill(t: Team) {
  team.value = t;
  drafts.value = Object.fromEntries(t.seats.map((s) => [s.seat, { runner: s.runner.value ?? "", model: s.model.value ?? "", effort: s.effort.value ?? "" }]));
}

async function load() {
  try {
    fill(await getJson<Team>("/api/team"));
    loadError.value = "";
  } catch (e: any) {
    loadError.value = e.message;
  }
}

/** Offered models for the Runner picked in the draft. */
const offered = (s: TeamSeat) => team.value?.catalog[drafts.value[s.seat]!.runner]?.models.map((m) => m.id) ?? [];
/** The effort select of a seat, from its draft Runner and model: the levels on offer and whether the picked one still fits. */
const choice = (s: TeamSeat) => {
  const d = drafts.value[s.seat]!;
  return effortChoice(team.value?.catalog, d.runner, d.model.trim(), d.effort);
};
/** A seat cannot be saved while its effort does not fit its Runner and model. */
const blocked = (s: TeamSeat) => choice(s).invalid !== null;
const builtIn = computed(() => Object.entries(team.value?.catalog ?? {}).filter(([, e]) => e.fallback).map(([r]) => RUNNER_LABELS[r] ?? r));
const RUNNER_LABELS: Record<string, string> = { claude: "Claude Code", codex: "Codex" };
const where = (f: TeamField) => (f.source === "env" ? `locked by ${f.variable}` : f.source === "team" ? "set here" : "default");

async function save(s: TeamSeat) {
  error.value = "";
  const draft = drafts.value[s.seat]!;
  // Only the fields the environment does not hold, and only what changed.
  const body: { runner?: string | null; model?: string | null; effort?: string | null } = {};
  if (s.runner.source !== "env" && draft.runner !== (s.runner.value ?? "")) body.runner = draft.runner || null;
  if (s.model.source !== "env" && draft.model !== (s.model.value ?? "")) body.model = draft.model || null;
  if (s.effort.source !== "env" && draft.effort !== (s.effort.value ?? "")) body.effort = draft.effort || null;
  if (!Object.keys(body).length || blocked(s)) return;
  try {
    fill(await putJson<Team>(`/api/team/${s.seat}`, body));
  } catch (e: any) {
    error.value = e.message;
  }
}

onMounted(load);
</script>

<template>
  <div class="head">
    <h1>Team</h1>
    <p class="lede">Each seat's Runner, model and effort. A change applies to the Runs that start afterwards. A field set by an environment variable is locked.</p>
  </div>
  <p v-if="error" class="banner" role="alert">{{ error }}</p>
  <ErrorState v-if="loadError" title="Could not load the Team" text="The Forgequor server did not answer. Check that it is running, then retry." :details="loadError" @retry="load" />
  <LoadingState v-else-if="!team" what="the Team" />
  <p v-else-if="builtIn.length" class="banner" role="status">
    Forgequor could not read {{ builtIn.join(" and ") }} at startup, so the model and effort lists shown for {{ builtIn.length > 1 ? "them" : "it" }} are built in and may be out of date. Restart Forgequor once the CLI works.
  </p>
  <ul v-if="team" class="seats">
    <li v-for="s in team.seats" :key="s.seat">
      <form @submit.prevent="save(s)">
        <h3>{{ s.seat }}</h3>
        <label class="field">
          <span class="label">Runner</span>
          <select v-model="drafts[s.seat]!.runner" :disabled="s.runner.source === 'env'" :aria-label="`Runner of ${s.seat}`">
            <option v-for="r in Object.keys(team.catalog)" :key="r" :value="r">{{ r }}</option>
          </select>
          <span class="hint" :class="{ locked: s.runner.source === 'env' }">{{ where(s.runner) }}</span>
        </label>
        <label class="field">
          <span class="label">Model</span>
          <input
            v-model="drafts[s.seat]!.model"
            :list="`models-${s.seat}`"
            :disabled="s.model.source === 'env'"
            placeholder="the Runner's own default"
            :aria-label="`Model of ${s.seat}`"
          />
          <datalist :id="`models-${s.seat}`">
            <option v-for="m in offered(s)" :key="m" :value="m" />
          </datalist>
          <span class="hint" :class="{ locked: s.model.source === 'env' }">{{ where(s.model) }}</span>
        </label>
        <label class="field">
          <span class="label">Effort</span>
          <select v-model="drafts[s.seat]!.effort" :disabled="s.effort.source === 'env'" :aria-label="`Effort of ${s.seat}`" :aria-invalid="blocked(s)">
            <option value="">Runner default</option>
            <option v-for="l in effortOptions(choice(s), drafts[s.seat]!.effort)" :key="l" :value="l">{{ l }}</option>
          </select>
          <span v-if="choice(s).invalid" class="hint invalid" role="alert">{{ choice(s).invalid }}</span>
          <span v-else class="hint" :class="{ locked: s.effort.source === 'env' }">{{ where(s.effort) }}</span>
        </label>
        <button type="submit" class="btn btn-primary" :disabled="blocked(s) || (s.runner.source === 'env' && s.model.source === 'env' && s.effort.source === 'env')">Save</button>
      </form>
    </li>
  </ul>
</template>
<style scoped>
.head { margin-bottom: var(--sp-5); }
h1 { font: 700 var(--fs-xl, 1.5rem) var(--font-brand); letter-spacing: 0.06em; }
.lede { color: var(--text-muted); font-size: var(--fs-sm); margin: var(--sp-1) 0 0; max-width: 46rem; }
.banner { border: 1px solid var(--highlight); background: rgb(255 197 107 / 0.08); border-radius: var(--radius-md); padding: var(--sp-3) var(--sp-4); font-size: var(--fs-sm); color: var(--highlight); margin: 0 0 var(--sp-4); }
.seats { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr)); gap: var(--sp-4); }
.seats li { margin: 0; padding: var(--sp-5); background: linear-gradient(180deg, rgb(23 40 61 / 0.85), rgb(16 29 45 / 0.85)); border: 1px solid var(--border-strong); border-radius: var(--radius-lg); box-shadow: 0 0 0 1px rgb(56 189 248 / 0.06), 0 12px 40px rgb(0 0 0 / 0.35); }
form { display: flex; flex-direction: column; gap: var(--sp-4); margin: 0; }
h3 { font: 700 var(--fs-sm) var(--font-brand); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ice-blue); }
.field { display: flex; flex-direction: column; gap: var(--sp-2); }
.label { font-size: var(--fs-sm); font-weight: 600; }
.hint { font-size: var(--fs-xs); color: var(--text-muted); }
.hint.locked { color: var(--highlight); }
.hint.invalid { color: var(--st-bad); }
select, input { flex: none; width: 100%; box-sizing: border-box; padding: 0.65rem 0.75rem; background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius-md); font: var(--fs-sm) var(--font-ui); }
select:disabled, input:disabled { opacity: 0.55; cursor: not-allowed; }
.btn { align-self: flex-start; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
