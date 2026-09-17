import type { ChannelMessagingAdapter } from "../channels/plugins/types.public.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";

const resolveSessionConversationStub: NonNullable<
  ChannelMessagingAdapter["resolveSessionConversation"]
> = ({ rawId }) => ({
  id: rawId,
});
const resolveSessionTargetStub: NonNullable<ChannelMessagingAdapter["resolveSessionTarget"]> = ({
  kind,
  id,
  threadId,
}) => (threadId ? `${kind}:${id}:thread:${threadId}` : `${kind}:${id}`);

export function createMessagingTestRegistry() {
  // Registry stubs expose enough channel target resolution for session-send tests.
  return createTestRegistry([
    {
      pluginId: "discord",
      source: "test",
      plugin: {
        id: "discord",
        meta: {
          id: "discord",
          label: "Discord",
          selectionLabel: "Discord",
          docsPath: "/channels/discord",
          blurb: "Discord test stub.",
        },
        capabilities: { chatTypes: ["direct", "channel", "thread"] },
        messaging: {
          resolveSessionConversation: resolveSessionConversationStub,
          resolveSessionTarget: resolveSessionTargetStub,
        },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
      },
    },
    {
      pluginId: "whatsapp",
      source: "test",
      plugin: {
        id: "whatsapp",
        meta: {
          id: "whatsapp",
          label: "WhatsApp",
          selectionLabel: "WhatsApp",
          docsPath: "/channels/whatsapp",
          blurb: "WhatsApp test stub.",
          preferSessionLookupForAnnounceTarget: true,
        },
        capabilities: { chatTypes: ["direct", "group"] },
        messaging: {
          resolveSessionConversation: resolveSessionConversationStub,
          resolveSessionTarget: resolveSessionTargetStub,
        },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
      },
    },
  ]);
}
