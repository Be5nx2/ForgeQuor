# Initial stack choices

The orchestrator is a single TypeScript package run with `tsx` on Node 22: Fastify for the HTTP layer, `pg` with plain versioned SQL migrations for the **Store**, Vitest for tests, and Vue 3 with Vite for the UI (in `web/`, built and served by the same process). A Forgequor start command is `npm start`.

We chose plain SQL migrations over an ORM so the schema stays readable and the Store stays a thin module. One package, not a monorepo, until a second deployable exists.

Forgequor's PostgreSQL listens on host port 5433 so it does not collide with a PostgreSQL already running on 5432.
