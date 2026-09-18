/** Plugin-local re-export of shared path safety helpers for plugin install/runtime code. */
import fs from "node:fs";
import path from "node:path";
import { isPathInside as isPathInsideLexical } from "../infra/path-safety.js";

export { safeRealpathSync, safeStatSync, formatPosixMode } from "../infra/path-safety.js";

export type PhysicalPathInsideRoot = {
  rootPath: string;
  targetPath: string;
};

/** Resolves matching physical spellings when Windows presents one tree through different aliases. */
export function resolvePhysicalPathInsideRootSync(
  rootPath: string,
  targetPath: string,
): PhysicalPathInsideRoot | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  try {
    const root = fs.statSync(rootPath, { bigint: true });
    if (!root.isDirectory() || root.ino === 0n) {
      return undefined;
    }
    // Walk the observed target spelling to prove identity, then rebuild the
    // target beneath the root spelling that the descriptor boundary admits.
    let current = path.resolve(targetPath);
    while (true) {
      const candidate = fs.statSync(current, { bigint: true });
      if (candidate.dev === root.dev && candidate.ino === root.ino) {
        const physicalRoot = path.resolve(rootPath);
        return {
          rootPath: physicalRoot,
          targetPath: path.resolve(physicalRoot, path.relative(current, targetPath)),
        };
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  } catch {
    return undefined;
  }
}

export function isPathInside(rootPath: string, targetPath: string): boolean {
  return (
    isPathInsideLexical(rootPath, targetPath) ||
    resolvePhysicalPathInsideRootSync(rootPath, targetPath) !== undefined
  );
}
