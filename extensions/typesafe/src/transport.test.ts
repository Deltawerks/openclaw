import { expect, it, vi } from "vitest";
import { MAX_JSON_BYTES } from "./schema.js";
import { boundedFetch } from "./transport.js";

it("rejects other destinations before dispatch", async () => {
  const fetch = vi.fn();
  await expect(boundedFetch(fetch)("https://other.example")).rejects.toThrow("Unexpected");
  expect(fetch).not.toHaveBeenCalled();
});
it("disables redirects and bounds response bodies even without content-length", async () => {
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response("x".repeat(MAX_JSON_BYTES + 1)),
  );
  await expect(boundedFetch(fetch)("https://api.typesafe.ai/v1/systemone")).rejects.toThrow(
    "exceeds",
  );
  expect(fetch.mock.calls[0]![1]?.redirect).toBe("error");
});

// The injected stream deliberately ignores the request signal, unlike native fetch.
it("cancels a stalled body and joins the transport cleanup", async () => {
  const controller = new AbortController();
  let reading!: () => void;
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  let finishCleanup!: () => void;
  const cancelled = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishCleanup = resolve;
      }),
  );
  const body = new ReadableStream<Uint8Array>({
    pull() {
      reading();
    },
    cancel: cancelled,
  });
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const pending = boundedFetch(async () => new Response(body))(
    "https://api.typesafe.ai/v1/systemone",
    { signal: controller.signal },
  );
  await started;
  controller.abort(new Error("synthetic-abort"));
  let completed = false;
  const completion = pending.finally(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(cancelled).toHaveBeenCalledOnce();
  finishCleanup();
  await expect(completion).rejects.toThrow("synthetic-abort");
  expect(cancelled).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
});
it("rejects an abort concurrent with body EOF", async () => {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    pull(stream) {
      controller.abort(new Error("synthetic-EOF-abort"));
      stream.close();
    },
  });
  await expect(
    boundedFetch(async () => new Response(body))("https://api.typesafe.ai/v1/systemone", {
      signal: controller.signal,
    }),
  ).rejects.toThrow("synthetic-EOF-abort");
});
it("preserves bounded multi-chunk responses and removes the abort listener", async () => {
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode("one"));
      stream.enqueue(new TextEncoder().encode("two"));
      stream.close();
    },
  });
  const response = await boundedFetch(async () => new Response(body, { status: 429 }))(
    "https://api.typesafe.ai/v1/systemone",
    { signal: controller.signal },
  );
  expect(response.status).toBe(429);
  expect(await response.text()).toBe("onetwo");
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
});
it("rejects an already-aborted request before dispatch", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetch = vi.fn();
  await expect(
    boundedFetch(fetch)("https://api.typesafe.ai/v1/systemone", { signal: controller.signal }),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
