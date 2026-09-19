import type { GatewayEventFrame } from "../../api/gateway.ts";
import type {
  SessionConnectionOwner,
  SessionConnectionScope,
  SessionRowEventListener,
} from "./session-capability.ts";
import {
  canApplySessionListSnapshot,
  sessionListEventMatcher,
  type ManagedSessionList,
} from "./session-list-query.ts";
import type { SessionChangedRowResult } from "./session-row-reconcile.ts";

export type SessionEventDelivery<Registration> = (
  event: GatewayEventFrame,
  result?: (entry: Registration) => SessionChangedRowResult,
) => void;

export function captureSessionEventDelivery<
  Registration extends { onEvent?: SessionRowEventListener },
>(
  entries: Iterable<Registration>,
  scope: SessionConnectionScope | null,
  connection: SessionConnectionOwner,
  isAttached: (entry: Registration) => boolean,
): SessionEventDelivery<Registration> {
  const registrations = [...entries];
  return (event, result = () => ({ applied: false })) => {
    for (const entry of registrations) {
      if (!scope || !connection.isCurrent(scope)) {
        return;
      }
      if (!entry.onEvent || !isAttached(entry)) {
        continue;
      }
      try {
        entry.onEvent(event, result(entry));
      } catch (error) {
        console.error("[sessions] event observer error:", error);
      }
    }
  };
}

export function createSessionEventObservation<Registration>(host: {
  connection: SessionConnectionOwner;
  lists: ReadonlyMap<string, ManagedSessionList>;
  readRevision: () => number;
  nextRevision: () => number;
  captureDelivery: (scope: SessionConnectionScope | null) => SessionEventDelivery<Registration>;
}) {
  const observations = new WeakMap<
    object,
    {
      revision: number;
      scope: SessionConnectionScope | null;
      lists: ReadonlySet<ManagedSessionList>;
    }
  >();
  return {
    captureEvent(this: void, payload: unknown) {
      if (!payload || typeof payload !== "object") {
        const scope = host.connection.capture();
        return { revision: host.readRevision(), scope, deliver: host.captureDelivery(scope) };
      }
      const previous = observations.get(payload);
      if (previous !== undefined) {
        return { ...previous, deliver: host.captureDelivery(previous.scope) };
      }
      const scope = host.connection.capture();
      const observation = {
        revision: host.nextRevision(),
        scope,
        lists: new Set(
          [...host.lists.values()]
            .filter(sessionListEventMatcher(payload))
            .filter(
              (entry) =>
                entry.pending !== null ||
                entry.snapshot.error !== null ||
                !canApplySessionListSnapshot(entry.snapshot.result, payload, entry.scope),
            ),
        ),
      };
      observations.set(payload, observation);
      return { ...observation, deliver: host.captureDelivery(scope) };
    },
    affectedLists(payload: unknown) {
      return payload && typeof payload === "object" ? observations.get(payload)?.lists : undefined;
    },
  };
}
