<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { deleteJson, getJson, postJson, putJson, type Project } from "../api";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import LoadingState from "../components/LoadingState.vue";
import { interruptedBanner, purgeAllOffer, purgedMessage, purgeProjectOffer, removalOffer, type RemovalPreviewLike } from "../projectDanger";
import { changedSections, commandsOf, draftOf, projectSubtitle, selectProject, type Draft, type Section } from "../projectsForm";

/** The Project the URL names (/projects/:id); without one, the first Project is shown. */
const props = defineProps<{ id?: number }>();

const projects = ref<Project[]>([]);
const path = ref("");
const registering = ref(false);
const error = ref("");
/** Why the list could not load (a failed save stays in `error`, above the list). */
const loadError = ref("");
/** False until the first list arrives, so an empty page never reads as "No Project" while it is loading. */
const loaded = ref(false);
const saving = ref(false);
const offeredPacks = ref<string[]>([]);
/** What is being edited, by Project id. */
const drafts = ref<Record<number, Draft>>({});

/** Which purge awaits its confirmation, and the result of the last one. */
const confirmingPurge = ref<"all" | "project" | null>(null);
const purging = ref(false);
const notice = ref("");

const selected = computed(() => selectProject(projects.value, props.id));
const draft = computed(() => (selected.value ? drafts.value[selected.value.id] : undefined));
const dirty = computed(() => (selected.value && draft.value ? changedSections(selected.value, draft.value).length > 0 : false));

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
  offeredPacks.value = (await getJson<{ offered: string[] }>("/api/skill-packs")).offered;
  drafts.value = Object.fromEntries(projects.value.map((p) => [p.id, draftOf(p)]));
}

/** One save per section, each its own API call; the draft then shows what the server kept. */
const savers: Record<Section, (p: Project, d: Draft) => Promise<void>> = {
  async checks(p, d) {
    const saved = await putJson<Project>(`/api/projects/${p.id}/checks`, { checks: commandsOf(d.checks) });
    p.checks = saved.checks;
    d.checks = [...saved.checks];
  },
  async setup(p, d) {
    const saved = await putJson<Project>(`/api/projects/${p.id}/setup`, { setup: commandsOf(d.setup) });
    p.setup = saved.setup;
    d.setup = [...saved.setup];
  },
  async concurrency(p, d) {
    const saved = await putJson<Project>(`/api/projects/${p.id}/concurrency`, { max: Number(d.maxConcurrentRuns) });
    p.maxConcurrentRuns = saved.maxConcurrentRuns;
    d.maxConcurrentRuns = saved.maxConcurrentRuns;
  },
  async art(p, d) {
    const saved = await putJson<Project>(`/api/projects/${p.id}/art`, { artDirectionPath: d.artDirectionPath, artFolder: d.artFolder });
    p.artDirectionPath = saved.artDirectionPath;
    p.artFolder = saved.artFolder;
    d.artDirectionPath = saved.artDirectionPath;
    d.artFolder = saved.artFolder;
  },
  async skillPacks(p, d) {
    const saved = await putJson<Project>(`/api/projects/${p.id}/skill-packs`, { packs: d.skillPacks });
    p.skillPacks = saved.skillPacks;
    d.skillPacks = [...saved.skillPacks];
  },
};

/** Saves every edited section in turn; stops at the first one the server refuses, keeping the rest of the draft. */
async function save() {
  const p = selected.value;
  const d = draft.value;
  if (!p || !d) return;
  error.value = "";
  saving.value = true;
  try {
    for (const section of changedSections(p, d)) await savers[section](p, d);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}

function discard() {
  const p = selected.value;
  if (p) drafts.value[p.id] = draftOf(p);
  error.value = "";
}

async function register() {
  error.value = "";
  try {
    await postJson("/api/projects", { path: path.value });
    path.value = "";
    registering.value = false;
    await load();
  } catch (e: any) {
    error.value = e.message;
  }
}

const allOffer = computed(() => purgeAllOffer(projects.value));
const projectOffer = computed(() => (selected.value ? purgeProjectOffer(selected.value) : null));

/** Purges now (every Project, or the selected one), then refreshes only the Archived counts so unsaved edits stay. */
async function purgeNow(scope: "all" | "project") {
  error.value = "";
  notice.value = "";
  purging.value = true;
  try {
    const body = scope === "project" && selected.value ? { projectId: selected.value.id } : {};
    const { deleted } = await postJson<{ deleted: number }>("/api/archived-runs/purge", body);
    notice.value = purgedMessage(deleted);
    confirmingPurge.value = null;
    const fresh = await getJson<Project[]>("/api/projects");
    for (const p of projects.value) p.archivedRuns = fresh.find((f) => f.id === p.id)?.archivedRuns ?? 0;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    purging.value = false;
  }
}

function askPurge(scope: "all" | "project") {
  notice.value = "";
  confirmingPurge.value = confirmingPurge.value === scope ? null : scope;
}

const router = useRouter();
const interrupted = computed(() => (selected.value ? interruptedBanner(selected.value) : null));
/** The removal confirmation: the preview the server gave when it opened, the name typed so far, and whether the removal is under way. */
const removal = ref<{ projectId: number; preview: RemovalPreviewLike; typed: string } | null>(null);
const removing = ref(false);
const removalError = ref("");
const removalView = computed(() => {
  const r = removal.value;
  const p = selected.value;
  return r && p && r.projectId === p.id ? { offer: removalOffer(p, r.preview, r.typed), preview: r.preview } : null;
});

async function askRemoval() {
  const p = selected.value;
  if (!p) return;
  if (removal.value?.projectId === p.id) {
    removal.value = null;
    return;
  }
  removalError.value = "";
  notice.value = "";
  try {
    removal.value = { projectId: p.id, preview: await getJson<RemovalPreviewLike>(`/api/projects/${p.id}/removal`), typed: "" };
  } catch (e: any) {
    removalError.value = e.message;
  }
}

/** Retry of an interrupted removal: the same operation, no name to type again. */
async function retryRemoval() {
  const p = selected.value;
  if (p) await removeProject(p);
}

async function confirmRemoval() {
  const p = selected.value;
  if (p && removalView.value?.offer.canRemove) await removeProject(p);
}

async function removeProject(p: Project) {
  removalError.value = "";
  removing.value = true;
  try {
    await deleteJson(`/api/projects/${p.id}`);
    removal.value = null;
    projects.value = projects.value.filter((x) => x.id !== p.id);
    window.dispatchEvent(new Event("projects-changed"));
    notice.value = `${p.name} removed.`;
    await router.push("/projects");
  } catch (e: any) {
    removalError.value = e.message;
    // The failed removal left its mark: show the banner without touching what is being edited.
    try {
      const fresh = await getJson<Project[]>("/api/projects");
      for (const x of projects.value) x.removingSince = fresh.find((f) => f.id === x.id)?.removingSince ?? null;
    } catch {
      /* the error above stays */
    }
  } finally {
    removing.value = false;
  }
}

function addRow(rows: string[]) {
  rows.push("");
}

function removeRow(rows: string[], i: number) {
  rows.splice(i, 1);
}

onMounted(load);
</script>

<template>
  <div class="head">
    <div>
      <h1>Projects</h1>
      <p class="lede">Git repositories Forgequor works on</p>
    </div>
    <div class="head-actions">
      <button class="btn" type="button" :disabled="allOffer.disabled || purging" :aria-expanded="confirmingPurge === 'all'" @click="askPurge('all')">{{ allOffer.disabled ? allOffer.label : "Purge Archived Runs" }}</button>
      <button class="btn btn-primary" type="button" :aria-expanded="registering" @click="registering = !registering">+ Register Project</button>
    </div>
  </div>

  <div v-if="confirmingPurge === 'all' && !allOffer.disabled" class="panel confirm" role="alertdialog" aria-label="Confirm purging every Archived Run">
    <p>{{ allOffer.question }}</p>
    <div class="actions"><button class="btn btn-ghost" type="button" :disabled="purging" @click="confirmingPurge = null">Cancel</button><button class="btn btn-danger-solid" type="button" :disabled="purging" @click="purgeNow('all')">Delete</button></div>
  </div>

  <form v-if="registering" class="panel register" @submit.prevent="register">
    <div class="field">
      <label for="register-path">Repository</label>
      <input id="register-path" v-model="path" type="text" placeholder="/path/to/local/git/repository" aria-label="Repository path" />
      <span class="hint">The local path of a git repository.</span>
    </div>
    <div class="actions"><button class="btn btn-ghost" type="button" @click="registering = false">Cancel</button><button class="btn btn-primary" type="submit">Register</button></div>
  </form>
  <p v-if="error" class="error" role="alert">{{ error }}</p>
  <p v-if="notice" class="notice" role="status">{{ notice }}</p>

  <ErrorState v-if="loadError" title="Could not load the Projects" text="The Forgequor server did not answer. Check that it is running, then retry." :details="loadError" @retry="load" />
  <LoadingState v-else-if="!loaded" what="Projects" />
  <EmptyState v-else-if="!projects.length" title="No Project yet" text="Forgequor works on a git repository. Register your first Project with its local path above to start a Run." />
  <div v-else class="split2">
    <div class="plist" role="list">
      <router-link v-for="p in projects" :key="p.id" :id="`project-${p.id}`" :to="`/projects/${p.id}`" class="p" role="listitem" :aria-current="selected?.id === p.id ? 'true' : undefined">
        <strong>{{ p.name }}</strong>
        <small>{{ projectSubtitle(p) }}</small>
      </router-link>
    </div>

    <form v-if="selected && draft" class="panel" @submit.prevent="save">
      <div class="field">
        <label :for="`path-${selected.id}`">Repository</label>
        <input :id="`path-${selected.id}`" type="text" :value="selected.localPath" readonly />
        <span class="hint">{{ selected.remoteOwner }}/{{ selected.remoteName }} · default branch <code>{{ selected.defaultBranch }}</code></span>
      </div>

      <div class="field">
        <span class="label">Checks <span class="muted note">a Run cannot reach its final Gate while one fails</span></span>
        <div v-for="(_, i) in draft.checks" :key="i" class="cmdrow">
          <input v-model="draft.checks[i]" type="text" class="mono" :aria-label="`Check ${i + 1} of ${selected.name}`" placeholder="npm test" />
          <button class="btn btn-ghost" type="button" @click="removeRow(draft.checks, i)">Remove</button>
        </div>
        <div><button class="btn" type="button" @click="addRow(draft.checks)">+ Add Check</button></div>
      </div>

      <div class="field">
        <span class="label">Setup <span class="muted note">prepares each new worktree, before the Developer</span></span>
        <div v-for="(_, i) in draft.setup" :key="i" class="cmdrow">
          <input v-model="draft.setup[i]" type="text" class="mono" :aria-label="`Setup command ${i + 1} of ${selected.name}`" placeholder="npm ci" />
          <button class="btn btn-ghost" type="button" @click="removeRow(draft.setup, i)">Remove</button>
        </div>
        <div><button class="btn" type="button" @click="addRow(draft.setup)">+ Add Setup command</button></div>
      </div>

      <div class="field narrow">
        <label :for="`slots-${selected.id}`">Max concurrent Runs</label>
        <input :id="`slots-${selected.id}`" v-model.number="draft.maxConcurrentRuns" type="number" min="1" step="1" :aria-label="`Max concurrent Runs of ${selected.name}`" />
      </div>

      <div class="field">
        <label :for="`art-${selected.id}`">Art Direction</label>
        <input :id="`art-${selected.id}`" v-model="draft.artDirectionPath" type="text" class="mono" placeholder="docs/ART_DIRECTION.md" :aria-label="`Art Direction path of ${selected.name}`" />
        <span class="hint">Palette, resolution, sprite sizes, read by the Artist.</span>
      </div>
      <div class="field">
        <label :for="`folder-${selected.id}`">Art folder</label>
        <input :id="`folder-${selected.id}`" v-model="draft.artFolder" type="text" class="mono" placeholder="assets/art" :aria-label="`Art folder of ${selected.name}`" />
      </div>

      <div v-if="offeredPacks.length" class="field">
        <span class="label">Skill Packs <span class="muted note">on top of shared</span></span>
        <div class="packs">
          <label v-for="pack in offeredPacks" :key="pack" class="pack">
            <input v-model="draft.skillPacks" type="checkbox" :value="pack" :aria-label="`${pack} Skill Pack of ${selected.name}`" />
            {{ pack }}
          </label>
        </div>
      </div>

      <div class="actions">
        <button class="btn btn-ghost" type="button" :disabled="!dirty || saving" @click="discard">Discard</button>
        <button class="btn btn-primary" type="submit" :disabled="!dirty || saving">Save</button>
      </div>

      <section v-if="interrupted" class="interrupted" role="alert" aria-label="Removal interrupted">
        <div>
          <strong>{{ interrupted.title }}</strong>
          <span>{{ interrupted.text }}</span>
          <span v-if="removalError" class="error">{{ removalError }}</span>
        </div>
        <button class="btn btn-danger-solid" type="button" :disabled="removing" @click="retryRemoval">{{ removing ? "Retrying…" : interrupted.retry }}</button>
      </section>

      <section v-if="projectOffer" class="danger" aria-label="Danger zone">
        <h2>Danger zone</h2>
        <div class="danger-row">
          <div>
            <strong>Purge its Archived Runs now</strong>
            <span class="hint">Deletes this Project's Archived Runs at once, without waiting for the delay. Active and finished Runs are never touched.</span>
          </div>
          <button class="btn btn-danger-outline" type="button" :disabled="projectOffer.disabled || purging" :aria-expanded="confirmingPurge === 'project'" @click="askPurge('project')">{{ projectOffer.disabled ? projectOffer.label : "Purge its Archived Runs now" }}</button>
        </div>
        <div v-if="confirmingPurge === 'project' && !projectOffer.disabled" class="danger-confirm" role="alertdialog" aria-label="Confirm purging this Project's Archived Runs">
          <p>{{ projectOffer.question }}</p>
          <div class="actions"><button class="btn btn-ghost" type="button" :disabled="purging" @click="confirmingPurge = null">Cancel</button><button class="btn btn-danger-solid" type="button" :disabled="purging" @click="purgeNow('project')">Delete</button></div>
        </div>
        <div class="danger-row">
          <div>
            <strong>Remove this Project</strong>
            <span class="hint">Forgequor forgets {{ selected.name }} and every Run it had. Its repository, on disk and on GitHub, stays as it is.</span>
          </div>
          <button class="btn btn-danger-outline" type="button" :disabled="removing" :aria-expanded="!!removalView" @click="askRemoval">Remove this Project</button>
        </div>
        <div v-if="removalView" class="danger-confirm" role="alertdialog" aria-label="Confirm removing this Project">
          <p>{{ removalView.offer.runsText }}</p>
          <template v-if="removalView.offer.abandons.length">
            <p>Its active Runs are abandoned first, exactly as the Abandon button does:</p>
            <ul class="blocked">
              <li v-for="line in removalView.offer.abandons" :key="line">{{ line }}</li>
            </ul>
          </template>
          <label class="field">
            <span>Type <strong>{{ selected.name }}</strong> to confirm</span>
            <input v-model="removal!.typed" type="text" autocomplete="off" spellcheck="false" :disabled="removing" />
          </label>
          <div class="actions"><button class="btn btn-ghost" type="button" :disabled="removing" @click="removal = null">Cancel</button><button class="btn btn-danger-solid" type="button" :disabled="!removalView.offer.canRemove || removing" @click="confirmRemoval">Remove</button></div>
        </div>
        <p v-if="removalError" class="error" role="alert">{{ removalError }}</p>
      </section>
    </form>
    <EmptyState v-else title="Project not found" text="No Project has this address. Pick one from the list." />
  </div>
</template>

<style scoped>
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-4); flex-wrap: wrap; margin-bottom: var(--sp-5); }
h1 { font: 700 var(--fs-xl)/1.2 var(--font-brand); letter-spacing: 0.03em; }
.lede { color: var(--text-muted); font-size: var(--fs-sm); margin: var(--sp-1) 0 0; }
.head-actions { display: flex; gap: var(--sp-3); flex-wrap: wrap; }
.error { margin: 0 0 var(--sp-4); }
.notice { margin: 0 0 var(--sp-4); color: var(--st-ok); font-size: var(--fs-sm); }
.confirm { margin-bottom: var(--sp-5); max-width: 40rem; gap: var(--sp-3); }
.confirm p { margin: 0; font-size: var(--fs-sm); }

.danger { border: 1px solid var(--st-bad); border-radius: var(--radius-md); padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); }
.danger h2 { margin: 0; font: 700 var(--fs-sm)/1.2 var(--font-ui); color: var(--st-bad); text-transform: uppercase; letter-spacing: 0.06em; }
.danger-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); flex-wrap: wrap; }
.danger-row > div { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); max-width: 32rem; }
.danger-confirm { display: flex; flex-direction: column; gap: var(--sp-3); }
.danger-confirm p { margin: 0; font-size: var(--fs-sm); }
.interrupted { border: 1px solid var(--st-bad); background: color-mix(in srgb, var(--st-bad) 12%, transparent); border-radius: var(--radius-md); padding: var(--sp-4); display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); flex-wrap: wrap; }
.interrupted > div { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); max-width: 40rem; }
.interrupted strong { color: var(--st-bad); }
.blocked { margin: 0; padding-left: var(--sp-4); font-size: var(--fs-sm); }
.field { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); }
.btn-danger-outline { color: var(--st-bad); border-color: var(--st-bad); }
.btn-danger-solid { background: var(--st-bad); border-color: var(--st-bad); color: #1a0508; }

.split2 { display: grid; grid-template-columns: 17rem 1fr; gap: var(--sp-5); align-items: start; }
.plist { display: grid; gap: var(--sp-2); }
.plist .p { display: block; padding: 0.7rem 0.9rem; border: 1px solid var(--border); border-radius: var(--radius-md); font-size: var(--fs-sm); background: rgb(8 15 25 / 0.5); color: var(--text); text-decoration: none; }
.plist .p[aria-current="true"] { border-color: var(--ai); box-shadow: 0 0 14px rgb(56 189 248 / 0.18); }
.plist .p small { display: block; color: var(--text-muted); font-size: var(--fs-xs); overflow-wrap: anywhere; }

.panel { background: linear-gradient(180deg, rgb(23 40 61 / 0.85), rgb(16 29 45 / 0.85)); border: 1px solid var(--border-strong); border-radius: var(--radius-lg); padding: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-5); margin: 0; box-shadow: 0 0 0 1px rgb(56 189 248 / 0.06), 0 12px 40px rgb(0 0 0 / 0.35); }
.register { margin-bottom: var(--sp-5); max-width: 40rem; }

.field { display: flex; flex-direction: column; gap: var(--sp-2); }
.field.narrow { max-width: 16rem; }
.field > label, .label { font-size: var(--fs-sm); font-weight: 600; }
.note { font-weight: 400; }
.hint { font-size: var(--fs-xs); color: var(--text-muted); }
.field input[type="text"], .field input[type="number"] { flex: none; width: 100%; box-sizing: border-box; background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius-md); padding: 0.65rem 0.75rem; font: var(--fs-sm) var(--font-ui); }
.field input.mono { font-family: var(--font-mono); }
.field input[readonly] { color: var(--text-muted); }
.cmdrow { display: grid; grid-template-columns: 1fr auto; gap: var(--sp-2); align-items: center; }
.packs { display: flex; gap: var(--sp-4); flex-wrap: wrap; }
.pack { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); }
.pack input { flex: none; width: auto; }
.actions { display: flex; gap: var(--sp-3); justify-content: flex-end; }
.btn:disabled { opacity: 0.5; cursor: default; }
</style>
