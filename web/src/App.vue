<script setup lang="ts">
import { onMounted, ref } from "vue";

interface Project {
  id: number;
  name: string;
  localPath: string;
  remoteOwner: string;
  remoteName: string;
  defaultBranch: string;
}
interface Tool {
  tool: string;
  status: string;
  detail: string;
}

const projects = ref<Project[]>([]);
const tools = ref<Tool[]>([]);
const path = ref("");
const error = ref("");

async function load() {
  projects.value = await (await fetch("/api/projects")).json();
  tools.value = (await (await fetch("/api/health")).json()).tools;
}

async function register() {
  error.value = "";
  const res = await fetch("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: path.value }),
  });
  if (!res.ok) {
    error.value = (await res.json()).error;
    return;
  }
  path.value = "";
  await load();
}

onMounted(load);
</script>

<template>
  <main>
    <h1>FORGE<span>QUOR</span></h1>
    <div v-for="t in tools.filter((t) => t.status !== 'ok')" :key="t.tool" class="warn">
      {{ t.tool }}: {{ t.detail }}
    </div>

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
  </main>
</template>
