import { chmodSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BoardWidgetMaterializedPutParams } from "../../packages/gateway-protocol/src/index.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.entry.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { SqliteBoardStore } from "./sqlite-board-store.js";
import { readBoardSnapshotWithHtmlViewMetadata } from "./sqlite-board-store.kernel.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

function fixture(incognito = false) {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("board-worker-mutations-") };
  const sessionKey = "agent:main:board";
  const database = openOpenClawAgentDatabase({
    agentId: "main",
    env,
    ...(incognito
      ? { path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }) }
      : {}),
  });
  replaceSessionEntrySync(
    { agentId: "main", sessionKey, storePath: database.path },
    { sessionId: "board-worker-session", updatedAt: 1 },
  );
  const options = { agentId: "main", path: database.path, env };
  const target = { sessionKey };
  const store = new SqliteBoardStore({
    resolveSession: () => ({ ...options, sessionKey }),
    env,
  });
  return { database, env, options, store, target };
}

it("keeps incognito Board mutations on the process-held database without creating its disk path", async () => {
  const { database, options, store, target } = fixture(true);
  const changes: SessionRowChange[] = [];
  const unsubscribe = sessionChanges.subscribe((change) => changes.push(change));
  try {
    expect(existsSync(options.path)).toBe(false);
    await store.putWidget({
      ...target,
      name: "private",
      content: { kind: "html", html: "<p>process-held</p>" },
    });
    const updated = await store.applyOps(target, [
      { kind: "widget_resize", name: "private", sizeW: 8, sizeH: 6 },
    ]);
    expect(updated).toMatchObject({
      revision: 2,
      widgets: [{ name: "private", revision: 1, sizeW: 8, sizeH: 6 }],
    });
    expect(await store.getSnapshot(target)).toEqual(updated);
    expect(await store.useWidgetDocument(target, "private", (document) => document)).toMatchObject({
      html: "<p>process-held</p>",
      revision: 1,
    });
    expect(openOpenClawAgentDatabase(options).db).toBe(database.db);
    expect(changes).toEqual([
      { sessionKey: target.sessionKey, storePath: options.path },
      { sessionKey: target.sessionKey, storePath: options.path },
    ]);
    for (const suffix of ["", "-wal", "-shm"]) {
      expect(existsSync(`${options.path}${suffix}`)).toBe(false);
    }
  } finally {
    unsubscribe();
  }
});

it("executes Board mutations off the host and publishes each committed change once", async () => {
  const { database, env, store, target } = fixture();
  const changes: Array<{ change: SessionRowChange; inTransaction: boolean; revision: number }> = [];
  const unsubscribe = sessionChanges.subscribe((change) => {
    if ("sessionKey" in change && change.sessionKey === target.sessionKey) {
      changes.push({
        change,
        inTransaction: database.db.isTransaction,
        revision: readBoardSnapshotWithHtmlViewMetadata(database, target.sessionKey)!.snapshot
          .revision,
      });
    }
  });
  clearNodeSqliteKyselyCacheForDatabase(database.db);
  const host = observeHostDataSql(env);
  const expectPublication = (revision: number) => {
    expect(changes).toEqual([
      {
        change: { sessionKey: target.sessionKey, storePath: database.path },
        inTransaction: false,
        revision,
      },
    ]);
    changes.length = 0;
  };
  try {
    expect(
      await store.applyOps(target, [{ kind: "tab_create", tabId: "main", title: "Main" }]),
    ).toMatchObject({ revision: 1, tabs: [{ tabId: "main" }] });
    expectPublication(1);
    const privateFiles = [database.path, `${database.path}-wal`, `${database.path}-shm`];
    if (process.platform !== "win32") {
      chmodSync(path.dirname(database.path), 0o1700);
      for (const file of privateFiles) {
        chmodSync(file, 0o644);
      }
    }
    const put = await store.putWidget({
      ...target,
      name: "status",
      content: { kind: "html", html: "<p>committed</p>" },
      declared: { tools: ["health"] },
    });
    expect(put).toMatchObject({ revision: 2, widgets: [{ revision: 1, grantState: "pending" }] });
    expectPublication(2);
    if (process.platform !== "win32") {
      expect(statSync(path.dirname(database.path)).mode & 0o7777).toBe(0o700);
      for (const file of privateFiles) {
        expect(statSync(file).mode & 0o7777).toBe(0o600);
      }
    }
    expect(
      await store.grant(target, "status", "granted", 1, put.widgets[0]?.instanceId),
    ).toMatchObject({ revision: 3, widgets: [{ revision: 1, grantState: "granted" }] });
    expectPublication(3);
    expect(await store.useWidgetDocument(target, "status", (document) => document)).toMatchObject({
      html: "<p>committed</p>",
      grantState: "granted",
    });
    const hostBoardMutations = host.calls
      .slice(0, 2)
      .flatMap((call) => call.mock.calls.map(([sql]) => sql))
      .filter(
        (sql) =>
          typeof sql === "string" &&
          /^\s*(?:insert|update|delete|replace)\b/iu.test(sql) &&
          /\bboard_(?:tabs|widgets)\b/iu.test(sql),
      );
    expect(hostBoardMutations).toEqual([]);
    expect(changes).toEqual([]);
  } finally {
    host.restore();
    unsubscribe();
  }
});

it.each([false, true])(
  "retains queued Board input and rejects revoked authority (revoked: %s)",
  async (revoke) => {
    const { database, options, store, target } = fixture();
    const release = createDeferredCore();
    const entered = createDeferredCore();
    const held = runOpenClawAgentWorkerWrite(options, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const changes: SessionRowChange[] = [];
    const unsubscribe = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey === target.sessionKey) {
        changes.push(change);
      }
    });
    let current = true;
    const params: BoardWidgetMaterializedPutParams = {
      ...target,
      name: "captured",
      content: { kind: "html", html: "<p>captured</p>" },
    };
    const pending = store.putWidget(params, {
      assertCurrent() {
        if (!current) {
          throw new Error("Board request retired while queued");
        }
      },
    });
    void pending.catch(() => undefined);
    try {
      params.name = "changed";
      params.content = { kind: "html", html: "<p>changed</p>" };
      current = !revoke;
      expect(changes).toEqual([]);
      release.resolve();
      await held;
      if (revoke) {
        await expect(pending).rejects.toThrow("Board request retired while queued");
        expect(await store.getSnapshot(target)).toMatchObject({ revision: 0, widgets: [] });
        expect(changes).toEqual([]);
      } else {
        await expect(pending).resolves.toMatchObject({
          resolvedWidgetName: "captured",
          widgets: [{ name: "captured", revision: 1 }],
        });
        expect(
          await store.useWidgetDocument(target, "captured", (document) => document),
        ).toMatchObject({ html: "<p>captured</p>" });
        expect(changes).toEqual([{ sessionKey: target.sessionKey, storePath: database.path }]);
      }
    } finally {
      release.resolve();
      await Promise.allSettled([held, pending]);
      unsubscribe();
    }
  },
);

it("preserves committed Boards and admits followers after publication cleanup is refused", async () => {
  const { database, store, target } = fixture();
  const changes: SessionRowChange[] = [];
  const unsubscribe = sessionChanges.subscribe((change) => {
    if ("sessionKey" in change && change.sessionKey === target.sessionKey) {
      changes.push(change);
    }
  });
  const create = admission.createSqliteWorkerOperationAdmission;
  let refuseCleanup = false;
  let refusals = 0;
  const interception = vi
    .spyOn(admission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit) =>
      create((request, grant) => {
        if (refuseCleanup && request.stage === "prepare") {
          refuseCleanup = false;
          refusals++;
          throw new Error("controlled Board publication cleanup admission refusal");
        }
        admit(request, grant);
        if (request.stage === "commit" && refusals === 0) {
          refuseCleanup = true;
        }
      }),
    );
  const put = (name: string) =>
    store.putWidget({ ...target, name, content: { kind: "html", html: `<p>${name}</p>` } });
  const first = put("first");
  const queued = put("queued");
  void first.catch(() => undefined);
  void queued.catch(() => undefined);
  try {
    expect(await first).toMatchObject({ revision: 1, resolvedWidgetName: "first" });
    expect(await queued).toMatchObject({ revision: 2, resolvedWidgetName: "queued" });
    expect(refusals).toBe(1);
    interception.mockRestore();
    const final = await put("later");
    expect(final.revision).toBe(3);
    expect(final.widgets.map((widget) => widget.name).toSorted()).toEqual([
      "first",
      "later",
      "queued",
    ]);
    expect(changes).toEqual(
      Array.from({ length: 3 }, () => ({
        sessionKey: target.sessionKey,
        storePath: database.path,
      })),
    );
    await closeOpenClawAgentDatabasesAsync();
    expect(await store.getSnapshot(target)).toMatchObject({
      revision: final.revision,
      tabs: final.tabs,
      widgets: final.widgets,
    });
  } finally {
    interception.mockRestore();
    await Promise.allSettled([first, queued]);
    unsubscribe();
  }
});
