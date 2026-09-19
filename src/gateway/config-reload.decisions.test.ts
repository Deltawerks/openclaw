import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { diffGatewayReloadPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
} from "./config-reload-plan.js";

beforeEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));
afterEach(() => resetPluginRuntimeStateForTest());

describe("decision model reload planning", () => {
  it.each<{ name: string; previous: OpenClawConfig; next: OpenClawConfig }>([
    {
      name: "adds an agent",
      previous: { agents: { entries: {} } },
      next: { agents: { entries: { worker: { decisionModel: "fixture/fast" } } } },
    },
    {
      name: "removes an agent",
      previous: { agents: { entries: { worker: { decisionModel: "fixture/fast" } } } },
      next: { agents: { entries: {} } },
    },
  ])(
    "preserves roster actions and reloads provider selection when it $name",
    ({ previous, next }) => {
      const paths = diffGatewayReloadPaths(previous, next, listConfigReloadRefinementPrefixes());
      expect(buildGatewayReloadPlan(paths)).toMatchObject({
        restartGateway: false,
        reloadPlugins: true,
        refreshHooksPolicy: true,
        reloadInternalHooks: true,
        restartHeartbeat: true,
      });
    },
  );

  it.each([
    { path: "agents.defaults.decisionModel", expected: { reloadPlugins: true } },
    {
      path: "agents.entries.worker.decisionModel",
      expected: { reloadPlugins: true, refreshHooksPolicy: true, reloadInternalHooks: true },
    },
  ])("hot-applies $path", ({ path, expected }) => {
    expect(buildGatewayReloadPlan([path])).toMatchObject({ restartGateway: false, ...expected });
  });
});
