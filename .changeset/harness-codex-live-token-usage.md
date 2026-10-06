---
'@ai-sdk/harness-codex': patch
'@ai-sdk/harness': patch
---

fix(harness-codex): report real token usage while a turn runs, and include sub-agent threads. The bridge now forwards the running turn total as a `raw` part (`{ type: 'codex-token-usage', usage }`) on every change, so an aborted or failed turn no longer loses everything it consumed. `finish-step` now carries the tokens used since the previous step instead of zero, a final usage-only step is sent if usage arrived with no open step, and the open step is flushed before a fatal error. Usage from threads the turn started (announced through `collabAgentToolCall`, at any depth) is counted; other threads on the app-server connection are ignored. In `@ai-sdk/harness`, a stop condition ending the turn now reports the usage of all completed steps to telemetry instead of only the last step.
