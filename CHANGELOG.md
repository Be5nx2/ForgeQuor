# Changelog

All notable changes to Forgequor. Format: [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Added
- Skills (shared / forgequor / godot), CLAUDE.md, brand identity doc, ROADMAP and CHANGELOG.
- Glossary, ADRs 0001–0003 and the v1 milestones (M1–M4) in the roadmap.
- Scaffold (Node/TypeScript, Fastify, Vue 3, PostgreSQL via Docker Compose, `npm start`), startup checks for `git`, `gh` and `claude`, and Project registration with a Projects list in the UI (m1-01).
- Claude Runner adapter behind the Runner seam: headless `claude` per Step, progress events, success, failure or Quota exhaustion with reset time, contract tests on a fake `claude`, opt-in smoke test (m1-02).
- Runs: start a Run from the UI, get its own worktree and branch from the freshly fetched default branch, let the Developer work through the Claude Runner, and wait at the final Gate, where the human approves or abandons it; Runs list, Run detail and "Waiting for you" screens (m1-03).
- Clean-ups from the first real Run: `.env` at the repo root is read, same-named Projects show their local path in the pickers, and headless Developer sessions cannot use tools that wait for a human (m1-10).
- Pull request and Review Brief: the Developer's branch is pushed (refused with an Escalation if a commit adds Run Notes), a ready pull request is opened through `gh` with the task and a Run reference, the Review Brief is posted as a comment, and the final Gate comes after it; the PR link shows in the Run detail. Opt-in `gh` smoke test (m1-04).
