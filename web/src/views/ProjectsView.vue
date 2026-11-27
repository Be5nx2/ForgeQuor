<script setup lang="ts">
import { onMounted, ref } from "vue";
import { getJson, postJson, putJson, type Project } from "../api";

const projects = ref<Project[]>([]);
const path = ref("");
const error = ref("");
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

onMounted(load);
</script>

<template>
  <h2>Projects</h2>
  <form @submit.prevent="register">
    <input v-model="path" placeholder="/path/to/local/git/repository" aria-label="Repository path" />
    <button type="submit">Register</button>
  </form>
  <p v-if="error" class="error">{{ error }}</p>

  <p v-if="!projects.length" class="muted">No Project registered yet.</p>
  <ul>
    <li v-for="p in projects" :key="p.id">
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
