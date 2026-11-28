import { createRouter, createWebHistory } from "vue-router";
import { screens } from "./navigation";
import InboxView from "./views/InboxView.vue";
import NewRunView from "./views/NewRunView.vue";
import NotFoundView from "./views/NotFoundView.vue";
import ProjectsView from "./views/ProjectsView.vue";
import RunDetailView from "./views/RunDetailView.vue";
import RunsView from "./views/RunsView.vue";
import TeamView from "./views/TeamView.vue";
import WorkflowsView from "./views/WorkflowsView.vue";

const views = {
  new: NewRunView,
  runs: RunsView,
  run: RunDetailView,
  projects: ProjectsView,
  project: ProjectsView,
  workflows: WorkflowsView,
  team: TeamView,
  inbox: InboxView,
};

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    // The Runs home is the landing page: what waits for the human is pinned at its top.
    { path: "/", redirect: "/runs" },
    ...screens.map((s) => ({
      name: s.name,
      path: s.path,
      component: views[s.name],
      // The :id param reaches the view as a number.
      props: s.path.includes(":id") ? (r: { params: Record<string, string | string[]> }) => ({ id: Number(r.params.id) }) : undefined,
    })),
    { name: "not-found", path: "/:rest(.*)*", component: NotFoundView },
  ],
});
