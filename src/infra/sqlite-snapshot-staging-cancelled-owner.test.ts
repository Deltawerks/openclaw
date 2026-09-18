import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const owner = vi.hoisted(() => ({
  allocate: vi.fn(),
  retire: vi.fn<() => Promise<void>>(),
}));
vi.mock("./sqlite-snapshot-staging-owner.js", () => ({
  allocateWorkerOwnedSqliteSnapshotDirectory: owner.allocate,
}));
vi.mock("./sqlite-readonly-worker.js", () => ({
  resolveSqliteInspectionSignal: (signal?: AbortSignal) => signal,
  runSqliteReadOnlyWorker: async () => [],
  runSqliteReadOnlyWorkerSync: () => {
    throw new Error("unexpected synchronous worker");
  },
}));

import {
  removeTempDirectoryAsync,
  SqliteSnapshotCleanupError,
} from "./sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocationAsync } from "./sqlite-snapshot-source.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.unstubAllEnvs();
    cleanup();
  }),
);

it("preserves unpublished allocation cleanup failure when its caller cancels", async () => {
  const root = tempDirs.make("snapshot-cancelled-owner-");
  const directory = path.join(root, "owned");
  fs.mkdirSync(directory);
  vi.stubEnv("XDG_CACHE_HOME", root);
  const controller = new AbortController();
  owner.retire.mockRejectedValueOnce(new Error("retirement unavailable"));
  owner.allocate.mockImplementationOnce(async () => {
    controller.abort(new Error("caller retired"));
    return { directory, retire: owner.retire };
  });
  try {
    const error = await prepareSqliteReadOnlyLocationAsync(path.join(root, "source.sqlite"), {
      signal: controller.signal,
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(SqliteSnapshotCleanupError);
    expect(error).toMatchObject({ message: expect.stringContaining("snapshot cleanup failed") });
    expect(fs.existsSync(directory)).toBe(true);
  } finally {
    owner.retire.mockResolvedValue(undefined);
    expect(await removeTempDirectoryAsync(directory)).toBe(true);
  }
});
