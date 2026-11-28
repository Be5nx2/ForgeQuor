<script setup lang="ts">
import { onMounted, ref } from "vue";
import { getJson, putJson, type Team, type TeamField, type TeamSeat } from "../api";
import ErrorState from "../components/ErrorState.vue";
import LoadingState from "../components/LoadingState.vue";

const team = ref<Team | null>(null);
const error = ref("");
/** Why the Team could not load (a failed save stays in `error`). */
const loadError = ref("");
/** What is being typed per seat: its Runner and model. */
const drafts = ref<Record<string, { runner: string; model: string }>>({});

function fill(t: Team) {
  team.value = t;
  drafts.value = Object.fromEntries(t.seats.map((s) => [s.seat, { runner: s.runner.value ?? "", model: s.model.value ?? "" }]));
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
const offered = (s: TeamSeat) => team.value?.models[drafts.value[s.seat]!.runner] ?? [];
const where = (f: TeamField) => (f.source === "env" ? `locked by ${f.variable}` : f.source === "team" ? "set here" : "default");

async function save(s: TeamSeat) {
  error.value = "";
  const draft = drafts.value[s.seat]!;
  // Only the fields the environment does not hold, and only what changed.
  const body: { runner?: string | null; model?: string | null } = {};
  if (s.runner.source !== "env" && draft.runner !== (s.runner.value ?? "")) body.runner = draft.runner || null;
  if (s.model.source !== "env" && draft.model !== (s.model.value ?? "")) body.model = draft.model || null;
  if (!Object.keys(body).length) return;
  try {
    fill(await putJson<Team>(`/api/team/${s.seat}`, body));
  } catch (e: any) {
    error.value = e.message;
  }
}

onMounted(load);
</script>

<template>
  <h2>Team</h2>
  <p class="muted">Each seat's Runner and model. A change applies to the Runs that start afterwards. A field set by an environment variable is locked.</p>
  <p v-if="error" class="error">{{ error }}</p>
  <ErrorState v-if="loadError" title="Could not load the Team" text="The Forgequor server did not answer. Check that it is running, then retry." :details="loadError" @retry="load" />
  <LoadingState v-else-if="!team" what="the Team" />
  <ul v-else>
    <li v-for="s in team.seats" :key="s.seat">
      <form class="stack" @submit.prevent="save(s)">
        <strong>{{ s.seat }}</strong>
        <label>
          Runner
          <select v-model="drafts[s.seat]!.runner" :disabled="s.runner.source === 'env'" :aria-label="`Runner of ${s.seat}`">
            <option v-for="r in Object.keys(team.models)" :key="r" :value="r">{{ r }}</option>
          </select>
          <span class="muted"> {{ where(s.runner) }}</span>
        </label>
        <label>
          Model
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
          <span class="muted"> {{ where(s.model) }}</span>
        </label>
        <button type="submit" :disabled="s.runner.source === 'env' && s.model.source === 'env'">Save</button>
      </form>
    </li>
  </ul>
</template>
