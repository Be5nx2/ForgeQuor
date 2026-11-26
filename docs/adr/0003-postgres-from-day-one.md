# PostgreSQL from day one, behind Docker Compose

Forgequor's stack is Node.js with TypeScript for the orchestrator, Vue 3 for the UI, and PostgreSQL for **Run** history. PostgreSQL runs locally through Docker Compose (OrbStack on macOS).

Version 1 is single-user and local-first, so SQLite would avoid running a server. We still chose PostgreSQL. The planned next audience is a three-person studio sharing one instance, and migrating stores later costs more than one `docker compose up` today.

**Workflow** and **Agent** definitions are versioned files, not database rows. The database holds what happens: **Runs**, **Gates**, **Feedback**, **Quota** readings and settings.
