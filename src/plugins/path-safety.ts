/** Plugin-local re-export of shared path safety helpers for plugin install/runtime code. */
import fs from "node:fs";
import path from "node:path";
import { isPathInside as isPathInsideLexical } from "../infra/path-safety.js";

export { safeRealpathSync, safeStatSync, formatPosixMode } from "../infra/path-safety.js";

/** Proves containment when Windows presents the same directory through different path aliases. */
function isPathInsideByIdentitySync(rootPath: string, targetPath: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  try {
    const root = fs.statSync(rootPath, { bigint: true });
    if (!root.isDirectory() || root.ino === 0n) {
      return false;
    }
    let current = targetPath;
    while (true) {
      const candidate = fs.statSync(current, { bigint: true });
      if (candidate.dev === root.dev && candidate.ino === root.ino) {
        return true;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return false;
      }
      current = parent;
    }
  } catch {
    return false;
  }
}

export function isPathInside(rootPath: string, targetPath: string): boolean {
  return (
    isPathInsideLexical(rootPath, targetPath) || isPathInsideByIdentitySync(rootPath, targetPath)
  );
}
