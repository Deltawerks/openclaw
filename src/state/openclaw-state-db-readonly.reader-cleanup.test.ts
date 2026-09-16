import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn<() => boolean>(),
  admit: vi.fn<() => void>(),
  schema: vi.fn<() => void>(),
}));
vi.mock("./openclaw-state-db-read-connection.js", () => ({
  openOpenClawStateReadConnection: () => ({
    database: { db: {}, path: "/fixture/state.sqlite" },
    close: mocks.close,
  }),
}));
vi.mock("./openclaw-state-db-schema-version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-state-db-schema-version.js")>()),
  assertSupportedStateSchemaVersion: mocks.schema,
}));

import { withOpenClawStateReadOnlyLocation } from "./openclaw-state-db-readonly.js";

beforeEach(() => {
  mocks.close.mockReset().mockReturnValue(true);
  mocks.admit.mockReset();
  mocks.schema.mockReset();
});

it.each([
  { stage: "read", schemaAdmission: false },
  { stage: "schema", schemaAdmission: false },
  { stage: "read", schemaAdmission: true },
  { stage: "schema", schemaAdmission: true },
])(
  "preserves the $stage failure with schema admission $schemaAdmission",
  ({ stage, schemaAdmission }) => {
    const primary = new Error(`${stage} failed`);
    const admissionCleanup = new Error("schema admission cleanup failed");
    const cleanup = new Error("reader close failed");
    mocks.admit.mockImplementation(() => {
      throw admissionCleanup;
    });
    mocks.close.mockImplementation(() => {
      throw cleanup;
    });
    if (stage === "schema") {
      mocks.schema.mockImplementation(() => {
        throw primary;
      });
    }
    let failure: unknown;
    try {
      withOpenClawStateReadOnlyLocation(
        () => {
          throw primary;
        },
        "/fixture/state.sqlite",
        "/fixture/private.sqlite",
        schemaAdmission ? () => mocks.admit : undefined,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      cause: primary,
      errors: [primary, ...(schemaAdmission ? [admissionCleanup] : []), cleanup],
    });
    if (schemaAdmission) {
      expect(mocks.admit).toHaveBeenCalledOnce();
    }
    expect(mocks.close).toHaveBeenCalledOnce();
  },
);
