import type { Fetch } from "@typesafe-ai/sdk";
import { MAX_JSON_BYTES } from "./schema.js";

const MAX_RESPONSE_BYTES = MAX_JSON_BYTES;

/** Keep the SDK's fixed destination and bound response buffering, including error bodies. */
export function boundedFetch(fetch: Fetch = globalThis.fetch): Fetch {
  return async (url, init) => {
    init?.signal?.throwIfAborted();
    if (url !== "https://api.typesafe.ai/v1/systemone") {
      throw new Error("Unexpected TypeSafe destination.");
    }
    if (typeof init?.body === "string" && Buffer.byteLength(init.body) > MAX_JSON_BYTES)
      throw new Error("TypeSafe request exceeds its limit.");
    const response = await fetch(url, { ...init, redirect: "error" });
    const reader = response.body?.getReader();
    if (!reader) {
      init?.signal?.throwIfAborted();
      return response;
    }
    // Join body cancellation physically; an uncooperative transport remains owned/fenced.
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      cancellation ??= reader.cancel().catch(() => {});
    };
    init?.signal?.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      // Read under the SDK's request signal; never trust Content-Length alone.
      while (true) {
        init?.signal?.throwIfAborted();
        const chunk = await reader.read();
        init?.signal?.throwIfAborted();
        if (chunk.done) {
          break;
        }
        length += chunk.value.byteLength;
        if (length > MAX_RESPONSE_BYTES) {
          throw new Error("TypeSafe response exceeds its limit.");
        }
        chunks.push(chunk.value);
      }
    } catch (error) {
      cancel();
      throw error;
    } finally {
      init?.signal?.removeEventListener("abort", cancel);
      await cancellation;
      reader.releaseLock();
    }
    return new Response(Buffer.concat(chunks, length), {
      status: response.status,
      headers: response.headers,
    });
  };
}
