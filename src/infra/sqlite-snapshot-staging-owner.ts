import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-coordinator.js";
import {
  captureSqliteReadOnlyWorkerLaunch,
  createScopedSqliteReadOnlyWorker,
} from "./sqlite-readonly-worker.js";

/** Private token connections share one process, never a copy/read worker permit. */
function createStagingOwner() {
  let worker: ReturnType<typeof createScopedSqliteReadOnlyWorker> | undefined;
  let directories = 0;
  let closing: ReturnType<typeof createScopedSqliteReadOnlyWorker> | undefined;
  let pending = Promise.resolve();
  function run<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async function closeSession(current: ReturnType<typeof createScopedSqliteReadOnlyWorker>) {
    closing = current;
    await current.close();
    if (worker === current) {
      worker = undefined;
    }
    closing = undefined;
  }
  async function session() {
    const launch = captureSqliteReadOnlyWorkerLaunch();
    if (closing) {
      await closeSession(closing);
    }
    if (worker?.isRetired()) {
      await closeSession(worker);
    }
    worker ??= createScopedSqliteReadOnlyWorker({
      ...launch,
      retainLifetime: false,
      retainOnOperationError: true,
    });
    if (!worker.compatible(launch)) {
      throw new Error(
        "SQLite snapshot staging owner launch context changed; retire its snapshots before retrying",
      );
    }
    return worker;
  }
  async function retireToken(
    current: ReturnType<typeof createScopedSqliteReadOnlyWorker>,
    directory: string,
  ) {
    let failure: unknown;
    if (!current.isRetired()) {
      try {
        await current.run(directory, { mode: "staging-retire" });
        return current;
      } catch (error) {
        if (!current.isRetired()) {
          throw error;
        }
        failure = error;
      }
    }
    try {
      await closeSession(current);
      const replacement = await session();
      await replacement.run(directory, { mode: "staging-reconcile" });
      return replacement;
    } catch (error) {
      if (failure !== undefined) {
        throw createSqliteLifecycleAggregateError(
          [failure, error],
          "SQLite snapshot retirement and reconciliation failed",
          failure,
        );
      }
      throw error;
    }
  }
  return {
    async allocate(root: string, allowLegacyWorker: boolean) {
      return run(async () => {
        const current = await session();
        let directory: string;
        try {
          const result = await current.run(root, {
            mode: allowLegacyWorker ? "staging-create-legacy" : "staging-create",
          });
          if (typeof result !== "string") {
            throw new Error("SQLite snapshot staging owner returned an invalid directory");
          }
          directory = result;
          directories++;
        } catch (error) {
          if (directories === 0) {
            try {
              await closeSession(current);
            } catch (cleanupError) {
              throw createSqliteLifecycleAggregateError(
                [error, cleanupError],
                "SQLite snapshot allocation and owner cleanup failed",
                error,
              );
            }
          }
          throw error;
        }
        let tokenRetired = false;
        let lastDirectory = false;
        let complete = false;
        let retirementSession = current;
        return {
          directory,
          retire: () =>
            run(async () => {
              if (complete) {
                return;
              }
              if (!tokenRetired) {
                retirementSession = await retireToken(current, directory);
                tokenRetired = true;
                lastDirectory = --directories === 0;
              }
              if (lastDirectory) {
                await closeSession(retirementSession);
              }
              complete = true;
            }),
        };
      });
    },
  };
}

export function allocateWorkerOwnedSqliteSnapshotDirectory(
  root: string,
  allowLegacyWorker: boolean,
) {
  return resolveGlobalSingleton(
    Symbol.for("openclaw.sqliteSnapshotStagingOwner"),
    createStagingOwner,
  ).allocate(root, allowLegacyWorker);
}
