import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import type { SubagentRegistrationScope } from "../registry/subagent-registry.types.js";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";

const callGateway = vi.fn();
const registerRun = vi.fn();
const resolveEngine = vi.fn();
const startQueuedRun = vi.fn();
let spawn: typeof import("./subagent-spawn.js").spawnSubagentDirect;
let createCallbacks: typeof import("./subagent-spawn-collector.js").createCollectorLaunchCallbacks;
let resetScheduler: () => void;
let isActive: typeof import("../swarm/swarm-scheduler.js").isSwarmRunActive;

beforeAll(async () => {
  ({ spawnSubagentDirect: spawn } = await loadSubagentSpawnModuleForTest({
    callGatewayMock: callGateway,
    registerSubagentRunMock: registerRun,
    resolveContextEngineMock: resolveEngine,
    startQueuedSubagentRunMock: startQueuedRun,
    getRuntimeConfig: () =>
      createSubagentSpawnTestConfig(undefined, {
        tools: { swarm: { enabled: true, maxConcurrent: 1 } },
      }),
  }));
  ({ createCollectorLaunchCallbacks: createCallbacks } =
    await import("./subagent-spawn-collector.js"));
  ({
    testing: { reset: resetScheduler },
  } = await import("../swarm/swarm-scheduler.test-support.js"));
  ({ isSwarmRunActive: isActive } = await import("../swarm/swarm-scheduler.js"));
});

beforeEach(() => {
  resetScheduler();
  registerRun.mockReset();
  startQueuedRun.mockReset().mockReturnValue(true);
  resolveEngine.mockReset();
  callGateway
    .mockReset()
    .mockImplementation(
      async (request: { method?: string; params?: { idempotencyKey?: string } }) =>
        request.method === "agent"
          ? { runId: request.params?.idempotencyKey, status: "accepted" }
          : { ok: true },
    );
});

afterEach(() => {
  resetScheduler();
});

function claimFixture() {
  const gate = createDeferred();
  let claimed = true;
  const settle = vi.fn(async () => {});
  const rollback = vi.fn(async () => {});
  const dispose = vi.fn(async () => {});
  const scope = {
    canLaunch: () => !claimed,
    canCleanupSession: () => true,
    canAcceptLaunch: () => true,
    canRetireReservation: () => true,
    settleFailedLaunch: settle,
    waitForClaim: () => (claimed ? gate.promise : undefined),
  };
  return {
    scope,
    settle,
    rollback,
    dispose,
    release: () => {
      claimed = false;
      gate.resolve();
    },
  };
}

async function nextTurn() {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

it.each([false, true])(
  "closes a claim-free failure scope with dispatchAttempted=%s",
  async (attempted) => {
    const f = claimFixture();
    f.release();
    const failure = new Error("transport refused");
    const launch = vi.fn(async () => {
      throw failure;
    });
    const cleanup = vi.fn(async () => ({ attachmentsRemoved: true, sessionDeleted: true }));
    const callbacks = createCallbacks({
      childRunId: "original",
      childSessionKey: "agent:main:subagent:original",
      requesterSessionKey: "agent:main:main",
      registrationScope: f.scope,
      preparation: { rollback: f.rollback, dispose: f.dispose },
      provisionalSessionIdentity: {},
      launchChildRun: launch,
      recordParticipant: vi.fn(),
      emitSpawnLifecycleHooks: async () => {},
      cleanupFailedSpawn: cleanup,
    });
    if (attempted) {
      await expect(callbacks.start()).rejects.toBe(failure);
    }
    const work = new AsyncWorkScope();
    work.beginClose();
    try {
      expect(await work.track(() => callbacks.onStartFailure(failure))).toBe(attempted);
      expect(f.settle).toHaveBeenCalledTimes(Number(attempted));
      expect(cleanup).toHaveBeenCalledTimes(Number(attempted));
      expect(f.rollback).toHaveBeenCalledTimes(Number(attempted));
      expect(launch).toHaveBeenCalledTimes(Number(attempted));
    } finally {
      await work.drain();
    }
  },
);

it.each(["superseded", "confirmed Stop"] as const)(
  "settles a %s activation through its retained scope before retiring the slot",
  async (owner) => {
    const f = claimFixture();
    f.release();
    f.scope.canLaunch = () => false;
    let retired = false;
    f.scope.canCleanupSession = () => owner === "confirmed Stop" && !retired;
    const settled = createDeferred();
    f.settle.mockImplementation(async () => {
      await settled.promise;
      retired = true;
    });
    registerRun.mockImplementation(
      async (
        _record: unknown,
        options: { retainOwnership: (scope: SubagentRegistrationScope) => void },
      ) => {
        options.retainOwnership(f.scope);
      },
    );
    resolveEngine.mockResolvedValue({
      prepareSubagentSpawn: async () => ({ rollback: f.rollback }),
      dispose: f.dispose,
    });
    const result = await spawn(
      { task: "superseded original collector", collect: true },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );
    try {
      expect(result.status).toBe("accepted");
      await vi.waitFor(() => expect(f.settle).toHaveBeenCalledOnce());
      expect(isActive(result.runId!)).toBe(true);
      expect(f.rollback).not.toHaveBeenCalled();
      expect(
        callGateway.mock.calls.some(
          ([request]) => request.method === "agent" || request.method === "sessions.delete",
        ),
      ).toBe(false);
      settled.resolve();
      await vi.waitFor(() => expect(isActive(result.runId!)).toBe(false));
      expect(f.settle).toHaveBeenCalledOnce();
      expect(f.rollback).not.toHaveBeenCalled();
    } finally {
      settled.resolve();
    }
  },
);

it("retains the actual spawn activation handoff through a provisional claim", async () => {
  const f = claimFixture();
  const registered = createDeferred();
  registerRun.mockImplementation(
    async (
      _record: unknown,
      options: { retainOwnership: (scope: SubagentRegistrationScope) => void },
    ) => {
      options.retainOwnership(f.scope);
      registered.resolve();
    },
  );
  resolveEngine.mockResolvedValue({
    prepareSubagentSpawn: async () => ({ rollback: f.rollback }),
    dispose: f.dispose,
  });
  let completed = false;
  const pending = spawn(
    { task: "preserve prepared collector", collect: true },
    { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
  ).then((result) => {
    completed = true;
    return result;
  });
  try {
    await registered.promise;
    await nextTurn();
    expect(completed).toBe(false);
    expect(f.rollback).not.toHaveBeenCalled();
    expect(f.dispose).not.toHaveBeenCalled();
    expect(callGateway.mock.calls.some(([request]) => request.method === "agent")).toBe(false);
    f.release();
    expect((await pending).status).toBe("accepted");
    await vi.waitFor(() => expect(startQueuedRun).toHaveBeenCalledOnce());
    expect(f.rollback).not.toHaveBeenCalled();
  } finally {
    f.release();
    await pending;
  }
});

it.each(["start", "failure cleanup"] as const)(
  "retains the collector %s handoff through a provisional claim",
  async (phase) => {
    const f = claimFixture();
    const launch = vi.fn(async () => ({ response: { runId: "original", status: "accepted" } }));
    const cleanup = vi.fn(async () => ({ attachmentsRemoved: true, sessionDeleted: true }));
    const callbacks = createCallbacks({
      childRunId: "original",
      childSessionKey: "agent:main:subagent:original",
      requesterSessionKey: "agent:main:main",
      registrationScope: f.scope,
      preparation: { rollback: f.rollback, dispose: f.dispose },
      provisionalSessionIdentity: {},
      launchChildRun: launch,
      recordParticipant: vi.fn(),
      emitSpawnLifecycleHooks: async () => {},
      cleanupFailedSpawn: cleanup,
    });
    let completed = false;
    const pending = Promise.resolve(
      phase === "start" ? callbacks.start() : callbacks.onStartFailure(new Error("launch refused")),
    );
    const observed = pending.then(
      () => {
        completed = true;
      },
      () => {
        completed = true;
      },
    );
    try {
      await nextTurn();
      expect(completed).toBe(false);
      expect(launch).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();
      expect(f.rollback).not.toHaveBeenCalled();
      expect(f.settle).not.toHaveBeenCalled();
      f.release();
      await pending;
      if (phase === "start") {
        expect(launch).toHaveBeenCalledOnce();
      } else {
        expect(cleanup).toHaveBeenCalledOnce();
        expect(f.settle).toHaveBeenCalledOnce();
      }
    } finally {
      f.release();
      await observed;
    }
  },
);
