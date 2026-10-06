---
'@ai-sdk/harness-codex': patch
'@ai-sdk/harness': patch
---

fix(harness-codex): report token usage as the turn runs instead of only at turn completion, and include sub-agent threads. `finish-step` now carries the tokens consumed since the previous step (it was always zero), so usage survives an aborted or failed turn; the open step is flushed before a fatal error is reported. Usage from threads spawned by the turn (announced via `collabAgentToolCall`, at any depth) is counted; other threads on the app-server connection are ignored.

fix(harness): when a stop condition ends the turn, telemetry `onEnd` now reports the usage of all completed steps instead of only the last step.
