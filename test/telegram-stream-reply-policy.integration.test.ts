import { AssistantMessageEventStream, type Message, type Model } from "openclaw/plugin-sdk/llm";
import { expect, it, vi } from "vitest";
import {
  createContext,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  telegramDepsForTest,
} from "../extensions/telegram/src/bot-message-dispatch.test-harness.js";
import { consumeGoogleGenerateContentStream } from "../packages/ai/src/providers/google-stream.js";
import { createAssistantOutput } from "../packages/ai/src/transports/assistant-output.js";
import { createSubscribedSessionHarness } from "../src/agents/embedded-agent-subscribe.e2e-harness.js";
import { createReplyTurnLedger } from "../src/auto-reply/reply/dispatch-from-config.turn-ledger.js";
import { createBlockReplyDeliveryHandler } from "../src/auto-reply/reply/reply-delivery.js";
import { createReplyDispatcher } from "../src/auto-reply/reply/reply-dispatcher.js";
import { createReplyToModeFilterForChannel } from "../src/auto-reply/reply/reply-threading.js";
import { createTypingSignaler } from "../src/auto-reply/reply/typing-mode.js";
import { createTypingController } from "../src/auto-reply/reply/typing.js";
import { runAgentLoop } from "../src/plugin-sdk/agent-core.js";
import { telegramReplyTarget, withTelegramReplyApi } from "./helpers/telegram-reply-api.js";
const realTelegram = await vi.importActual<
  typeof import("../extensions/telegram/src/bot/delivery.replies.js")
>("../extensions/telegram/src/bot/delivery.replies.js");
const model: Model<"google-generative-ai"> = {
  id: "gemini-2.5-flash",
  name: "Gemini 2.5 Flash",
  api: "google-generative-ai",
  provider: "google",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};
describeTelegramDispatch("generic cumulative reply intent", () => {
  it.each([
    { mode: "first", current: false },
    { mode: "first", current: true },
    { mode: "batched", current: false },
    { mode: "batched", current: true },
    { mode: "all", current: false },
    { mode: "all", current: true },
  ] as const)("$mode / current=$current", async ({ mode, current }) => {
    let blockCount = 0;
    const settled: Array<string | undefined> = [];
    await withTelegramReplyApi(async ({ bot, calls }) => {
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        const typing = createTypingController({});
        const dispatcher = createReplyDispatcher(dispatcherOptions);
        const ledger = createReplyTurnLedger(dispatcher);
        const handler = createBlockReplyDeliveryHandler({
          onBlockReply: async (payload) => {
            blockCount += 1;
            const send = ledger.sendQueued("block", payload);
            expect(send.queued).toBe(true);
            settled.push(await send.outcome);
          },
          currentMessageId: "456",
          replyThreading: { implicitCurrentMessage: "deny" },
          normalizeStreamingText: (payload) => ({
            text: payload.text,
            skip: !payload.text?.trim(),
          }),
          applyReplyToMode: createReplyToModeFilterForChannel(mode, "telegram"),
          typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
          blockStreamingEnabled: true,
          blockReplyPipeline: null,
          directBlockDeliveries: [],
        });
        const { emit, subscription } = createSubscribedSessionHarness({
          runId: "reply-target-rearm",
          onBlockReply: handler,
          blockReplyBreak: "text_end",
          blockReplyChunking: { minChars: 1, maxChars: 150, breakPreference: "paragraph" },
        });
        const chunks = [
          `${current ? "[[reply_to_current]]" : "[[reply_to:42]]"}First paragraph provides enough content to emit separately.\n\n`,
          "Second paragraph continues without another authored reply directive.\n\n",
          "Third paragraph finishes the answer without a reply directive.\n\n",
        ];
        const response = new AssistantMessageEventStream();
        const output = createAssistantOutput(model);
        async function* events() {
          for (const text of chunks) {
            yield { candidates: [{ content: { parts: [{ text }] } }] };
          }
          yield { candidates: [{ finishReason: "STOP" }] };
        }
        const producing = consumeGoogleGenerateContentStream({
          chunks: events(),
          model,
          output,
          stream: response,
          profile: "managed",
          nextToolCallId: () => "unused",
        });
        try {
          await runAgentLoop(
            [{ role: "user", content: "Return three paragraphs.", timestamp: 1 }],
            { systemPrompt: "", messages: [] },
            {
              model,
              convertToLlm: (messages) =>
                messages.filter(
                  (message): message is Message =>
                    message.role === "user" ||
                    message.role === "assistant" ||
                    message.role === "toolResult",
                ),
            },
            async (event) => {
              emit(event);
              await subscription.waitForPendingEvents();
            },
            undefined,
            () => response,
          );
          await producing;
          await subscription.waitForPendingEvents();
          return { queuedFinal: false, counts: { block: blockCount, final: 0, tool: 0 } };
        } finally {
          await producing;
          await subscription.waitForPendingEvents();
          subscription.unsubscribe();
          typing.markRunComplete();
          dispatcher.markComplete();
          await dispatcher.waitForIdle();
        }
      });
      const context = createContext();
      context.ctxPayload.MessageSid = "456";
      await dispatchWithContext({
        context,
        bot,
        replyToMode: mode,
        streamMode: "off",
        telegramDeps: {
          ...telegramDepsForTest,
          deliverReplies: realTelegram.deliverReplies,
          deliverStructuredReplies: realTelegram.deliverStructuredReplies,
          deliverStructuredInboundReplyWithMessageSendContext: undefined,
        },
      });
      const sends = calls.filter(
        (x) => x.method === "sendMessage" || x.method === "sendRichMessage",
      );
      const targets = sends.map((x) => telegramReplyTarget(x));
      expect(sends.map((send) => send.fields.text)).toEqual([
        "First paragraph provides enough content to emit separately.",
        "Second paragraph continues without another authored reply directive.",
        "Third paragraph finishes the answer without a reply directive.",
      ]);
      expect(settled).toEqual(["delivered", "delivered", "delivered"]);
      const target = current ? 456 : 42;
      expect(targets).toEqual(mode === "all" ? [target, target, target] : [target, null, null]);
    });
  });
});
