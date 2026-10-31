import { isWithinSourcePath, relativeSourcePath } from "@/source/contract";
import { isReservedSourcePath } from "@/source/reserved";

/** One entry of a recursive Git tree listing, from `git ls-tree` or the GitHub trees API. */
export interface SourceTreeEntry {
  path: string;
  type: string;
  mode: string;
}

const FILE_MODES = new Map([
  ["100644", 0o644],
  ["100755", 0o755],
]);

/** Permission bits for a regular Git blob mode; undefined for symlinks and submodules. */
export function gitModeToFileMode(mode: string): number | undefined {
  return FILE_MODES.get(mode);
}

/**
 * Select the regular files under the declared repository paths, rejecting missing or reserved
 * roots and any symlink or submodule inside them. `origin` names the tree source in errors.
 */
export function selectSourceTreeEntries<Entry extends SourceTreeEntry>(
  entries: readonly Entry[],
  paths: ReadonlyArray<string>,
  origin: "Git" | "GitHub",
): Array<Entry & { fileMode: number }> {
  const files = entries.filter((entry) => entry.type !== "tree");
  const roots = paths.map((path) => relativeSourcePath(path, "BYOR path"));
  for (const root of roots) {
    if (isReservedSourcePath(root)) {
      throw new Error(
        `${origin} path \`${root}\` is reserved for machine configuration and runtime state.`,
      );
    }
    if (!files.some((entry) => isWithinSourcePath(entry.path, root))) {
      throw new Error(`${origin} path \`${root}\` is missing or empty.`);
    }
  }
  return files
    .filter(
      (entry) =>
        roots.some((root) => isWithinSourcePath(entry.path, root)) &&
        !isReservedSourcePath(entry.path),
    )
    .map((entry) => {
      relativeSourcePath(entry.path, `${origin} tree path`);
      const fileMode = gitModeToFileMode(entry.mode);
      if (entry.type !== "blob" || fileMode === undefined) {
        throw new Error(
          `Unsupported ${origin} entry ${entry.path} (${entry.mode}). Remote sources cannot contain symlinks or submodules in selected paths; use a local checkout.`,
        );
      }
      return { ...entry, fileMode };
    });
}
