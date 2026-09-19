import {
  TypeSafeClient,
  APIUserAbortError,
  type Fetch,
  type Questions,
  type EntryType,
} from "@typesafe-ai/sdk";
import type { RuntimeConfig } from "./config.js";
import { evaluationError } from "./errors.js";
import { parseInput, parseResult } from "./schema.js";
import { boundedFetch } from "./transport.js";

/** Run one explicit evaluation with no retries, ambient SDK config, or sensitive diagnostics. */
export async function evaluate(
  input: unknown,
  config: RuntimeConfig,
  signal?: AbortSignal,
  fetch?: Fetch,
) {
  if (signal?.aborted) {
    throw new Error("TypeSafe evaluation cancelled.");
  }
  const parsed = parseInput(input);
  if (!config.apiKey) {
    throw new Error("TypeSafe API key is missing. Configure a SecretRef in plugin Settings.");
  }
  const questions: Questions = {};
  for (const [id, question] of Object.entries(parsed.questions)) {
    if (question.type === "score") {
      const [first, second, ...rest] = question.criteria;
      if (first === undefined || second === undefined) {
        throw new Error("Invalid TypeSafe score rubric.");
      }
      // SAFETY: parseInput validates the SDK score shape, including its minimum two rubric entries.
      questions[id] = { ...question, criteria: [first, second, ...rest] } as Questions[string];
    } else {
      // SAFETY: parseInput validates Choice/Noul fields and bounded finite-JSON entries.
      questions[id] = question as Questions[string];
    }
  }
  try {
    const client = new TypeSafeClient({
      apiKey: config.apiKey,
      baseURL: "https://api.typesafe.ai",
      defaultModel: config.model,
      timeout: config.timeoutMs,
      retry: { maxRetries: 0 },
      logLevel: "off",
      fetch: boundedFetch(fetch),
    });
    // The bounded JSON validator above establishes the SDK's recursive state contract.
    const response = await client.systemOne(
      // SAFETY: parseInput checks finite plain JSON with the SDK-compatible entry root types.
      { state: parsed.state as EntryType, questions, model: parsed.model ?? config.model },
      { signal },
    );
    if (signal?.aborted) {
      throw new APIUserAbortError();
    }
    const evaluation = parseResult(response, parsed);
    if (JSON.stringify(evaluation).includes(config.apiKey)) {
      throw new Error("Invalid TypeSafe response.");
    }
    return { evaluation };
  } catch (error) {
    throw evaluationError(error, signal?.aborted ?? false);
  }
}
