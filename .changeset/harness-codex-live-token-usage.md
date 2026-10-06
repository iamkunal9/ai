---
'@ai-sdk/harness-codex': patch
---

fix(harness-codex): report token usage as the turn runs instead of only at turn completion. `finish-step` now carries the tokens consumed since the previous step, so usage survives an aborted or failed turn, and usage from other threads on the app-server connection (e.g. sub-agents) is counted.
