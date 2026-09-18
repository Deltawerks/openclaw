import { beforeEach, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  compatible: vi.fn(() => true),
  isRetired: vi.fn(() => false),
  run: vi.fn<(...args: unknown[]) => Promise<string>>(),
  close: vi.fn<() => Promise<void>>(),
}));
const factory = vi.hoisted(() => vi.fn());
vi.mock("./sqlite-readonly-worker.js", () => ({
  captureSqliteReadOnlyWorkerLaunch: () => ({ env: {}, cwd: "/fixture" }),
  createScopedSqliteReadOnlyWorker: factory,
}));

import { allocateWorkerOwnedSqliteSnapshotDirectory } from "./sqlite-snapshot-staging-owner.js";

beforeEach(() => {
  transport.run.mockReset().mockResolvedValue("/fixture/snapshot");
  transport.close.mockReset().mockResolvedValue(undefined);
  transport.isRetired.mockReset().mockReturnValue(false);
  factory.mockReset().mockReturnValue(transport);
});

it("acknowledges a lost session before reconciling retirement and accepting new allocations", async () => {
  const owned = await allocateWorkerOwnedSqliteSnapshotDirectory("/fixture", false);
  let acknowledge!: () => void;
  transport.isRetired.mockReturnValue(true);
  transport.close.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      acknowledge = resolve;
    }),
  );
  const replacement = {
    compatible: () => true,
    isRetired: () => false,
    run: vi.fn().mockResolvedValue("/fixture/replacement"),
    close: vi.fn().mockResolvedValue(undefined),
  };
  factory.mockReturnValue(replacement);
  const retired = owned.retire();
  await vi.waitFor(() => expect(transport.close).toHaveBeenCalledOnce());
  expect(replacement.run).not.toHaveBeenCalled();
  acknowledge();
  await retired;
  expect(replacement.run).toHaveBeenCalledWith("/fixture/snapshot", { mode: "staging-reconcile" });
  expect(replacement.close).toHaveBeenCalledOnce();
  const next = await allocateWorkerOwnedSqliteSnapshotDirectory("/fixture", false);
  await next.retire();
});

it("retries the same last session close before releasing snapshot custody", async () => {
  const owned = await allocateWorkerOwnedSqliteSnapshotDirectory("/fixture", false);
  const failure = new Error("session close unacknowledged");
  transport.close.mockRejectedValueOnce(failure);
  await expect(owned.retire()).rejects.toBe(failure);
  await expect(owned.retire()).resolves.toBeUndefined();
  expect(transport.close).toHaveBeenCalledTimes(2);
  expect(transport.run).toHaveBeenCalledTimes(2);
  await owned.retire();
  expect(transport.close).toHaveBeenCalledTimes(2);
});

it("preserves allocation and close failures and joins retained close before new allocation", async () => {
  const allocation = new Error("allocation failed");
  const cleanup = new Error("close failed");
  transport.run.mockRejectedValueOnce(allocation);
  transport.close.mockRejectedValueOnce(cleanup);
  await expect(allocateWorkerOwnedSqliteSnapshotDirectory("/fixture", false)).rejects.toMatchObject(
    {
      errors: [allocation, cleanup],
      cause: allocation,
    },
  );
  const owned = await allocateWorkerOwnedSqliteSnapshotDirectory("/fixture", false);
  expect(transport.close).toHaveBeenCalledTimes(2);
  await owned.retire();
  expect(transport.close).toHaveBeenCalledTimes(3);
});
