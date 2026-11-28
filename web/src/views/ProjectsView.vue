<script setup lang="ts">
import { nextTick, onMounted, ref } from "vue";
import { getJson, postJson, putJson, type Project } from "../api";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import LoadingState from "../components/LoadingState.vue";

/** The Project the URL names (/projects/:id): scrolled into view once the list is loaded. */
const props = defineProps<{ id?: number }>();

const projects = ref<Project[]>([]);
const path = ref("");
const error = ref("");
/** Why the list could not load (a failed save stays in `error`, above the list). */
const loadError = ref("");
/** False until the first list arrives, so an empty page never reads as "No Project" while it is loading. */
const loaded = ref(false);
/** Check commands being edited, one per line, by Project id. */
const drafts = ref<Record<number, string>>({});
/** Setup commands being edited, one per line, by Project id. */
const setupDrafts = ref<Record<number, string>>({});
/** Max concurrent Runs being edited, by Project id. */
const limits = ref<Record<number, number>>({});
/** Art Direction path and art folder being edited, by Project id. */
const offeredPacks = ref<string[]>([]);
/** Skill Packs being edited, by Project id. */
const packChoices = ref<Record<number, string[]>>({});
const arts = ref<Record<number, { artDirectionPath: string; artFolder: string }>>({});

async function load() {
  try {
    await fetchAll();
    loadError.value = "";
    loaded.value = true;
  } catch (e) {
    loadError.value = (e as Error).message;
  }
}

async function fetchAll() {
  projects.value = await getJson("/api/projects");
  drafts.value = Object.fromEntries(projects.value.map((p) => [p.id, p.checks.join("\n")]));
  setupDrafts.value = Object.fromEntries(projects.value.map((p) => [p.id, p.setup.join("\n")]));
  limits.value = Object.fromEntries(projects.value.map((p) => [p.id, p.maxConcurrentRuns]));
  offeredPacks.value = (await getJson<{ offered: string[] }>("/api/skill-packs")).offered;
  packChoices.value = Object.fromEntries(projects.value.map((p) => [p.id, [...p.skillPacks]]));
  arts.value = Object.fromEntries(projects.value.map((p) => [p.id, { artDirectionPath: p.artDirectionPath, artFolder: p.artFolder }]));
}

async function savePacks(p: Project) {
  error.value = "";
  try {
    const saved = await putJson<Project>(`/api/projects/${p.id}/skill-packs`, { packs: packChoices.value[p.id] });
    p.skillPacks = saved.skillPacks;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function saveArt(p: Project) {
  error.value = "";
  try {
    const saved = await putJson<Project>(`/api/projects/${p.id}/art`, arts.value[p.id]);
    p.artDirectionPath = saved.artDirectionPath;
    p.artFolder = saved.artFolder;
    arts.value[p.id] = { artDirectionPath: saved.artDirectionPath, artFolder: saved.artFolder };
  } catch (e: any) {
    error.value = e.message;
  }
}

async function saveLimit(p: Project) {
  error.value = "";
  try {
    const saved = await putJson<Project>(`/api/projects/${p.id}/concurrency`, { max: Number(limits.value[p.id]) });
    p.maxConcurrentRuns = saved.maxConcurrentRuns;
    limits.value[p.id] = saved.maxConcurrentRuns;
  } catch (e: any) {
    error.value = e.message;
  }
}

async function saveSetup(p: Project) {
  error.value = "";
  try {
    const saved = await putJson<Project>(`/api/projects/${p.id}/setup`, { setup: setupDrafts.value[p.id]!.split("\n") });
    p.setup = saved.setup;
    setupDrafts.value[p.id] = saved.setup.join("\n");
  } catch (e: any) {
    error.value = e.message;
  }
}

async function saveChecks(p: Project) {
  error.value = "";
  try {
    const saved = await putJson<Project>(`/api/projects/${p.id}/checks`, { checks: drafts.value[p.id]!.split("\n") });
    p.checks = saved.checks;
    drafts.value[p.id] = saved.checks.join("\n");
  } catch (e: any) {
    error.value = e.message;
  }
}

async function register() {
  error.value = "";
  try {
    await postJson("/api/projects", { path: path.value });
    path.value = "";
    await load();
  } catch (e: any) {
    error.value = e.message;
  }
}

onMounted(async () => {
  await load();
  await nextTick();
  if (props.id !== undefined) document.getElementById(`project-${props.id}`)?.scrollIntoView();
});
</script>

<template>
  <h2>Projects</h2>
  <form @submit.prevent="register">
    <input v-model="path" placeholder="/path/to/local/git/repository" aria-label="Repository path" />
    <button type="submit">Register</button>
  </form>
  <p v-if="error" class="error">{{ error }}</p>

  <ErrorState v-if="loadError" title="Could not load the Projects" text="The Forgequor server did not answer. Check that it is running, then retry." :details="loadError" @retry="load" />
  <LoadingState v-else-if="!loaded" what="Projects" />
  <EmptyState v-else-if="!projects.length" title="No Project yet" text="Forgequor works on a git repository. Register your first Project with its local path above to start a Run." />
  <ul>
    <li v-for="p in projects" :key="p.id" :id="`project-${p.id}`">
      <strong>{{ p.name }}</strong>
      <span class="muted"> {{ p.remoteOwner }}/{{ p.remoteName }} · {{ p.defaultBranch }}</span>
      <div class="muted">{{ p.localPath }}</div>
      <form class="stack" @submit.prevent="saveSetup(p)">
        <textarea
          v-model="setupDrafts[p.id]"
          rows="2"
          placeholder="Setup: one shell command per line, run in a new worktree before the Developer (e.g. npm ci)"
          :aria-label="`Setup of ${p.name}`"
        />
        <button type="submit">Save Setup</button>
      </form>
      <form class="stack" @submit.prevent="saveChecks(p)">
        <textarea
          v-model="drafts[p.id]"
          rows="3"
          placeholder="Checks: one shell command per line, run in order after the Developer (e.g. npm test)"
          :aria-label="`Checks of ${p.name}`"
        />
        <button type="submit">Save Checks</button>
      </form>
      <form class="stack" @submit.prevent="saveArt(p)">
        <label>
          Art Direction document
          <input v-model="arts[p.id]!.artDirectionPath" placeholder="docs/ART_DIRECTION.md" :aria-label="`Art Direction path of ${p.name}`" />
        </label>
        <label>
          Art folder
          <input v-model="arts[p.id]!.artFolder" placeholder="assets/art" :aria-label="`Art folder of ${p.name}`" />
        </label>
        <button type="submit">Save art settings</button>
      </form>
      <form v-if="offeredPacks.length" class="stack" @submit.prevent="savePacks(p)">
        <span>Skill Packs (on top of shared)</span>
        <label v-for="pack in offeredPacks" :key="pack">
          <input v-model="packChoices[p.id]" type="checkbox" :value="pack" :aria-label="`${pack} Skill Pack of ${p.name}`" />
          {{ pack }}
        </label>
        <button type="submit">Save Skill Packs</button>
      </form>
      <form @submit.prevent="saveLimit(p)">
        <label>
          Max concurrent Runs
          <input v-model.number="limits[p.id]" type="number" min="1" step="1" :aria-label="`Max concurrent Runs of ${p.name}`" />
        </label>
        <button type="submit">Save limit</button>
      </form>
    </li>
  </ul>
</template>
