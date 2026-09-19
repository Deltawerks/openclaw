import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Collaborator transcript scroll" });

suite.define(() => {
  it.each(["following", "reading"] as const)(
    "keeps the viewport stable when a collaborator sends a follow-up while %s",
    async (mode) => {
      await suite.withPage(
        { viewport: { width: 1200, height: 900 }, colorScheme: "dark" },
        async ({ page }) => {
          const sessionKey = "agent:main:dashboard:collaborator-scroll";
          const runId = "active-review";
          const now = Date.now() - 60_000;
          const history = [
            {
              role: "user",
              content: "Inspect the workspace and explain your findings.",
              timestamp: now,
              __openclaw: { id: "original-user", idempotencyKey: runId + ":user", seq: 1 },
            },
            ...Array.from({ length: 12 }, (_, index) => ({
              role: "assistant",
              phase: "commentary",
              content: [
                {
                  type: "text",
                  text:
                    "Finding " +
                    (index + 1) +
                    ": " +
                    "The workspace is organized into independent components. ".repeat(5),
                },
              ],
              timestamp: now + index + 1,
              __openclaw: { id: "finding-" + index, runId, seq: index + 2 },
            })),
            {
              role: "toolResult",
              toolCallId: "workspace-check",
              toolName: "exec",
              content: [{ type: "text", text: "Workspace check completed" }],
              timestamp: now + 15_000,
              __openclaw: { id: "workspace-check", runId, seq: 15 },
            },
          ];
          const session = {
            key: sessionKey,
            kind: "direct",
            status: "running",
            activeRunIds: [runId],
            hasActiveRun: true,
            updatedAt: now,
          };
          const gateway = await installMockGateway(page, {
            sessionKey,
            historyMessages: history,
            inFlightRun: { runId, text: "" },
            sessionInfo: session,
            sessions: [session],
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await page.locator(".chat-reading-indicator").waitFor();
          await waitForChatScrollIdle(page);
          const thread = page.locator(".chat-thread");
          if (mode === "reading") {
            await thread.hover();
            await page.mouse.wheel(0, -300);
            await waitForChatScrollIdle(page);
          }
          const artifacts = createControlUiE2eArtifactDir("collaborator-scroll-" + mode);
          await page.screenshot({ path: path.join(artifacts, "before-message.png") });
          const before = await thread.evaluate((element) => ({
            top: element.scrollTop,
            height: element.scrollHeight,
            frameKey: element.querySelector<HTMLElement>(
              '.chat-virtual-row[data-virtual-row-key^="agent-run:"]',
            )?.dataset.virtualRowKey,
          }));
          // Observe every animation frame, not only the eventual settled position.
          await thread.evaluate((element) => {
            const samples: number[] = [];
            let frame = 0;
            const sample = () => {
              samples.push(element.scrollTop);
              frame = requestAnimationFrame(sample);
            };
            Object.assign(element, {
              scrollSamples: samples,
              stopScrollSamples: () => cancelAnimationFrame(frame),
            });
            frame = requestAnimationFrame(sample);
          });
          const message = {
            role: "user",
            content: "Please also check the shared components.",
            timestamp: now + 20_000,
            __openclaw: {
              id: "collaborator-user",
              idempotencyKey: "collaborator-steer:user",
              seq: 20,
            },
          };
          await gateway.setHistoryMessages([...history, message]);
          const samplesBeforeEvent = await thread.evaluate(
            (element) =>
              (element as HTMLElement & { scrollSamples: number[] }).scrollSamples.length,
          );
          await gateway.emitGatewayEvent("session.message", {
            sessionKey,
            message,
            messageId: "collaborator-user",
            messageSeq: 20,
            hasActiveRun: true,
            activeRunIds: [runId],
            clientRunId: "collaborator-steer",
            session,
          });
          await page
            .getByText("Please also check the shared components.", { exact: true })
            .waitFor();
          await waitForChatScrollIdle(page);
          await page.screenshot({ path: path.join(artifacts, "after-message.png") });
          const after = await thread.evaluate((element) => {
            const sampling = element as HTMLElement & {
              scrollSamples: number[];
              stopScrollSamples: () => void;
            };
            sampling.stopScrollSamples();
            return {
              top: element.scrollTop,
              height: element.scrollHeight,
              samples: sampling.scrollSamples,
              keys: [...element.querySelectorAll<HTMLElement>(".chat-virtual-row")].map(
                (row) => row.dataset.virtualRowKey,
              ),
            };
          });
          console.log("COLLABORATOR_SCROLL", JSON.stringify({ mode, before, after }));
          expect(new Set(after.keys).size).toBe(after.keys.length);
          expect(after.keys[1]).toBe(before.frameKey);
          expect(after.samples.length).toBeGreaterThan(samplesBeforeEvent);
          // Appending below the reader may move toward the end, never overshoot
          // and snap back as two rows exchange the same cached measurement.
          for (let index = 1; index < after.samples.length; index += 1) {
            expect(after.samples[index]).toBeGreaterThanOrEqual(after.samples[index - 1]! - 1);
          }
          expect(Math.min(...after.samples)).toBeGreaterThanOrEqual(before.top - 1);
          if (mode === "reading") {
            expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1);
          } else {
            expect(
              await thread.evaluate(
                (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
              ),
            ).toBeLessThanOrEqual(8);
          }
        },
      );
    },
  );
});
