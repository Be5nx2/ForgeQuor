<script setup lang="ts">
import { onMounted, ref } from "vue";
import { getJson, postJson, putJson, type Project } from "../api";

const projects = ref<Project[]>([]);
const path = ref("");
const error = ref("");
/** Check commands being edited, one per line, by Project id. */
const drafts = ref<Record<number, string>>({});

async function load() {
  projects.value = await getJson("/api/projects");
  drafts.value = Object.fromEntries(projects.value.map((p) => [p.id, p.checks.join("\n")]));
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
      <form class="stack" @submit.prevent="saveChecks(p)">
        <textarea
          v-model="drafts[p.id]"
          rows="3"
          placeholder="Checks: one shell command per line, run in order after the Developer (e.g. npm test)"
          :aria-label="`Checks of ${p.name}`"
        />
        <button type="submit">Save Checks</button>
      </form>
    </li>
  </ul>
</template>
