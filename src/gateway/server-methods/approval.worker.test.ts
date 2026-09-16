import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, it, expect, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { bumpGatewayAccessRevision } from "../gateway-access-revision.js";
import * as operatorApprovalStore from "../operator-approval-store.async.js";
import { createApprovalHandlers } from "./approval.js";
import { createClient, createContext, invoke } from "./approval.test-support.js";

function createFixture() {
  const persistence = { runtimeEpoch: "deferred-lookup-test" };
  const managers = {
    exec: new ExecApprovalManager({ persistence }),
    plugin: new ExecApprovalManager<PluginApprovalRequestPayload>({ persistence }),
    systemAgent: new ExecApprovalManager<SystemAgentApprovalRequestPayload>({ persistence }),
  };
  const handlers = createApprovalHandlers({
    execApprovalManager: managers.exec,
    pluginApprovalManager: managers.plugin,
    systemAgentApprovalManager: managers.systemAgent,
  });
  return { managers, handlers };
}

afterEach(() => vi.restoreAllMocks());

it.each([
  { method: "approval.get" as const, rejects: false },
  { method: "approval.get" as const, rejects: true },
  { method: "approval.resolve" as const, rejects: false },
  { method: "approval.resolve" as const, rejects: true },
])(
  "does not reconcile revoked access after $method storage wait (rejects=$rejects)",
  async ({ method, rejects }) => {
    const { managers, handlers } = createFixture();
    const started = createDeferred();
    const lookup =
      createDeferred<
        Awaited<ReturnType<typeof operatorApprovalStore.getOperatorApprovalDetailed>>
      >();
    vi.spyOn(operatorApprovalStore, "getOperatorApprovalDetailed").mockImplementation(() => {
      started.resolve();
      return lookup.promise;
    });
    const reconciliations = [managers.exec, managers.plugin, managers.systemAgent].map((manager) =>
      vi.spyOn(manager, "reconcileDurableLookup"),
    );
    const client = createClient({ deviceId: "reviewer" });
    if (!client) {
      throw new Error("expected fixture client");
    }
    const pending = invoke({
      handlers,
      method,
      body:
        method === "approval.get"
          ? { id: "revoked-lookup" }
          : { id: "revoked-lookup", kind: "exec", decision: "allow-once" },
      client,
    });
    await started.promise;
    client.connect.scopes = [];
    if (rejects) {
      lookup.reject(new Error("controlled lookup failure"));
    } else {
      lookup.resolve({ outcome: "not-found" });
    }
    expect(await pending).toMatchObject({ ok: false, error: { message: "approval not found" } });
    for (const reconcile of reconciliations) {
      expect(reconcile).not.toHaveBeenCalled();
    }
  },
);

it("keeps an unknown worker lookup outcome out of corruption reconciliation", async () => {
  const { managers, handlers } = createFixture();
  vi.spyOn(operatorApprovalStore, "getOperatorApprovalDetailed").mockRejectedValue(
    new AggregateError([new SqliteWorkerError("controlled unknown lookup", "outcome-unknown")]),
  );
  const reconciliations = [managers.exec, managers.plugin, managers.systemAgent].map((manager) =>
    vi.spyOn(manager, "reconcileDurableLookup"),
  );
  const response = await invoke({
    handlers,
    method: "approval.get",
    body: { id: "unknown-lookup" },
    client: createClient({ deviceId: "reviewer" }),
  });
  expect(response).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
  for (const reconcile of reconciliations) {
    expect(reconcile).not.toHaveBeenCalled();
  }
});

it.each(["scope", "invalidated", "aborted"] as const)(
  "does not publish history after %s revocation during its storage wait",
  async (change) => {
    const { handlers } = createFixture();
    const started = createDeferred();
    const history =
      createDeferred<
        Awaited<ReturnType<typeof operatorApprovalStore.listTerminalOperatorApprovals>>
      >();
    vi.spyOn(operatorApprovalStore, "listTerminalOperatorApprovals").mockImplementation(() => {
      started.resolve();
      return history.promise;
    });
    const client = createClient({ deviceId: "reviewer" });
    if (!client) {
      throw new Error("expected fixture client");
    }
    const controller = new AbortController();
    client.connectionSignal = controller.signal;
    const pending = invoke({ handlers, method: "approval.history", body: {}, client });
    await started.promise;
    if (change === "scope") {
      client.connect.scopes = [];
    } else if (change === "invalidated") {
      client.invalidated = true;
    } else {
      controller.abort();
    }
    history.resolve({ records: [] });
    expect(await pending).toMatchObject({ ok: false, error: { message: "approval not found" } });
  },
);

it("preserves history access for approval-scoped clients without a device", async () => {
  const { handlers } = createFixture();
  vi.spyOn(operatorApprovalStore, "listTerminalOperatorApprovals").mockResolvedValue({
    records: [],
  });
  const response = await invoke({
    handlers,
    method: "approval.history",
    body: {},
    client: createClient({}),
  });
  expect(response).toMatchObject({ ok: true, result: { items: [] } });
});

it.each(["access", "reviewer", "source", "binding", "profile", "config"] as const)(
  "refuses %s changes at lookup admission without corruption reconciliation",
  async (change) => {
    const { managers, handlers } = createFixture();
    const record = managers.exec.create(
      { command: "echo fixture", sessionKey: "agent:main:fixture" },
      60_000,
    );
    record.approvalReviewerDeviceIds = ["reviewer"];
    const live = vi.spyOn(managers.exec, "getLiveSnapshot").mockReturnValue(record);
    const binding = vi.spyOn(managers.exec, "hasRegisteredRecord").mockReturnValue(true);
    const reconcile = vi.spyOn(managers.exec, "reconcileDurableLookup");
    const started = createDeferred<() => void>();
    const lookup =
      createDeferred<
        Awaited<ReturnType<typeof operatorApprovalStore.getOperatorApprovalDetailed>>
      >();
    vi.spyOn(operatorApprovalStore, "getOperatorApprovalDetailed").mockImplementation((params) => {
      started.resolve(expectDefined(params.assertCurrent, "lookup admission guard"));
      return lookup.promise;
    });
    const client = expectDefined(createClient({ deviceId: "reviewer" }), "fixture client");
    const context = createContext();
    const pending = invoke({
      handlers,
      method: "approval.get",
      body: { id: record.id },
      client,
      context,
    });
    const guard = await started.promise;
    switch (change) {
      case "access":
        bumpGatewayAccessRevision();
        break;
      case "reviewer":
        record.approvalReviewerDeviceIds = ["other-reviewer"];
        break;
      case "source":
        record.request.sessionKey = "agent:main:other";
        break;
      case "binding":
        live.mockReturnValue(null);
        binding.mockReturnValue(false);
        break;
      case "profile":
        client.authenticatedUserId = "other-user";
        break;
      case "config":
        context.getRuntimeConfig = () => ({});
        break;
    }
    expect(guard).toThrow("Approval lookup authority is no longer active");
    lookup.reject(new Error("controlled admission refusal"));
    expect(await pending).toMatchObject({ ok: false, error: { message: "approval not found" } });
    expect(reconcile).not.toHaveBeenCalled();
  },
);
