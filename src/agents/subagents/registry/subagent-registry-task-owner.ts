import {
  capturePluginLifecycleAuthority,
  getPluginRecordRegistry,
} from "../../../plugins/registry-lifecycle.js";
import { requireActivePluginRegistry } from "../../../plugins/runtime.js";
import type { DetachedTaskCreateParams } from "../../../tasks/detached-task-runtime-contract.js";
import { getDetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime.js";
import { getTaskFlowRegistryStore } from "../../../tasks/task-flow-registry.store.js";
import { withTaskRegistryMutation } from "../../../tasks/task-registry-state.js";
import { getTaskRegistryStore } from "../../../tasks/task-registry.store.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";

/** Retain one queued task backend while its registry intent crosses worker acknowledgements. */
export function captureQueuedSubagentTaskOwner(
  taskParams: DetachedTaskCreateParams,
  assertRunCurrent: () => void,
): {
  assertCurrent: () => void;
  create: () => TaskRecord | null;
  finalize: (taskId: string, endedAt: number, error: string) => TaskRecord[];
} {
  const params = structuredClone(taskParams);
  const runId = params.runId?.trim();
  const sessionKey = params.childSessionKey?.trim();
  if (params.runtime !== "subagent" || !runId || !sessionKey) {
    throw new Error("Queued subagent task ownership requires its exact run and child session");
  }
  const registry = requireActivePluginRegistry();
  const registration = registry.detachedTaskRuntimes[0];
  const runtime = registration?.runtime ?? getDetachedTaskLifecycleRuntime();
  const create = runtime.createQueuedTaskRun.bind(runtime);
  const finalize = runtime.finalizeTaskRunByRunId?.bind(runtime);
  const fail = runtime.failTaskRunByRunId.bind(runtime);
  let assertBackendCurrent: () => void;
  if (registration) {
    const pluginId = registration.pluginId;
    const record = registry.plugins.find((candidate) => candidate.id === pluginId);
    if (!record) {
      throw new Error("Queued subagent task runtime has no plugin owner");
    }
    const authority = capturePluginLifecycleAuthority(
      getPluginRecordRegistry(registry, record),
      record,
    );
    assertBackendCurrent = () => {
      const owner = getPluginRecordRegistry(registry, record);
      if (
        !authority?.() ||
        !owner.detachedTaskRuntimes.some(
          (candidate) => candidate.pluginId === pluginId && candidate.runtime === runtime,
        )
      ) {
        throw new Error("Queued subagent task runtime owner is no longer active");
      }
    };
  } else {
    const store = getTaskRegistryStore();
    const flowStore = getTaskFlowRegistryStore();
    assertBackendCurrent = () => {
      // A newly selected plugin cannot retarget an already captured core operation.
      if (getTaskRegistryStore() !== store || getTaskFlowRegistryStore() !== flowStore) {
        throw new Error("Queued subagent task stores are no longer current");
      }
    };
  }
  const assertCurrent = () => {
    assertRunCurrent();
    assertBackendCurrent();
  };
  const invoke = <T>(operation: () => T): T => {
    assertCurrent();
    if (registration) {
      return operation();
    }
    return withTaskRegistryMutation(() => {
      // A cold restore or coordinator admission can synchronously retire this run.
      assertCurrent();
      return operation();
    });
  };
  assertCurrent();
  return {
    assertCurrent,
    create() {
      // Publication observers may retire the run after its task commits.
      return invoke(() => create(params));
    },
    finalize(taskId, endedAt, error) {
      const selectedTaskId = taskId.trim();
      if (!selectedTaskId) {
        throw new Error("Queued subagent task settlement requires an exact task ID");
      }
      const terminal = {
        taskId: selectedTaskId,
        runId,
        runtime: "subagent" as const,
        sessionKey,
        status: "failed" as const,
        endedAt,
        lastEventAt: endedAt,
        error,
        suppressDelivery: true,
      };
      return invoke(() => (finalize ? finalize(terminal) : fail(terminal)));
    },
  };
}
