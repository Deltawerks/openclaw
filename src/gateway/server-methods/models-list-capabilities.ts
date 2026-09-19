import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listAvailableManifestContractPlugins } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolveModelProviderCapabilities } from "./model-provider-capabilities.js";

type ApiKeyProviderCapabilities = {
  providers: ReadonlyMap<string, boolean>;
  resolveProvider(provider: string): string;
};
export function apiKeyProviderCapabilities(params: {
  cfg: OpenClawConfig;
  metadataSnapshot: PluginMetadataSnapshot;
  workspaceDir: string;
}): ApiKeyProviderCapabilities {
  const { capabilities, resolveProvider } = resolveModelProviderCapabilities({
    config: params.cfg,
    metadataSnapshot: params.metadataSnapshot,
    workspaceDir: params.workspaceDir,
  });
  return {
    providers: new Map(
      capabilities.map(({ provider, apiKeySupported }) => [provider, apiKeySupported]),
    ),
    resolveProvider,
  };
}

export function listDecisionModels({
  config,
  snapshot,
  provider,
}: {
  config: OpenClawConfig;
  snapshot: PluginMetadataSnapshot;
  provider?: string;
}) {
  const decisionModels: NonNullable<ModelsListResult["decisionModels"]> = [];
  if (config.plugins?.enabled !== false) {
    const seen = new Set<string>();
    for (const plugin of listAvailableManifestContractPlugins({
      snapshot,
      config,
      contract: "decisionProviders",
    })) {
      for (const model of plugin.decisionModels ?? []) {
        const key = `${model.provider}/${model.id}`;
        if (provider && provider !== model.provider) {
          continue;
        }
        if (!seen.has(key)) {
          decisionModels.push({ ...model, pluginId: plugin.id });
          seen.add(key);
        }
      }
    }
  }
  return decisionModels;
}
