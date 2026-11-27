<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { getJson, type Project, type WorkflowList } from "../api";

/** Read-only: every Workflow a Project offers, valid or not, with its Steps, YAML and errors. */
const projects = ref<Project[]>([]);
const projectId = ref("");
const list = ref<WorkflowList>({ workflows: [], problem: null });
const loading = ref(false);
const error = ref("");

onMounted(async () => {
  try {
    projects.value = await getJson<Project[]>("/api/projects");
    projectId.value = projects.value[0] ? String(projects.value[0].id) : "";
  } catch (e: any) {
    error.value = e.message;
  }
});

watch(projectId, async (id) => {
  list.value = { workflows: [], problem: null };
  error.value = "";
  if (!id) return;
  loading.value = true;
  try {
    const fetched = await getJson<WorkflowList>(`/api/projects/${id}/workflows`);
    if (projectId.value === id) list.value = fetched;
  } catch (e: any) {
    if (projectId.value === id) error.value = e.message;
  } finally {
    if (projectId.value === id) loading.value = false;
  }
});

const place = (e: { line?: number; path: string }) => (e.line ? `line ${e.line}: ` : e.path ? `${e.path}: ` : "");
</script>

<template>
  <h2>Workflows</h2>
  <p v-if="error" class="error">{{ error }}</p>
  <p v-if="!projects.length && !error" class="muted">Register a Project first.</p>
  <select v-else v-model="projectId" aria-label="Project">
    <option v-for="p in projects" :key="p.id" :value="String(p.id)">{{ p.name }} ({{ p.localPath }})</option>
  </select>
  <p v-if="loading" class="muted" role="status">Loading Workflows…</p>
  <p v-if="list.problem" class="error">{{ list.problem }}</p>
  <section v-for="w in list.workflows" :key="w.name" class="card">
    <h3>
      {{ w.name }}
      <span class="muted">({{ w.origin === "project" ? "Project" : "built-in" }}{{ w.overrides ? ", replaces the built-in one" : "" }}{{ w.file ? `, ${w.file}` : "" }})</span>
      <span v-if="w.errors.length" class="error"> - invalid, not offered at launch</span>
    </h3>
    <p v-if="w.description" class="muted">{{ w.description }}</p>
    <div v-if="w.errors.length" class="error" role="alert">
      <ul>
        <li v-for="(e, i) in w.errors" :key="i">{{ place(e) }}{{ e.message }}</li>
      </ul>
    </div>
    <table v-if="w.steps.length">
      <thead>
        <tr><th>Step</th><th>Type</th><th>Agent</th><th>Needs</th><th>When</th></tr>
      </thead>
      <tbody>
        <tr v-for="s in w.steps" :key="s.id">
          <td>{{ s.id }}</td>
          <td>{{ s.type }}</td>
          <td>{{ s.agent ?? "" }}</td>
          <td>{{ s.needs.join(", ") }}</td>
          <td>{{ s.when ?? "" }}</td>
        </tr>
      </tbody>
    </table>
    <details>
      <summary>YAML</summary>
      <pre>{{ w.yaml }}</pre>
    </details>
  </section>
</template>
