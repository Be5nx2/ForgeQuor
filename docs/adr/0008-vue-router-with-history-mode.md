# The front uses vue-router in history mode, one URL per screen

The front end routes with `vue-router` 4 in history mode: every screen (Waiting for you, New Run, Runs, a Run, Projects, a Project, Workflows, Team, Inbox) has its own path, so a screen can be shared, refreshed and walked with Back and Forward. The Fastify server answers any `GET` page request that matches no file and is not under `/api/` with `index.html`; a missing file such as an asset stays a 404.

We chose this over the hand-rolled `tab` state because the human shares and refreshes screens, and an open **Gate** must be reachable through its **Run**'s URL. `vue-router` is the standard router for Vue 3 and brings no server-side code.

## Considered Options

- **`vue-router` 4, history mode (chosen).** Clean URLs; needs the server fallback above.
- **`vue-router` 4, hash mode.** No server change, but `/#/runs/3` URLs are ugly and the server then cannot tell a client route from a mistake.
- **`vue-router` 5.** Needs Vite 7 or later; the project is on Vite 6, so we stay on 4.x until Vite is upgraded.
- **A small home-made router over `location` and `popstate`.** Fewer dependencies, but we would rewrite route params, guards and links that `vue-router` already tests.

## Consequences

- The route table lives in one plain module (`web/src/navigation.ts`), which maps a route to its tab, Run and note target and is unit-tested without Vue.
- A new screen is one entry in that table plus its view. An unknown URL shows a not-found screen in the app; an unknown Run shows the API's not-found message.
