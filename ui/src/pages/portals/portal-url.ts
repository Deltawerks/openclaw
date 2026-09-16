import { isLoopbackHostname } from "../../lib/gateway-locality.ts";

/** A remote Gateway's loopback endpoint points at the browser, not the Gateway. */
export function portalNeedsRemoteIngress(portalUrl: string, gatewayUrl: string): boolean {
  return (
    isLoopbackHostname(new URL(portalUrl).hostname) &&
    !isLoopbackHostname(new URL(gatewayUrl).hostname)
  );
}
