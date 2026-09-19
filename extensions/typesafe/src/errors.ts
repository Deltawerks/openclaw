import {
  APIError,
  APITimeoutError,
  APIUserAbortError,
  APIConnectionError,
  RateLimitError,
} from "@typesafe-ai/sdk";
import type { ProviderFailureReason } from "openclaw/plugin-sdk/judgments";

export class EvaluationError extends Error {
  constructor(
    message: string,
    readonly reason: ProviderFailureReason,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "EvaluationError";
  }
}

/** Replace vendor diagnostics; never retain raw error bodies, credentials or evidence as cause. */
export function evaluationError(error: unknown, aborted: boolean): Error {
  if (aborted || error instanceof APIUserAbortError)
    return new EvaluationError("TypeSafe evaluation cancelled.", "transport");
  if (error instanceof APITimeoutError)
    return new EvaluationError("TypeSafe evaluation timed out.", "transport");
  if (error instanceof APIError) {
    if (error.status === 401 || error.status === 403)
      return new EvaluationError(
        "TypeSafe authentication failed; check the configured credential and account access.",
        "authentication",
      );
    if (error.status === 429)
      return new EvaluationError(
        "TypeSafe rate limit reached; retry later.",
        "rate-limited",
        error instanceof RateLimitError ? error.retryAfterMs : undefined,
      );
    return new EvaluationError("TypeSafe service rejected the evaluation request.", "transport");
  }
  if (error instanceof APIConnectionError)
    return new EvaluationError("TypeSafe transport unavailable.", "transport");
  return new EvaluationError(
    "TypeSafe evaluation failed or returned an invalid response.",
    "invalid-response",
  );
}
