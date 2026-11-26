# Changelog

All notable changes to Forgequor. Format: [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Added
- Skills (shared / forgequor / godot), CLAUDE.md, brand identity doc, ROADMAP and CHANGELOG.
- Glossary, ADRs 0001–0003 and the v1 milestones (M1–M4) in the roadmap.
- Scaffold (Node/TypeScript, Fastify, Vue 3, PostgreSQL via Docker Compose, `npm start`), startup checks for `git`, `gh` and `claude`, and Project registration with a Projects list in the UI (m1-01).
- Claude Runner adapter behind the Runner seam: headless `claude` per Step, progress events, success, failure or Quota exhaustion with reset time, contract tests on a fake `claude`, opt-in smoke test (m1-02).
