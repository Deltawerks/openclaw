import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("ui.prefs.accent", () => {
  it.each([
    ["theme default", "theme", true],
    ["lowercase hex", "#ff5c5c", true],
    ["uppercase hex", "#AbCdEf", true],
    ["missing hash", "ff5c5c", false],
    ["invalid hex", "#gggggg", false],
    ["invalid length", "#ff5c5c00", false],
  ])("validates %s", (_label, accent, valid) => {
    expect(validateConfigObject({ ui: { prefs: { accent } } }).ok).toBe(valid);
  });
});
