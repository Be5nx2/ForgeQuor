<script setup lang="ts">
import type { sidebarNav } from "../navigation";
import QuotaBar from "./QuotaBar.vue";

/** The layout every screen sits in: sidebar (logotype, New Run, Project selector, navigation, "+ Note") and the main area (Quota bars, warnings, then the screen). */
defineProps<{
  nav: typeof sidebarNav;
  /** The navigation entry to mark as the current page. */
  activeTab: string;
  /** New Dogfood Notes, shown as the Inbox badge. */
  newNotes: number;
  /** Gates waiting for the human, shown as the Runs badge. */
  openGates: number;
  /** Warnings about missing tools, shown above the screen. */
  warnings: string[];
}>();
</script>

<template>
  <div class="app">
    <aside>
      <router-link to="/" class="logo" aria-label="Forgequor, home">
        <span class="logo-mark" aria-hidden="true"></span>
        <span><span class="forge">FORGE</span><span class="quor">QUOR</span></span>
      </router-link>
      <router-link to="/new" class="btn btn-primary new-run">+ New Run</router-link>
      <!-- Placeholder until the Project selector (ui-06): it only shows the default scope. -->
      <button class="project" type="button" aria-disabled="true" aria-label="Project: All Projects" title="Choosing a Project comes soon"><span>All Projects</span><span class="muted" aria-hidden="true">⌄</span></button>
      <nav class="nav" aria-label="Main">
        <router-link v-for="t in nav" :key="t.name" :to="t.path" custom v-slot="{ href, navigate }">
          <a :href="href" :aria-current="activeTab === t.name ? 'page' : undefined" @click="navigate">
            {{ t.label }}
            <span v-if="t.name === 'runs' && openGates" class="count" :aria-label="`${openGates} waiting for you`">{{ openGates }}</span>
            <span v-if="t.name === 'inbox'&& newNotes" class="count" :aria-label="`${newNotes} new notes`">{{ newNotes }}</span>
          </a>
        </router-link>
      </nav>
      <div class="spacer"></div>
      <slot name="note" />
    </aside>
    <main>
      <QuotaBar />
      <div v-for="w in warnings" :key="w" class="banner" role="status">{{ w }}</div>
      <div class="content"><slot /></div>
    </main>
  </div>
</template>

<style>
/* Shell styles from the mockups' shell.css; unscoped because the sidebar elements are shared primitives of tokens.css. */
body { background:
    radial-gradient(900px 500px at 8% -10%, rgb(56 189 248 / 0.12), transparent 60%),
    radial-gradient(800px 480px at 100% 110%, rgb(255 140 36 / 0.14), transparent 60%),
    var(--bg); background-attachment: fixed; }
.app { display: grid; grid-template-columns: 232px 1fr; min-height: 100vh; }
.app aside { background: linear-gradient(180deg, rgb(16 29 45 / 0.9), rgb(8 15 25 / 0.9)); border-right: 1px solid var(--border); padding: var(--sp-5) var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-5); backdrop-filter: blur(6px); position: sticky; top: 0; height: 100vh; overflow-y: auto; }
.app .new-run { text-align: center; text-decoration: none; }
.app .project { width: 100%; background: rgb(8 15 25 / 0.7); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius-md); padding: 0.55rem 0.7rem; font: 500 var(--fs-sm) var(--font-ui); display: flex; justify-content: space-between; box-shadow: inset 0 0 0 1px rgb(56 189 248 / 0.08); cursor: default; }
.app .spacer { flex: 1; }
.btn-primary { box-shadow: 0 0 18px rgb(255 140 36 / 0.35); }
.nav a[aria-current="page"] { box-shadow: inset 2px 0 0 var(--ai); background: linear-gradient(90deg, rgb(56 189 248 / 0.14), transparent); }
.app main { padding: var(--sp-5) var(--sp-6); min-width: 0; display: flex; flex-direction: column; gap: var(--sp-4); overflow-wrap: anywhere; }
.app .content { max-width: 56rem; width: 100%; }
.banner { border: 1px solid var(--highlight); background: rgb(255 197 107 / 0.08); border-radius: var(--radius-md); padding: var(--sp-3) var(--sp-4); font-size: var(--fs-sm); color: var(--highlight); }
@media (max-width: 720px) {
  .app { grid-template-columns: 1fr; }
  .app aside { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--border); }
  .app main { padding: var(--sp-4); }
}
</style>
