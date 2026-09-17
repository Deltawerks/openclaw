import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import type { AppSidebarSessionNavigationElement } from "../components/app-sidebar-session-navigation.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it.each([
    { operation: "rename", filter: "Active" },
    { operation: "batch archive", filter: "Active" },
    { operation: "rename", filter: "All" },
    { operation: "batch archive", filter: "All" },
  ] as const)(
    "keeps $filter rows, pagination, and updates after another agent's $operation settles",
    async ({ operation, filter }) => {
      const artifactDir = createControlUiE2eArtifactDir("session-mutation-scope");
      const context = await suite.browser.newContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      const original = sessionRow("agent:main:rename-cross-agent", "Original name", 3);
      const batch = [original, sessionRow("agent:main:batch-sibling", "Batch sibling", 2)];
      const mainRows = [sessionRow("agent:main:main", "Main", 1), ...batch];
      const pageSize = SIDEBAR_SESSION_ROSTER_LIMIT;
      const researchRows = [
        sessionRow("agent:research:main", "Research", pageSize + 4),
        sessionRow("agent:research:first", "Research first", pageSize + 3),
        ...Array.from({ length: pageSize - 2 }, (_, index) =>
          sessionRow(
            `agent:research:page-${index}`,
            `Research page ${index}`,
            pageSize + 2 - index,
          ),
        ),
        sessionRow("agent:research:second", "Research second", 2),
      ];
      const lastResearch = researchRows.at(-1)!;
      const responseFor = (rows: typeof researchRows) => ({
        cases: [
          {
            match: { agentId: "research", offset: pageSize },
            response: {
              ...sessionsListResponse(rows.slice(pageSize), {
                offset: pageSize,
                totalCount: rows.length,
              }),
              limitApplied: pageSize,
            },
          },
          {
            // Replacements retain every loaded page; returning page one would hide appended rows.
            match: { agentId: "research", limit: rows.length },
            response: { ...sessionsListResponse(rows), limitApplied: rows.length },
          },
          {
            match: { agentId: "research" },
            response: {
              ...sessionsListResponse(rows.slice(0, pageSize), {
                hasMore: true,
                nextOffset: pageSize,
                totalCount: rows.length,
              }),
              limitApplied: pageSize,
            },
          },
          { response: sessionsListResponse(mainRows) },
        ],
      });
      const gateway = await installMockGateway(page, {
        sessions: [...mainRows, ...researchRows],
        sessionKey: original.key,
        sessionArchiveFiltering: true,
        methodResponses: {
          "agents.list": {
            agents: [
              { id: "main", name: "Main" },
              { id: "research", name: "Research" },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "sessions.list": responseFor(researchRows),
        },
      });
      const sidebar = page.locator("openclaw-app-sidebar");
      const rowFor = (key: string) =>
        sidebar.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      const hasResearchRow = (key: string) =>
        page.evaluate((target) => {
          const data =
            document.querySelector<AppSidebarSessionNavigationElement>(
              "openclaw-app-sidebar",
            )?.sessionData;
          return data?.sessionsResult?.sessions.some((row) => row.key === target) ?? false;
        }, key);
      const revealResearchRow = async (key: string) => {
        await expect.poll(() => hasResearchRow(key)).toBe(true);
        const rows = sidebar.locator(".sidebar-recent-session");
        for (let remaining = researchRows.length; remaining > 0; remaining -= 1) {
          if (await rowFor(key).count()) {
            break;
          }
          const before = await rows.count();
          await sidebar.getByRole("button", { name: "Show more", exact: true }).click();
          await expect.poll(() => rows.count()).toBeGreaterThan(before);
        }
        await rowFor(key).scrollIntoViewIfNeeded();
        await rowFor(key).waitFor({ state: "visible" });
      };
      const capture = (stage: string) =>
        page.screenshot({ path: path.join(artifactDir, `${stage}.png`) });
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, original.key));
        await rowFor(original.key).waitFor({ state: "visible" });
        if (filter === "All") {
          await sidebar.getByRole("button", { name: "Filter & sort" }).click();
          await page
            .locator(".sidebar-session-sort-menu")
            .getByRole("menuitemradio", { name: filter, exact: true })
            .click();
          await gateway.waitForRequest("sessions.list", {
            match: { agentId: "main", archived: "all" },
          });
        }
        const method = operation === "rename" ? "sessions.patch" : "sessions.patchMany";
        await gateway.deferNext(method);
        if (operation === "rename") {
          if (filter === "All") {
            await rowFor(original.key).click({ button: "right" });
            await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();
          } else {
            await page.locator(".chat-pane__session-title-button").click();
          }
          const input = page.locator(
            filter === "All"
              ? 'openclaw-modal-dialog[label="Rename session"] input'
              : ".chat-pane__session-title-input",
          );
          await input.fill("Renamed original");
          await input.press("Enter");
          const request = await waitForPatch(
            gateway,
            (params) => params.label === "Renamed original",
          );
          expect(request.params).toMatchObject({
            key: original.key,
            expectedSessionId: original.sessionId,
          });
        } else {
          for (const row of batch) {
            await rowFor(row.key).click({ modifiers: ["Alt"] });
          }
          await rowFor(original.key).click({ button: "right" });
          await page
            .locator("openclaw-session-menu")
            .getByRole("menuitem", { name: "Archive 2", exact: true })
            .waitFor({ state: "visible" });
          await page.keyboard.press("A");
          const request = await gateway.waitForRequest(method);
          expect(request.params).toMatchObject({
            patch: { archived: true },
            targets: batch.map((row) => ({
              key: row.key,
              agentId: "main",
              expectedSessionId: row.sessionId,
            })),
          });
        }
        await sidebar.getByRole("button", { name: /Switch agent/ }).click();
        await sidebar
          .locator("wa-dropdown.sidebar-agent-menu")
          .getByRole("menuitemradio", { name: "Research", exact: true })
          .click();
        await rowFor(researchRows[1]!.key).waitFor({ state: "visible" });
        await sidebar
          .getByRole("button", { name: "Load more sessions", exact: true })
          .waitFor({ state: "visible" });
        await capture("before-mutation-response");
        const listsBefore = (
          await gateway.getRequests("sessions.list", { agentId: "main", includeGlobal: true })
        ).length;
        await gateway.deferNext("sessions.list", { agentId: "main", includeGlobal: true });
        const filteredMatch = { agentId: "research", archived: "all" };
        const filteredReadsBefore = (await gateway.getRequests("sessions.list", filteredMatch))
          .length;
        await gateway.resolveDeferred(method);
        await gateway.waitForRequest("sessions.list", {
          after: listsBefore,
          match: { agentId: "main", includeGlobal: true },
        });
        await gateway.resolveDeferred("sessions.list");
        if (operation === "batch archive") {
          await expect
            .poll(() => page.locator(".app-toast").textContent())
            .toContain("Archived 2 sessions");
        }
        await capture("after-mutation-response");
        if (filter === "All") {
          expect(await gateway.getRequests("sessions.list", filteredMatch)).toHaveLength(
            filteredReadsBefore,
          );
        }
        await rowFor(researchRows[1]!.key).waitFor({ state: "visible" });
        const newRow = sessionRow(
          "agent:research:new-after-completion",
          "Research new after completion",
          pageSize + 5,
        );
        await gateway.setMethodResponse("sessions.list", responseFor([newRow, ...researchRows]));
        const researchMatch = {
          agentId: "research",
          ...(filter === "All" ? { archived: "all" } : {}),
        };
        const readsBeforeEvent = (await gateway.getRequests("sessions.list", researchMatch)).length;
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: newRow.key,
          agentId: "research",
          reason: "create",
        });
        await gateway.waitForRequest("sessions.list", {
          match: researchMatch,
          after: readsBeforeEvent,
        });
        await revealResearchRow(newRow.key);
        await capture("after-selected-agent-update");
        await sidebar.getByRole("button", { name: "Load more sessions", exact: true }).click();
        await gateway.waitForRequest("sessions.list", {
          match: { agentId: "research", offset: pageSize },
        });
        await revealResearchRow(lastResearch.key);
        await capture("after-pagination");
        await sidebar.getByRole("button", { name: /Switch agent/ }).click();
        await sidebar
          .locator("wa-dropdown.sidebar-agent-menu")
          .getByRole("menuitemradio", { name: "Main", exact: true })
          .click();
        if (operation === "rename") {
          await expect.poll(() => rowFor(original.key).textContent()).toContain("Renamed original");
        } else if (filter === "Active") {
          await expect.poll(() => rowFor(original.key).count()).toBe(0);
        } else {
          await rowFor(original.key).waitFor({ state: "visible" });
        }
        await sidebar.getByRole("button", { name: /Switch agent/ }).click();
        await sidebar
          .locator("wa-dropdown.sidebar-agent-menu")
          .getByRole("menuitemradio", { name: "Research", exact: true })
          .click();
        await revealResearchRow(newRow.key);
        if (!(await hasResearchRow(lastResearch.key))) {
          await sidebar.getByRole("button", { name: "Load more sessions", exact: true }).click();
        }
        await revealResearchRow(lastResearch.key);
      } finally {
        await capture("final-state");
        await writeFile(
          path.join(artifactDir, "observations.json"),
          JSON.stringify(
            {
              url: page.url(),
              rows: await sidebar.locator(".sidebar-recent-session").allTextContents(),
              listRequests: (await gateway.getRequests("sessions.list")).map(
                ({ params }) => params,
              ),
              patchRequests: (await gateway.getRequests("sessions.patch")).map(
                ({ params }) => params,
              ),
              batchRequests: (await gateway.getRequests("sessions.patchMany")).map(
                ({ params }) => params,
              ),
            },
            null,
            2,
          ),
        );
        await context.close();
      }
    },
  );
});
