// Worker lookup by build_runs.worker_type.
//
// One entry today. The registry exists so that adding a second worker is a
// registration, not a change to the runner service or the routes — and so that
// an unknown worker_type fails loudly at dispatch time instead of silently
// doing nothing.

import { claudeCodeWorker, CLAUDE_CODE_WORKER_TYPE } from "./claudeCodeAdapter.js";
import type { BuildWorker } from "./types.js";

const WORKERS = new Map<string, BuildWorker>([
  [CLAUDE_CODE_WORKER_TYPE, claudeCodeWorker],
]);

export function getWorker(workerType: string): BuildWorker | undefined {
  return WORKERS.get(workerType);
}

export function listWorkerTypes(): string[] {
  return [...WORKERS.keys()];
}

/** Test seam. Registering over a live type is deliberate and scoped to tests. */
export function registerWorker(worker: BuildWorker): () => void {
  const previous = WORKERS.get(worker.type);
  WORKERS.set(worker.type, worker);
  return () => {
    if (previous) WORKERS.set(worker.type, previous);
    else WORKERS.delete(worker.type);
  };
}
