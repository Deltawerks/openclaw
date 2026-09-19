import { describe, expect, it, vi } from "vitest";
import { evaluate } from "./client.js";
import { runtimeConfig } from "./config.js";
import { MAX_JSON_BYTES, parseInput, parseResult } from "./schema.js";

const config = { apiKey: "synthetic-test-credential", model: "jev-test", timeoutMs: 1000 };
const input = {
  state: { text: "synthetic state" },
  questions: {
    route: { type: "choice", instructions: "Choose", criteria: { keep: "Keep", skip: "Skip" } },
    quality: { type: "score", instructions: "Rate", criteria: ["Low", "High"] },
    relevant: { type: "noul", instructions: "Relevant?" },
  },
};
const answer = {
  model: "jev-test",
  answers: {
    route: {
      type: "choice",
      choice: "keep",
      confidence: 0.75,
      probabilities: { keep: 0.75, skip: 0.25 },
    },
    quality: {
      type: "score",
      score: 0.6,
      confidence: 0.6,
      legend: { 0: "Low", 1: "High" },
      probabilities: { 0: 0.4, 1: 0.6 },
    },
    relevant: { type: "noul", noul: 0.3 },
  },
  usage: { input_tokens: 20, output_tokens: 10 },
};

// Exercise the actual SDK's request/response path without any network or credentials.
describe("TypeSafe evaluation", () => {
  it("preserves typed values and distributions through the real SDK", async () => {
    const fetch = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(answer)),
    );
    const result = await evaluate(input, config, undefined, fetch);
    expect(result).toEqual({ evaluation: answer });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    const body = init?.body;
    if (typeof body !== "string") {
      throw new Error("Expected serialized JSON request body");
    }
    expect(JSON.parse(body)).toEqual({ ...input, model: "jev-test" });
    expect(JSON.stringify(result)).not.toContain(config.apiKey);
  });
  it("does not inherit SDK endpoint/model/logging environment overrides", async () => {
    vi.stubEnv("TYPESAFE_BASE_URL", "https://invalid.example");
    vi.stubEnv("TYPESAFE_DEFAULT_MODEL", "unexpected");
    vi.stubEnv("TYPESAFE_LOG_LEVEL", "debug");
    const log = vi.spyOn(console, "debug");
    try {
      const fetch = vi.fn(
        async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(answer)),
      );
      await evaluate(input, config, undefined, fetch);
      expect(fetch.mock.calls[0]?.[0]).toBe("https://api.typesafe.ai/v1/systemone");
      expect(log).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      log.mockRestore();
    }
  });
  it.each([400, 401, 403, 422, 429, 500])(
    "sanitizes HTTP %s failures and never retries",
    async (status) => {
      const fetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ error: `${config.apiKey}: synthetic state` }), { status }),
      );
      await expect(evaluate(input, config, undefined, fetch)).rejects.toThrow(/^TypeSafe /);
      try {
        await evaluate(input, config, undefined, fetch);
      } catch (error) {
        expect(String(error)).not.toContain(config.apiKey);
        expect(String(error)).not.toContain("synthetic state");
      }
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
  it("sanitizes transport errors and invalid JSON", async () => {
    await expect(
      evaluate(input, config, undefined, async () => {
        throw new Error(config.apiKey);
      }),
    ).rejects.toThrow("TypeSafe transport unavailable");
    await expect(
      evaluate(input, config, undefined, async () => new Response("not json")),
    ).rejects.toThrow("TypeSafe evaluation failed");
  });
  it("requires host-resolved credentials rather than using an ambient key", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "unused-synthetic-key");
    const fetch = vi.fn();
    try {
      await expect(
        evaluate(
          input,
          runtimeConfig({ apiKey: { source: "env", provider: "default", id: "TYPESAFE_API_KEY" } }),
          undefined,
          fetch,
        ),
      ).rejects.toThrow("API key is missing");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("cancels before dispatch without exposing the abort reason", async () => {
    const controller = new AbortController();
    controller.abort(config.apiKey);
    const fetch = vi.fn();
    await expect(evaluate(input, config, controller.signal, fetch)).rejects.toThrow(
      "TypeSafe evaluation cancelled.",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("propagates in-flight cancellation to fetch", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      controller.abort(config.apiKey);
      init?.signal?.throwIfAborted();
      return new Response(JSON.stringify(answer));
    });
    await expect(evaluate(input, config, controller.signal, fetch)).rejects.toThrow(
      "TypeSafe evaluation cancelled.",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("enforces request timeout", async () => {
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Request aborted", "AbortError")),
            {
              once: true,
            },
          );
        }),
    );
    await expect(evaluate(input, config, undefined, fetch)).rejects.toThrow(
      "TypeSafe evaluation timed out.",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("bounded contracts", () => {
  it.each([
    { ...input, extra: true },
    { ...input, questions: {} },
    { ...input, state: "x".repeat(MAX_JSON_BYTES + 1) },
    { ...input, state: "😀".repeat(MAX_JSON_BYTES / 4 + 1) },
    { ...input, state: { bad: Infinity } },
    { ...input, state: { bad: undefined } },
    { ...input, state: JSON.parse('{"__proto__":"bad"}') },
    { ...input, questions: { bad: { type: "score", instructions: "rate", criteria: ["only"] } } },
  ])("rejects invalid or excessive input", (value) => expect(() => parseInput(value)).toThrow());
  it("rejects cyclic state", () => {
    const state: unknown[] = [];
    state.push(state);
    expect(() => parseInput({ ...input, state })).toThrow();
  });
  it.each([
    { ...answer, answers: {} },
    { ...answer, answers: { ...answer.answers, relevant: { type: "noul", noul: 1.01 } } },
    {
      ...answer,
      answers: { ...answer.answers, route: { ...answer.answers.route, choice: "other" } },
    },
    {
      ...answer,
      answers: {
        ...answer.answers,
        route: { ...answer.answers.route, probabilities: { keep: 0.5, other: 0.5 } },
      },
    },
    {
      ...answer,
      answers: {
        ...answer.answers,
        route: { ...answer.answers.route, probabilities: { keep: 0.1, skip: 0.1 } },
      },
    },
    { ...answer, answers: { ...answer.answers, quality: { ...answer.answers.quality, score: 2 } } },
    {
      ...answer,
      answers: {
        ...answer.answers,
        quality: { ...answer.answers.quality, legend: { 0: "Wrong", 1: "High" } },
      },
    },
    { ...answer, usage: { input_tokens: -1, output_tokens: 1 } },
    { ...answer, leak: config.apiKey },
  ])("rejects malformed or mismatched responses", (value) =>
    expect(() => parseResult(value, parseInput(input))).toThrow("invalid evaluation response"),
  );
});
