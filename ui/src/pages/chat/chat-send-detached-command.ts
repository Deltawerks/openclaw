import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { isTerminalFailureChatSendAck } from "./chat-send-ack.ts";
import { sendChatMessageWithGeneratedRunId } from "./chat-send-actions.ts";
import {
  clearOwnedCommandComposerFallback,
  commandComposerFallbackRetainsAttachments,
  releaseCommandComposerAttachments,
  restoreFailedCommandComposer,
  submittedCommandConnectionIsCurrent,
  submittedCommandScopeIsVisible,
  type ChatCommandComposerRecovery,
} from "./chat-send-composer.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { setChatError } from "./chat-send-queue-state.ts";
import { formatTerminalChatSendAckError } from "./chat-send-support.ts";

export async function sendDetachedCommandMessage(
  host: ChatHost,
  message: string,
  opts: {
    attachments?: ChatAttachment[];
    recovery: ChatCommandComposerRecovery;
    runId?: string;
  },
) {
  const ack = await sendChatMessageWithGeneratedRunId(host, message, opts?.attachments, {
    canApplyError: () => submittedCommandScopeIsVisible(host, opts.recovery),
    runId: opts.runId,
  });
  const sendAck = ack && !("kind" in ack) ? ack : null;
  const ok =
    sendAck?.status === "ok" || sendAck?.status === "started" || sendAck?.status === "in_flight";
  if (!ok && !restoreFailedCommandComposer(host, opts.recovery)) {
    releaseCommandComposerAttachments(host, opts.recovery, opts.attachments);
  }
  if (
    isTerminalFailureChatSendAck(sendAck) &&
    submittedCommandScopeIsVisible(host, opts.recovery)
  ) {
    setChatError(host, formatTerminalChatSendAckError(sendAck, "detached"));
  }
  if (ok) {
    if (submittedCommandConnectionIsCurrent(host, opts.recovery)) {
      clearOwnedCommandComposerFallback(host, opts.recovery);
    }
    if (!commandComposerFallbackRetainsAttachments(host, opts.recovery)) {
      releaseCommandComposerAttachments(host, opts.recovery, opts.attachments);
    }
  }
}
