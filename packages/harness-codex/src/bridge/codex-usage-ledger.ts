import type { CodexAppServerNotification } from './codex-app-server-client';

/*
 * Token accounting for a Codex session.
 *
 * Codex reports usage per thread through `thread/tokenUsage/updated`, as a
 * cumulative `total` plus the `last` model call. Sub-agents run as their own
 * threads: the parent's `total` excludes them, and they are announced only by
 * `collabAgentToolCall` items on the thread that started or addressed them.
 *
 * The ledger keeps two cumulative totals per thread: what the server has
 * `seen`, and what has been `billed` to a turn. A thread's increment is always
 * `seen - billed`, so a repeated snapshot adds nothing, a skipped snapshot is
 * recovered by the next one, and usage that arrives while no turn is attached
 * (between turns, or after an abort) is carried over to the next turn instead
 * of being lost.
 *
 * Only the session's own threads are billed: the active thread plus the threads
 * it spawned, at any depth. State lives as long as the app-server process.
 */

export type UsageBreakdown = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

type UsageSnapshot = { total: UsageBreakdown; last: UsageBreakdown };

/**
 * How the first snapshot of a billed thread is attributed:
 * - `new`: the thread was created by this session (a fresh thread or a spawned
 *   sub-agent), so everything it used is ours.
 * - `unknown`: the thread existed before we saw it (a resumed thread, or an
 *   existing sub-agent we are only now addressing). Its `total` includes
 *   history, so only the `last` model call is billed unless a baseline is known.
 */
type ThreadOrigin = 'new' | 'unknown';

type PendingSpawn = { receiverThreadId: string; origin: ThreadOrigin };

type ActiveTurn = {
  threadId: string;
  turnId: string | undefined;
  onChange: (turnUsage: UsageBreakdown) => void;
  onWarning: ((message: string) => void) | undefined;
};

// Bounds for threads on the connection that are not (yet) known to be ours.
const MAX_UNCLAIMED_THREADS = 256;
const MAX_PENDING_SPAWN_SENDERS = 256;
const MAX_PENDING_SPAWNS_PER_SENDER = 64;

export type CodexUsageLedger = {
  /**
   * Attach a turn. `resumed` says whether the active thread existed before this
   * turn. Usage carried over from while no turn was attached is billed now.
   */
  begin(input: {
    threadId: string;
    resumed: boolean;
    /** Called with the turn's running total whenever it grows. */
    onChange: (turnUsage: UsageBreakdown) => void;
    onWarning?: (message: string) => void;
  }): void;
  setTurnId(turnId: string): void;
  /** Detach the turn. Later usage is held and billed to the next turn. */
  end(): void;
  /** Feed any app-server notification; irrelevant ones are ignored. */
  handleNotification(notification: CodexAppServerNotification): void;
  /** Usage billed to the current turn so far. */
  turnUsage(): UsageBreakdown;
  /** Forget everything (the app-server process is gone). */
  reset(): void;
};

export function createCodexUsageLedger(): CodexUsageLedger {
  const family = new Map<string, ThreadOrigin>();
  const seen = new Map<string, UsageSnapshot>();
  const billed = new Map<string, UsageBreakdown>();
  const pendingSpawns = new Map<string, PendingSpawn[]>();
  let active: ActiveTurn | undefined;
  let turnTotal = emptyUsage();

  // Bill whatever a family thread has used since it was last billed.
  const settle = (threadId: string): void => {
    const origin = family.get(threadId);
    const snapshot = seen.get(threadId);
    if (active == null || origin == null || snapshot == null) return;

    const previous = billed.get(threadId);
    const increment =
      previous == null
        ? origin === 'new'
          ? snapshot.total
          : snapshot.last
        : isRegression(snapshot.total, previous)
          ? // A total that went down means the counter was reset (e.g. after a
            // compaction). Never over-bill: take only the last call.
            snapshot.last
          : difference(snapshot.total, previous);
    billed.set(threadId, snapshot.total);
    if (isEmpty(increment)) return;

    turnTotal = add(turnTotal, increment);
    active.onChange(turnTotal);
  };

  // Make a thread part of the session, replaying what we already know of it.
  const adopt = (threadId: string, origin: ThreadOrigin): void => {
    if (family.has(threadId)) return;
    family.set(threadId, origin);
    settle(threadId);
    const queued = pendingSpawns.get(threadId);
    if (queued == null) return;
    pendingSpawns.delete(threadId);
    for (const spawn of queued) adopt(spawn.receiverThreadId, spawn.origin);
  };

  const rememberSnapshot = (
    threadId: string,
    snapshot: UsageSnapshot,
  ): void => {
    // Re-insert so the oldest entry is always the least recently updated.
    seen.delete(threadId);
    seen.set(threadId, snapshot);
    if (seen.size <= MAX_UNCLAIMED_THREADS) return;
    for (const candidate of seen.keys()) {
      if (family.has(candidate)) continue;
      seen.delete(candidate);
      active?.onWarning?.(
        'Dropped token usage tracking for an unrelated Codex thread (too many threads on the connection).',
      );
      return;
    }
  };

  const observeUsage = (params: Record<string, unknown>): void => {
    const threadId = params.threadId;
    if (typeof threadId !== 'string') return;
    const tokenUsage = asRecord(params.tokenUsage);
    const total = readUsageBreakdown(tokenUsage?.total);
    const last = readUsageBreakdown(tokenUsage?.last);
    if (total == null || last == null) return;
    const snapshot: UsageSnapshot = { total, last };

    // On the active thread, usage that is not from this turn (Codex replays the
    // latest snapshot when a thread is resumed, before the turn starts) is a
    // baseline, not new usage. Before the turn id is known only a thread we
    // created can be reporting current usage.
    if (active?.threadId === threadId) {
      const isCurrent =
        active.turnId != null
          ? params.turnId === active.turnId
          : family.get(threadId) === 'new';
      if (!isCurrent) {
        if (!billed.has(threadId)) billed.set(threadId, total);
        return;
      }
    }

    rememberSnapshot(threadId, snapshot);
    settle(threadId);
  };

  const observeAnnouncement = (params: Record<string, unknown>): void => {
    const item = asRecord(params.item);
    if (item?.type !== 'collabAgentToolCall') return;
    // Trust where the notification came from, not who the item claims sent it.
    const sender = params.threadId;
    if (typeof sender !== 'string') return;
    // An announcement on the active thread must belong to the current turn.
    if (
      active?.threadId === sender &&
      active.turnId != null &&
      params.turnId !== active.turnId
    ) {
      return;
    }

    const receivers = readStringArray(item.receiverThreadIds);
    const origin: ThreadOrigin = item.tool === 'spawnAgent' ? 'new' : 'unknown';
    for (const receiverThreadId of receivers) {
      if (family.has(sender)) {
        adopt(receiverThreadId, origin);
      } else {
        // The sender is not ours yet; it may become ours (e.g. a grandchild
        // announced before its parent), so remember the announcement.
        const queued = pendingSpawns.get(sender) ?? [];
        if (queued.length < MAX_PENDING_SPAWNS_PER_SENDER) {
          queued.push({ receiverThreadId, origin });
        }
        pendingSpawns.set(sender, queued);
        if (pendingSpawns.size > MAX_PENDING_SPAWN_SENDERS) {
          const oldest = pendingSpawns.keys().next().value;
          if (oldest != null) pendingSpawns.delete(oldest);
        }
      }
    }
  };

  return {
    begin({ threadId, resumed, onChange, onWarning }) {
      active = { threadId, turnId: undefined, onChange, onWarning };
      turnTotal = emptyUsage();
      // Whatever a resumed thread had used before this turn is not ours.
      const preTurn = seen.get(threadId);
      if (resumed && preTurn != null && !billed.has(threadId)) {
        billed.set(threadId, preTurn.total);
      }
      adopt(threadId, resumed ? 'unknown' : 'new');
      // Bill usage that arrived while no turn was attached.
      for (const familyThreadId of family.keys()) settle(familyThreadId);
    },
    setTurnId(turnId) {
      if (active != null) active.turnId = turnId;
    },
    end() {
      active = undefined;
    },
    handleNotification(notification) {
      const params = asRecord(notification.params);
      if (params == null) return;
      if (notification.method === 'thread/tokenUsage/updated') {
        observeUsage(params);
      } else if (
        notification.method === 'item/started' ||
        notification.method === 'item/completed'
      ) {
        observeAnnouncement(params);
      }
    },
    turnUsage: () => turnTotal,
    reset() {
      family.clear();
      seen.clear();
      billed.clear();
      pendingSpawns.clear();
      active = undefined;
      turnTotal = emptyUsage();
    },
  };
}

export function emptyUsage(): UsageBreakdown {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

/** Snake-case shape carried on the bridge's `turn.completed` / `usage.updated`. */
export function toLegacyUsage(usage: UsageBreakdown): Record<string, number> {
  return {
    input_tokens: usage.inputTokens,
    cached_input_tokens: usage.cachedInputTokens,
    cache_write_input_tokens: usage.cacheWriteInputTokens,
    output_tokens: usage.outputTokens,
    reasoning_output_tokens: usage.reasoningOutputTokens,
  };
}

function readUsageBreakdown(value: unknown): UsageBreakdown | undefined {
  const usage = asRecord(value);
  if (usage == null) return undefined;
  return {
    inputTokens: numberOrZero(usage.inputTokens),
    cachedInputTokens: numberOrZero(usage.cachedInputTokens),
    cacheWriteInputTokens: numberOrZero(usage.cacheWriteInputTokens),
    outputTokens: numberOrZero(usage.outputTokens),
    reasoningOutputTokens: numberOrZero(usage.reasoningOutputTokens),
  };
}

const USAGE_FIELDS = [
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
] as const satisfies ReadonlyArray<keyof UsageBreakdown>;

function mapFields(
  a: UsageBreakdown,
  b: UsageBreakdown,
  fn: (x: number, y: number) => number,
): UsageBreakdown {
  const result = emptyUsage();
  for (const field of USAGE_FIELDS) result[field] = fn(a[field], b[field]);
  return result;
}

const add = (a: UsageBreakdown, b: UsageBreakdown) =>
  mapFields(a, b, (x, y) => x + y);

const difference = (current: UsageBreakdown, previous: UsageBreakdown) =>
  mapFields(current, previous, (x, y) => x - y);

const isEmpty = (usage: UsageBreakdown) =>
  USAGE_FIELDS.every(field => usage[field] === 0);

const isRegression = (current: UsageBreakdown, previous: UsageBreakdown) =>
  USAGE_FIELDS.some(field => current[field] < previous[field]);

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
