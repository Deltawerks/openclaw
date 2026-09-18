import { vi, type Mock } from "vitest";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";

const emptyPluginIndex: PluginMetadataSnapshot["index"] = {
  version: 1,
  hostContractVersion: "test",
  compatRegistryVersion: "test",
  migrationVersion: 1,
  policyHash: "",
  generatedAtMs: 1,
  installRecords: {},
  plugins: [],
  diagnostics: [],
};
export const emptyPluginMetadataSnapshot: PluginMetadataSnapshot = {
  policyHash: "",
  index: emptyPluginIndex,
  registryIndex: emptyPluginIndex,
  registryDiagnostics: [],
  manifestRegistry: { plugins: [], diagnostics: [] },
  plugins: [],
  diagnostics: [],
  byPluginId: new Map(),
  normalizePluginId: (pluginId: string) => pluginId,
  declaredProviderOwners: new Map(),
  owners: {
    channels: new Map(),
    channelConfigs: new Map(),
    providers: new Map(),
    modelCatalogProviders: new Map(),
    cliBackends: new Map(),
    setupProviders: new Map(),
    commandAliases: new Map(),
    contracts: new Map(),
    modelIdNormalizationPolicies: new Map(),
  },
  metrics: {
    registrySnapshotMs: 0,
    manifestRegistryMs: 0,
    ownerMapsMs: 0,
    totalMs: 0,
    indexPluginCount: 0,
    manifestPluginCount: 0,
  },
};

export const getCurrentPluginMetadataSnapshotMock: Mock<
  typeof import("../../plugins/current-plugin-metadata-snapshot.js").getCurrentPluginMetadataSnapshot
> = vi.fn(() => emptyPluginMetadataSnapshot);

/** Register metadata mocks after the compaction harness resets modules. */
export function mockCompactPluginMetadata(): void {
  vi.doMock("../../plugins/current-plugin-metadata-snapshot.js", () => ({
    getCurrentPluginMetadataSnapshot: getCurrentPluginMetadataSnapshotMock,
    isCurrentPluginMetadataSnapshotRuntimeGeneration: () => false,
    resolvePluginMetadataControlPlaneFingerprint: vi.fn(() => "test-plugin-fingerprint"),
    withPluginMetadataSnapshotScope: (_snapshot: unknown, run: () => unknown) => run(),
    runOutsidePluginMetadataSnapshotScope: <T>(run: () => T): T => run(),
  }));
}
