<script setup lang="ts">
import { onMounted, ref } from "vue";
import { getJson, postJson, type Project } from "../api";

const projects = ref<Project[]>([]);
const path = ref("");
const error = ref("");

async function load() {
  projects.value = await getJson("/api/projects");
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
    </li>
  </ul>
</template>
