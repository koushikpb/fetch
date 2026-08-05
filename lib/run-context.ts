// Run correlation, threaded implicitly through every stage of a pipeline run so that
// lib/log.ts can attach `run_id` without every function in the call chain having to
// accept and forward it explicitly. AsyncLocalStorage is a Node builtin — no new
// dependency (composer resolution #4).
import { AsyncLocalStorage } from 'node:async_hooks';

// One store per process: a run is a process-wide concept in this pipeline (CLAUDE.md
// architecture — one run flows through ingest -> filter -> extract -> cluster -> score ->
// synthesize), so a module-level singleton is correct rather than something callers
// instantiate.
const runIdStorage = new AsyncLocalStorage<string>();

/**
 * Runs `fn` with `runId` attached to the current async context. Everything executed
 * synchronously inside `fn`, plus any awaited continuation or callback scheduled during
 * that execution, can read it back via `getRunId()` — including code in modules that hold
 * no reference to `runId` itself.
 */
export function withRun<T>(runId: string, fn: () => T): T {
  return runIdStorage.run(runId, fn);
}

/** The current run id, or `undefined` when called outside `withRun` — reading never throws, so lib/log.ts can call this unconditionally on every log line. */
export function getRunId(): string | undefined {
  return runIdStorage.getStore();
}
