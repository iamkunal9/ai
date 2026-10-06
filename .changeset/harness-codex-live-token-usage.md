---
'@ai-sdk/harness-codex': patch
'@ai-sdk/harness': patch
---

fix(harness-codex): account for token usage while a turn runs and include sub-agents. Usage is tracked per Codex thread: the active thread plus every thread it spawned (at any depth) is counted, other threads on the connection are ignored, and usage reported between turns or after an abort is held for the next turn. A thread's history is never billed, so usage is not over-counted. The running turn total is forwarded as a `raw` part (`{ type: 'codex-token-usage', scope: 'turn', cumulative: true, usage }`) so an aborted or failed turn keeps what it consumed. `finish-step` carries the usage since the previous step boundary instead of zero, the open step is flushed before a fatal error, and events an aborted turn still produces no longer reach the next turn. Reasoning tokens are reported.

fix(harness): `raw` parts no longer open or alter a step and are no longer swallowed by a stop condition, and a stop condition ending the turn reports the usage of all completed steps to telemetry instead of only the last step.
