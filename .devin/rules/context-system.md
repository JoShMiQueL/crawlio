---
description: How this project's context/rules system works
trigger: always_on
---

- `AGENTS.md` holds hard rules (auto-loaded — you already have them).
- `.devin/context/` holds on-demand detail; `.devin/rules/` holds trigger-scoped rules.
- The `contextscout` subagent routes to relevant `.devin/context/` files per task.
- If `.devin/context/` is missing or thin, the orchestrator bootstraps it once from the project's real stack before delegating.
