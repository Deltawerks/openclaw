import { describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayClientRegistry } from "./client-registry.js";
import { disconnectDisallowedGatewayBrowserOriginClients } from "./ws-origin-policy.js";
import type { GatewayWsClient } from "./ws-types.js";

describe("committed browser origin policy", () => {
  it.each(
    (["allowedOrigins", "dangerouslyAllowHostHeaderOriginFallback"] as const).flatMap((policy) =>
      ["live", "disconnected"].map((transport) => ({ policy, transport })),
    ),
  )(
    "retires only clients no longer admitted after $policy changes ($transport)",
    ({ policy, transport }) => {
      const revoked = {
        browserOrigin: {
          origin: "https://revoked.example.test",
          requestHost: "revoked.example.test",
          isLocalClient: false,
        },
        invalidated: false,
        invalidatedReason: undefined as string | undefined,
        socket: { close: vi.fn() },
      };
      const retained = {
        browserOrigin: {
          origin: "https://retained.example.test",
          requestHost: "gateway.example.test",
          isLocalClient: false,
        },
        socket: { close: vi.fn() },
      };
      const backend = { socket: { close: vi.fn() } };
      const registry = new GatewayClientRegistry([revoked, retained, backend] as never);
      const release = registry.retainRequest(revoked as unknown as GatewayWsClient);
      onTestFinished(release);
      if (transport === "disconnected") {
        registry.delete(revoked as unknown as GatewayWsClient);
      }
      const clients = registry.authorityClients;
      disconnectDisallowedGatewayBrowserOriginClients(clients, {
        gateway: {
          controlUi: {
            allowedOrigins: [
              "https://retained.example.test",
              ...(policy === "allowedOrigins" ? ["https://revoked.example.test"] : []),
            ],
            dangerouslyAllowHostHeaderOriginFallback: policy !== "allowedOrigins",
          },
        },
      });
      expect(revoked.socket.close).not.toHaveBeenCalled();

      disconnectDisallowedGatewayBrowserOriginClients(clients, {
        gateway: { controlUi: { allowedOrigins: ["https://retained.example.test"] } },
      });
      expect(revoked.socket.close).toHaveBeenCalledExactlyOnceWith(1008, "origin not allowed");
      expect(revoked.invalidated).toBe(true);
      expect(revoked.invalidatedReason).toBe("origin-policy-changed");
      expect(retained.socket.close).not.toHaveBeenCalled();
      expect(backend.socket.close).not.toHaveBeenCalled();
    },
  );
});
