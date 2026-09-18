import { channel as diagnosticsChannel } from "node:diagnostics_channel";
import type { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createOwnedWorkerTaskPool } from "./worker-task-pool.js";

type PostedTask = { input: string; taskId: number; responseId?: number };
type FakeWorker = EventEmitter & {
  postMessage: ReturnType<typeof vi.fn<(message: PostedTask) => void>>;
  terminate: ReturnType<typeof vi.fn<() => Promise<number>>>;
};
const workers = vi.hoisted(() => [] as FakeWorker[]);

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    Worker: class extends EventEmitter {
      constructor() {
        super();
        workers.push(this);
      }
      postMessage = vi.fn<(message: PostedTask) => void>();
      ref() {}
      unref() {}
      terminate = vi.fn(async () => {
        this.emit("exit", 0);
        return 0;
      });
    },
  };
});
vi.mock("./runtime-worker-url.js", () => ({ resolveRuntimeWorkerThreadExecArgv: () => [] }));

type Pool = ReturnType<typeof createOwnedWorkerTaskPool<string, string>>;
type PoolOptions = Parameters<typeof createOwnedWorkerTaskPool<string, string>>[0];
const pools: Pool[] = [];

function createPool(options: Partial<PoolOptions> = {}) {
  const pool = createOwnedWorkerTaskPool<string, string>({
    workerUrl: new URL("file:///fixture/owned-worker.js"),
    maxWorkers: 1,
    idleTimeoutMs: 0,
    ...options,
  });
  pools.push(pool);
  return pool;
}

function workerFor(input: string): FakeWorker {
  return expectDefined(
    workers.find((worker) => worker.postMessage.mock.calls.some(([task]) => task.input === input)),
    `worker for ${input}`,
  );
}

function reply(worker: FakeWorker, input: string, value = input): void {
  const task = expectDefined(
    worker.postMessage.mock.calls.find(([posted]) => posted.input === input)?.[0],
    `posted ${input}`,
  );
  worker.emit("message", { status: "ok", taskId: task.taskId, value });
}

function holdExit(worker: FakeWorker) {
  const entered = createDeferredCore();
  const exit = createDeferredCore();
  worker.terminate.mockImplementationOnce(async () => {
    entered.resolve();
    await exit.promise;
    worker.emit("exit", 0);
    return 0;
  });
  return { entered: entered.promise, release: () => exit.resolve() };
}

beforeEach(() => {
  workers.splice(0);
});
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

describe("owned worker tasks", () => {
  it("holds a completed reply until acceptance and never retires its successor on late close", async () => {
    const pool = createPool();
    const first = pool.runTask("first", {});
    const worker = workerFor("first");
    const prepareNext = vi.fn(() => "next");
    const next = pool.runTask(prepareNext, {});

    reply(worker, "first", "accepted reply");
    await expect(first.result).resolves.toBe("accepted reply");
    expect(prepareNext).not.toHaveBeenCalled();
    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(pool.getSnapshot().pendingTasks).toBe(2);

    await first.close();
    expect(prepareNext).toHaveBeenCalledOnce();
    expect(workerFor("next")).toBe(worker);
    await first.close({ retire: true });
    await first.close();
    expect(worker.terminate).not.toHaveBeenCalled();
    reply(worker, "next");
    await expect(next.result).resolves.toBe("next");
    await next.close();
    expect(pool.getSnapshot().pendingTasks).toBe(0);
  });

  it("cancels a queued task without preparing its input or stopping the occupied worker", async () => {
    const pool = createPool();
    const active = pool.runTask("active", {});
    const worker = workerFor("active");
    const controller = new AbortController();
    const reason = new Error("queued owner closed");
    const prepare = vi.fn(() => "must not dispatch");
    const consumed = vi.fn();
    const queued = pool.runTask(prepare, {
      signal: controller.signal,
      onInputConsumed: consumed,
    });
    const rejected = expect(queued.result).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    await queued.close();

    expect(prepare).not.toHaveBeenCalled();
    expect(consumed).toHaveBeenCalledOnce();
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(worker.postMessage).toHaveBeenCalledOnce();
    reply(worker, "active");
    await expect(active.result).resolves.toBe("active");
    await active.close();
  });

  it("joins cancelled asynchronous preparation before releasing input custody", async () => {
    const pool = createPool({ maxPendingBytes: 8 });
    const preparing = createDeferredCore();
    const prepared = createDeferredCore<string>();
    const controller = new AbortController();
    const reason = new Error("preparation owner closed");
    const consumed = vi.fn();
    const task = pool.runTask(
      async () => {
        preparing.resolve();
        return await prepared.promise;
      },
      { inputBytes: 8, signal: controller.signal, onInputConsumed: consumed },
    );
    await preparing.promise;
    const rejected = expect(task.result).rejects.toBe(reason);
    controller.abort(reason);
    let closed = false;
    const closing = task.close().then(() => {
      closed = true;
    });
    try {
      await rejected;
      expect(closed).toBe(false);
      expect(consumed).not.toHaveBeenCalled();
      expect(pool.getSnapshot().pendingTasks).toBe(1);
      expect(workers).toHaveLength(0);
    } finally {
      prepared.resolve("must not dispatch");
      await closing;
    }
    expect(closed).toBe(true);
    expect(consumed).toHaveBeenCalledOnce();
    expect(pool.getSnapshot().pendingTasks).toBe(0);
    expect(workers).toHaveLength(0);
  });

  it("joins a running task's native exit while a sibling remains usable", async () => {
    const pool = createPool({ maxWorkers: 2 });
    const controller = new AbortController();
    const reason = new Error("only this owner cancelled");
    const consumed = vi.fn();
    const active = pool.runTask("cancelled", {
      signal: controller.signal,
      onInputConsumed: consumed,
    });
    const sibling = pool.runTask("sibling", {});
    const worker = workerFor("cancelled");
    const siblingWorker = workerFor("sibling");
    const native = holdExit(worker);
    const rejected = expect(active.result).rejects.toBe(reason);
    controller.abort(reason);
    let closed = false;
    const closing = active.close().then(() => {
      closed = true;
    });
    try {
      await rejected;
      await native.entered;
      expect(closed).toBe(false);
      expect(consumed).not.toHaveBeenCalled();
      reply(siblingWorker, "sibling");
      await expect(sibling.result).resolves.toBe("sibling");
      await sibling.close();
      const next = pool.runTask("sibling successor", {});
      expect(workerFor("sibling successor")).toBe(siblingWorker);
      expect(siblingWorker.terminate).not.toHaveBeenCalled();
      reply(siblingWorker, "sibling successor");
      await expect(next.result).resolves.toBe("sibling successor");
      await next.close();
    } finally {
      native.release();
      await closing;
    }
    expect(consumed).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(siblingWorker.terminate).not.toHaveBeenCalled();
  });

  it.each(["none", "message", "error", "exit"] as const)(
    "retains failed retirement custody until explicit close despite a late %s event",
    async (lateEvent) => {
      const primary = new Error("result rejected by its owner");
      const cleanup = new Error("native exit not confirmed");
      const retirementFailed = createDeferredCore();
      const pool = createPool({
        maxWorkers: 2,
        maxPendingBytes: 10,
        validateResult(value) {
          if (value === "invalid") {
            throw primary;
          }
        },
        onRetirementFailure: () => retirementFailed.resolve(),
      });
      const consumed = vi.fn();
      const failed = pool.runTask("failed", { inputBytes: 8, onInputConsumed: consumed });
      const sibling = pool.runTask("sibling", { inputBytes: 1 });
      const worker = workerFor("failed");
      const siblingWorker = workerFor("sibling");
      worker.terminate.mockRejectedValueOnce(cleanup);
      const rejected = expect(failed.result).rejects.toBe(primary);
      reply(worker, "failed", "invalid");
      await rejected;
      await retirementFailed.promise;
      // Both the cached owner failure and the slot retirement rejection must have settled.
      await nextTurn();
      const emitLateEvent = () => {
        if (lateEvent === "message") {
          reply(worker, "failed", "late reply from the same task");
        } else if (lateEvent === "error") {
          worker.emit("error", new Error("late worker error"));
        } else if (lateEvent === "exit") {
          worker.emit("exit", 1);
        }
      };
      emitLateEvent();
      await nextTurn();
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(consumed).not.toHaveBeenCalled();
      expect(pool.getSnapshot().pendingTasks).toBe(2);
      expect(siblingWorker.terminate).not.toHaveBeenCalled();
      await expect(failed.result).rejects.toBe(primary);
      await expect(failed.close()).rejects.toBe(cleanup);
      // Observing the failure permits an explicit retry, never a retry from a late event.
      emitLateEvent();
      await nextTurn();
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(consumed).not.toHaveBeenCalled();
      expect(pool.getSnapshot().pendingTasks).toBe(2);
      expect(siblingWorker.terminate).not.toHaveBeenCalled();
      await expect(failed.result).rejects.toBe(primary);
      const excess = pool.runTask("over capacity", { inputBytes: 2 });
      await expect(excess.result).rejects.toMatchObject({ code: "overloaded" });
      await excess.close();

      reply(siblingWorker, "sibling");
      await expect(sibling.result).resolves.toBe("sibling");
      await sibling.close();
      const native = holdExit(worker);
      const closing = failed.close();
      const alsoClosing = failed.close();
      try {
        await native.entered;
        expect(consumed).not.toHaveBeenCalled();
        const next = pool.runTask("sibling successor", { inputBytes: 2 });
        expect(workerFor("sibling successor")).toBe(siblingWorker);
        expect(workers).toHaveLength(2);
        reply(siblingWorker, "sibling successor");
        await expect(next.result).resolves.toBe("sibling successor");
        await next.close();
        expect(siblingWorker.terminate).not.toHaveBeenCalled();
      } finally {
        native.release();
        await Promise.all([closing, alsoClosing]);
      }
      expect(worker.terminate).toHaveBeenCalledTimes(2);
      expect(consumed).toHaveBeenCalledOnce();
      expect(pool.getSnapshot().pendingTasks).toBe(0);
      await expect(failed.result).rejects.toBe(primary);
      await failed.close({ retire: true });
      expect(worker.terminate).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["task-close", "pool-close"] as const)(
    "reports automatic input-cleanup failure after native retirement to %s first",
    async (firstObserver) => {
      const primary = new Error("original task failure");
      const cleanup = new Error("input release callback failed");
      const completionEntered = createDeferredCore();
      const pool = createPool({
        maxPendingBytes: 8,
        validateResult() {
          throw primary;
        },
      });
      const consumed = vi.fn(() => {
        completionEntered.resolve();
        throw cleanup;
      });
      const task = pool.runTask("failed", { inputBytes: 8, onInputConsumed: consumed });
      const worker = workerFor("failed");
      const rejected = expect(task.result).rejects.toBe(primary);
      reply(worker, "failed");
      await rejected;
      await completionEntered.promise;
      // Automatic completion must finish its finally block and cache the callback rejection.
      await nextTurn();
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(consumed).toHaveBeenCalledOnce();
      expect(pool.getSnapshot().pendingTasks).toBe(1);
      const excess = pool.runTask("over capacity", { inputBytes: 1 });
      await expect(excess.result).rejects.toMatchObject({ code: "overloaded" });
      await excess.close();

      await expect(firstObserver === "task-close" ? task.close() : pool.close()).rejects.toBe(
        cleanup,
      );
      await expect(task.result).rejects.toBe(primary);
      await task.close();
      await Promise.all([task.close({ retire: true }), pool.close()]);
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(consumed).toHaveBeenCalledOnce();
      expect(pool.getSnapshot().pendingTasks).toBe(0);
      await expect(task.result).rejects.toBe(primary);
    },
  );

  it("preserves both owned cleanup failures when global close observes them together", async () => {
    const firstPrimary = new Error("first task failure");
    const secondPrimary = new Error("second task failure");
    const firstCleanup = new Error("first input cleanup failure");
    const secondCleanup = new Error("second input cleanup failure");
    const firstCompleted = createDeferredCore();
    const secondCompleted = createDeferredCore();
    const pool = createPool({
      maxWorkers: 2,
      validateResult(value) {
        throw value === "first" ? firstPrimary : secondPrimary;
      },
    });
    const releaseFirst = vi.fn(() => {
      firstCompleted.resolve();
      throw firstCleanup;
    });
    const releaseSecond = vi.fn(() => {
      secondCompleted.resolve();
      throw secondCleanup;
    });
    const first = pool.runTask("first", { onInputConsumed: releaseFirst });
    const second = pool.runTask("second", { onInputConsumed: releaseSecond });
    const firstWorker = workerFor("first");
    const secondWorker = workerFor("second");
    const firstRejected = expect(first.result).rejects.toBe(firstPrimary);
    const secondRejected = expect(second.result).rejects.toBe(secondPrimary);
    reply(firstWorker, "first");
    reply(secondWorker, "second");
    await Promise.all([
      firstRejected,
      secondRejected,
      firstCompleted.promise,
      secondCompleted.promise,
    ]);
    await nextTurn();
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(secondWorker.terminate).toHaveBeenCalledOnce();
    expect(pool.getSnapshot().pendingTasks).toBe(2);

    const failure = await pool.close().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw new Error("Global close lost an independent owned cleanup failure");
    }
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors.some((error) => error === firstCleanup)).toBe(true);
    expect(failure.errors.some((error) => error === secondCleanup)).toBe(true);

    await Promise.all([first.close(), second.close(), pool.close()]);
    expect(releaseFirst).toHaveBeenCalledOnce();
    expect(releaseSecond).toHaveBeenCalledOnce();
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(secondWorker.terminate).toHaveBeenCalledOnce();
    expect(pool.getSnapshot().pendingTasks).toBe(0);
    await expect(first.result).rejects.toBe(firstPrimary);
    await expect(second.result).rejects.toBe(secondPrimary);
  });

  it("observes each failed stop once before a global close retries an owned task", async () => {
    const primary = new Error("original task failure");
    const firstStop = new Error("automatic stop failed");
    const secondStop = new Error("explicit retry failed");
    const automaticFailure = createDeferredCore();
    const pool = createPool({
      maxPendingBytes: 8,
      validateResult() {
        throw primary;
      },
      onRetirementFailure(error) {
        if (error === firstStop) {
          // Let automatic retirement finish caching its rejection before close observes it.
          setImmediate(() => automaticFailure.resolve());
        }
      },
    });
    const consumed = vi.fn();
    const task = pool.runTask("failed", { inputBytes: 8, onInputConsumed: consumed });
    const worker = workerFor("failed");
    worker.terminate.mockRejectedValueOnce(firstStop).mockRejectedValueOnce(secondStop);
    const native = holdExit(worker);
    const rejected = expect(task.result).rejects.toBe(primary);
    reply(worker, "failed");
    try {
      await rejected;
      await automaticFailure.promise;
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(consumed).not.toHaveBeenCalled();
      const excess = pool.runTask("capacity remains held", { inputBytes: 1 });
      await expect(excess.result).rejects.toMatchObject({ code: "overloaded" });
      await excess.close();

      await expect(pool.close()).rejects.toBe(firstStop);
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(consumed).not.toHaveBeenCalled();
      expect(pool.getSnapshot().pendingTasks).toBe(1);

      await expect(pool.close()).rejects.toBe(secondStop);
      expect(worker.terminate).toHaveBeenCalledTimes(2);
      expect(consumed).not.toHaveBeenCalled();
      expect(pool.getSnapshot().pendingTasks).toBe(1);
      await expect(task.result).rejects.toBe(primary);

      const closing = pool.close();
      await native.entered;
      expect(worker.terminate).toHaveBeenCalledTimes(3);
      expect(consumed).not.toHaveBeenCalled();
      expect(pool.getSnapshot().pendingTasks).toBe(1);
      native.release();
      await closing;
      expect(consumed).toHaveBeenCalledOnce();
      expect(pool.getSnapshot().pendingTasks).toBe(0);
      await expect(task.result).rejects.toBe(primary);
      await Promise.all([task.close(), pool.close()]);
      expect(worker.terminate).toHaveBeenCalledTimes(3);
    } finally {
      native.release();
    }
  });

  it("retains a successful reply when its explicitly requested retirement fails", async () => {
    const pool = createPool();
    const task = pool.runTask("completed", {});
    const worker = workerFor("completed");
    reply(worker, "completed", "domain outcome");
    await expect(task.result).resolves.toBe("domain outcome");
    const cleanup = new Error("stop failed after reply");
    worker.terminate.mockRejectedValueOnce(cleanup);
    await expect(task.close({ retire: true })).rejects.toBe(cleanup);
    expect(pool.getSnapshot().pendingTasks).toBe(1);
    await task.close();
    expect(worker.terminate).toHaveBeenCalledTimes(2);
    expect(pool.getSnapshot().pendingTasks).toBe(0);
    await expect(task.result).resolves.toBe("domain outcome");
  });

  it("joins native exit when global close reenters healthy task completion", async () => {
    const pool = createPool();
    const task = pool.runTask("completed", {});
    const worker = workerFor("completed");
    reply(worker, "completed", "accepted reply");
    await expect(task.result).resolves.toBe("accepted reply");
    const native = holdExit(worker);
    const diagnostics = diagnosticsChannel("openclaw.worker.task");
    let globalClose: Promise<void> | undefined;
    let globallyClosed = false;
    let completions = 0;
    const onCompletion = (message: unknown) => {
      if (
        !message ||
        typeof message !== "object" ||
        !("worker" in message) ||
        message.worker !== "owned-worker.js"
      ) {
        return;
      }
      completions++;
      globalClose ??= pool.close().then(() => {
        globallyClosed = true;
      });
    };
    diagnostics.subscribe(onCompletion);
    const closingTask = task.close();
    try {
      await closingTask;
      // A healthy task is detached before its completion observer reenters pool.close().
      await nextTurn();
      expect(completions).toBe(1);
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(globallyClosed).toBe(false);
      await expect(task.result).resolves.toBe("accepted reply");
    } finally {
      diagnostics.unsubscribe(onCompletion);
      native.release();
      await closingTask;
      await globalClose;
    }
    expect(globallyClosed).toBe(true);
    await Promise.all([task.close(), pool.close()]);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(completions).toBe(1);
    expect(pool.getSnapshot().pendingTasks).toBe(0);
    await expect(task.result).resolves.toBe("accepted reply");
  });

  it.each(["task-first", "pool-first"] as const)(
    "joins one native stop when global and task close overlap (%s)",
    async (order) => {
      const pool = createPool();
      const consumed = vi.fn();
      const task = pool.runTask("active", { onInputConsumed: consumed });
      const worker = workerFor("active");
      const native = holdExit(worker);
      const rejected = expect(task.result).rejects.toBeInstanceOf(Error);
      const closing =
        order === "task-first" ? [task.close(), pool.close()] : [pool.close(), task.close()];
      try {
        await rejected;
        await native.entered;
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(consumed).not.toHaveBeenCalled();
      } finally {
        native.release();
        await Promise.all(closing);
      }
      expect(consumed).toHaveBeenCalledOnce();
      expect(pool.getSnapshot().pendingTasks).toBe(0);
      await Promise.all([task.close(), pool.close()]);
      expect(worker.terminate).toHaveBeenCalledOnce();
    },
  );
});
