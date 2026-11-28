<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { getJson, type Project, type WorkflowList } from "../api";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import LoadingState from "../components/LoadingState.vue";

/** Read-only: every Workflow a Project offers, valid or not, with its Steps, YAML and errors. */
const projects = ref<Project[]>([]);
const projectId = ref("");
const list = ref<WorkflowList>({ workflows: [], problem: null });
const loading = ref(false);
const error = ref("");

/** False until the Projects arrive, so the page never says "No Project yet" while loading or after a failure. */
const projectsLoaded = ref(false);
const projectsError = ref("");

async function loadProjects() {
  try {
    projects.value = await getJson<Project[]>("/api/projects");
    projectsError.value = "";
    projectsLoaded.value = true;
    if (!projects.value.some((p) => String(p.id) === projectId.value)) projectId.value = projects.value[0] ? String(projects.value[0].id) : "";
  } catch (e: any) {
    projectsError.value = e.message;
  }
}

async function loadWorkflows() {
  const id = projectId.value;
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
}

onMounted(loadProjects);
watch(projectId, loadWorkflows);

const place = (e: { line?: number; path: string }) => (e.line ? `line ${e.line}: ` : e.path ? `${e.path}: ` : "");
</script>

<template>
  <div class="head">
    <h1>Workflows</h1>
    <p class="lede">Every Workflow a Project offers, valid or not, with its Steps and YAML.</p>
  </div>
  <ErrorState v-if="projectsError" title="Could not load the Projects" text="The Forgequor server did not answer. Check that it is running, then retry." :details="projectsError" @retry="loadProjects" />
  <LoadingState v-else-if="!projectsLoaded" what="Projects" />
  <EmptyState v-else-if="!projects.length" title="No Project yet" text="Workflows belong to a Project. Register one to see the Workflows it offers.">
    <router-link class="btn btn-primary" to="/projects">Register a Project</router-link>
  </EmptyState>
  <template v-else>
    <div class="field">
      <label for="workflows-project">Project</label>
      <select id="workflows-project" v-model="projectId">
        <option v-for="p in projects" :key="p.id" :value="String(p.id)">{{ p.name }} ({{ p.localPath }})</option>
      </select>
    </div>
    <ErrorState v-if="error" title="Could not load the Workflows" text="The Forgequor server did not answer. Check that it is running, then retry." :details="error" @retry="loadWorkflows" />
    <LoadingState v-else-if="loading" what="Workflows" />
  </template>
  <p v-if="list.problem" class="banner" role="alert">{{ list.problem }}</p>
  <section v-for="w in list.workflows" :key="w.name" class="panel">
    <h3>
      {{ w.name }}
      <span class="muted origin">({{ w.origin === "project" ? "Project" : "built-in" }}{{ w.overrides ? ", replaces the built-in one" : "" }}{{ w.file ? `, ${w.file}` : "" }})</span>
      <span v-if="w.errors.length" class="chip" data-s="bad">invalid, not offered at launch</span>
    </h3>
    <p v-if="w.description" class="muted desc">{{ w.description }}</p>
    <div v-if="w.errors.length" class="problems" role="alert">
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
<style scoped>
.head { margin-bottom: var(--sp-5); }
h1 { font: 700 var(--fs-xl, 1.5rem) var(--font-brand); letter-spacing: 0.06em; }
.lede { color: var(--text-muted); font-size: var(--fs-sm); margin: var(--sp-1) 0 0; max-width: 46rem; }
.field { display: flex; flex-direction: column; gap: var(--sp-2); margin-bottom: var(--sp-5); max-width: 36rem; }
.field label { font-size: var(--fs-sm); font-weight: 600; }
select { width: 100%; padding: 0.65rem 0.75rem; background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius-md); font: var(--fs-sm) var(--font-ui); }
.banner { border: 1px solid var(--highlight); background: rgb(255 197 107 / 0.08); border-radius: var(--radius-md); padding: var(--sp-3) var(--sp-4); font-size: var(--fs-sm); color: var(--highlight); margin: 0 0 var(--sp-4); }
.panel { background: linear-gradient(180deg, rgb(23 40 61 / 0.85), rgb(16 29 45 / 0.85)); border: 1px solid var(--border-strong); border-radius: var(--radius-lg); box-shadow: 0 0 0 1px rgb(56 189 248 / 0.06), 0 12px 40px rgb(0 0 0 / 0.35); padding: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-3); margin-bottom: var(--sp-4); }
h3 { font-size: var(--fs-md); font-weight: 600; display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.origin { font-size: var(--fs-xs); font-weight: 400; }
.desc { margin: 0; font-size: var(--fs-sm); }
.problems { border: 1px solid var(--st-bad); border-radius: var(--radius-md); padding: var(--sp-3) var(--sp-4); color: var(--st-bad); font-size: var(--fs-sm); }
.problems ul { margin: 0; padding: 0; }
.problems li { background: none; padding: 0; margin: 0 0 var(--sp-1); border-radius: 0; }
table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
th { text-align: left; color: var(--text-muted); font-weight: 500; font-size: var(--fs-xs); padding: 0.5rem 0.7rem; border-bottom: 1px solid var(--border-strong); }
td { padding: 0.6rem 0.7rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
tbody tr:hover { background: rgb(56 189 248 / 0.05); }
details { font-size: var(--fs-sm); }
summary { cursor: pointer; color: var(--ice-blue); font-weight: 600; }
pre { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--sp-3); font: var(--fs-xs)/1.6 var(--font-mono); overflow-x: auto; }
</style>
