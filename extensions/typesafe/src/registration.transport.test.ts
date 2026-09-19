import type { JudgmentBatch, JudgmentProviderV1 } from "openclaw/plugin-sdk/judgments";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "../index.js";

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  getPreparedPluginSecretInput: vi.fn(),
}));

const batch: JudgmentBatch = {
  state: { evidence: "synthetic only" },
  questions: {
    q: { type: "boolean", instructions: "Does the evidence satisfy the criterion?" },
    c: { type: "choice", criteria: { keep: "Keep", skip: "Skip" } },
    s: { type: "score", criteria: ["Low", "High"] },
  },
};
const response = {
  model: "jev-test",
  answers: {
    q: { type: "noul", noul: 0.37 },
    c: { type: "choice", choice: "keep", confidence: 0.5, probabilities: { keep: 0.8, skip: 0.2 } },
    s: {
      type: "score",
      score: 0.6,
      confidence: 0.5,
      probabilities: { 0: 0.4, 1: 0.6 },
      legend: { 0: "Low", 1: "High" },
    },
  },
  usage: { input_tokens: 12, output_tokens: 3 },
};

function registeredProvider(): JudgmentProviderV1 {
  const registerJudgmentProvider = vi.fn<OpenClawPluginApi["registerJudgmentProvider"]>();
  plugin.register({
    runtime: { config: { current: () => ({}) } },
    registerTool: vi.fn(),
    registerJudgmentProvider,
  } as unknown as OpenClawPluginApi);
  return registerJudgmentProvider.mock.calls[0]![0];
}

beforeEach(() => {
  vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 1, value: "synthetic-key" });
});
afterEach(() => vi.unstubAllGlobals());

it("runs the registered provider through the real SDK transport and back to host judgments", async () => {
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(response)),
  );
  vi.stubGlobal("fetch", fetch);
  const provider = registeredProvider();
  await expect(
    provider.evaluate(batch, {
      signal: new AbortController().signal,
      deadlineMonotonicMs: performance.now() + 1000,
    }),
  ).resolves.toEqual({
    status: "ok",
    result: {
      model: "jev-test",
      answers: {
        q: { type: "boolean", probabilityTrue: 0.37 },
        c: response.answers.c,
        s: { type: "score", score: 0.6, confidence: 0.5, probabilities: [0.4, 0.6] },
      },
      usage: { inputTokens: 12, outputTokens: 3 },
    },
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]![0]).toBe("https://api.typesafe.ai/v1/systemone");
  const body = fetch.mock.calls[0]![1]?.body;
  if (typeof body !== "string") {
    throw new Error("Expected serialized JSON request body");
  }
  expect(JSON.parse(body)).toEqual({
    ...batch,
    questions: { ...batch.questions, q: { ...batch.questions.q, type: "noul" } },
    model: "jev-latest",
  });
});

it("rejects the complete registered batch when the service contradicts its choice", async () => {
  const invalid = structuredClone(response);
  invalid.answers.c.choice = "skip";
  const fetch = vi.fn(async () => new Response(JSON.stringify(invalid)));
  vi.stubGlobal("fetch", fetch);
  await expect(
    registeredProvider().evaluate(batch, {
      signal: new AbortController().signal,
      deadlineMonotonicMs: performance.now() + 1000,
    }),
  ).resolves.toEqual({ status: "unavailable", reason: "invalid-response" });
  expect(fetch).toHaveBeenCalledOnce();
});

it("does not dispatch when prepared credentials disappear or caller authority is canceled", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const provider = registeredProvider();
  const controller = new AbortController();
  const context = { signal: controller.signal, deadlineMonotonicMs: performance.now() + 1000 };
  vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 2 });
  await expect(provider.evaluate(batch, context)).resolves.toEqual({
    status: "unavailable",
    reason: "credentials-unavailable",
  });
  controller.abort(new Error("caller closed"));
  await expect(provider.evaluate(batch, context)).rejects.toThrow("caller closed");
  expect(fetch).not.toHaveBeenCalled();
});
