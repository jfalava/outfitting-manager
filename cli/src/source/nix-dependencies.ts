import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import { relativeSourcePath } from "@/source/contract";

function isCovered(path: string, parent: string): boolean {
  return parent === "." || path === parent || path.startsWith(`${parent}/`);
}

function isEnoent(cause: unknown): boolean {
  return (
    cause instanceof Error && "code" in cause && (cause as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function repositoryPath(value: string): string | undefined {
  if (value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/.test(value)) {
    return undefined;
  }
  const normalized = posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return undefined;
  }
  try {
    return relativeSourcePath(normalized, "Nix source path");
  } catch {
    return undefined;
  }
}

function repositoryRootVariables(source: string): Set<string> {
  const variables = new Set(
    [...source.matchAll(/\b([A-Za-z_][\w'-]*)\s*=\s*builtins\.getEnv\s+"OUTFITTING_REPO"/g)].map(
      (match) => match[1]!,
    ),
  );
  const assignments = [...source.matchAll(/^\s*([A-Za-z_][\w'-]*)\s*=\s*([\s\S]*?);/gm)];

  let changed = true;
  while (changed) {
    changed = false;
    for (const [, name, expression] of assignments) {
      if (
        name !== undefined &&
        expression !== undefined &&
        !variables.has(name) &&
        [...variables].some((variable) => new RegExp(`\\b${variable}\\b`).test(expression))
      ) {
        variables.add(name);
        changed = true;
      }
    }
  }
  return variables;
}

function sourceReferences(source: string, file: string): string[] {
  const references = new Set<string>();
  const rootVariables = repositoryRootVariables(source);

  for (const match of source.matchAll(/\$\{([A-Za-z_][\w'-]*)\}\/([^"'`\s}$;]+)/g)) {
    if (match[1] !== undefined && rootVariables.has(match[1]) && match[2] !== undefined) {
      const path = repositoryPath(match[2]);
      if (path !== undefined) {
        references.add(path);
      }
    }
  }

  for (const match of source.matchAll(/(?:^|[^\w])((?:\.\.?\/)[A-Za-z0-9._/-]+)/g)) {
    const relativeReference = match[1];
    if (relativeReference !== undefined) {
      const path = repositoryPath(posix.join(posix.dirname(file), relativeReference));
      if (path !== undefined) {
        references.add(path);
      }
    }
  }

  return [...references];
}

async function nixFilesIn(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await nixFilesIn(path)));
    } else if (entry.isFile() && entry.name.endsWith(".nix")) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Suggest paths referenced by Nix files under the selected flake and their static references.
 * This is intentionally heuristic; Nix can construct paths dynamically at evaluation time.
 */
export async function discoverNixSourcePaths(options: {
  root: string;
  flake: string;
  declaredPaths?: ReadonlyArray<string>;
}): Promise<string[]> {
  const root = resolve(options.root);
  const flake = relativeSourcePath(options.flake, "Nix flake path");
  const declaredPaths = (options.declaredPaths ?? []).map((path) =>
    relativeSourcePath(path, "declared Linux path"),
  );
  const queue = await nixFilesIn(join(root, flake));
  const visited = new Set<string>();
  const candidates = new Set<string>();

  while (queue.length > 0) {
    const filePath = queue.pop()!;
    const file = relative(root, filePath).split(sep).join("/");
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);

    const source = await readFile(filePath, "utf8");
    for (const path of sourceReferences(source, file)) {
      const insideFlake = isCovered(path, flake);
      const alreadyDeclared = declaredPaths.some((declared) => isCovered(path, declared));
      if (!insideFlake && !alreadyDeclared) {
        candidates.add(path);
      }

      const absolutePath = join(root, path);
      try {
        const info = await stat(absolutePath);
        if (info.isDirectory()) {
          queue.push(...(await nixFilesIn(absolutePath)));
        } else if (info.isFile() && path.endsWith(".nix")) {
          queue.push(absolutePath);
        }
      } catch (cause) {
        if (!isEnoent(cause)) {
          throw cause;
        }
      }
    }
  }

  return [...candidates];
}

/** Return a missing repository-relative path only when Nix's absolute path is inside root. */
export function missingSourcePathFromNixError(message: string, root: string): string | undefined {
  const absoluteRoot = resolve(root);
  for (const match of message.matchAll(/path ['"]([^'"]+)['"] does not exist/gi)) {
    const missingPath = match[1];
    if (missingPath === undefined || !isAbsolute(missingPath)) {
      continue;
    }
    const absoluteMissing = resolve(missingPath);
    const path = relative(absoluteRoot, absoluteMissing);
    if (
      path.length === 0 ||
      path === ".." ||
      path.startsWith(`..${sep}`) ||
      posix.isAbsolute(path)
    ) {
      continue;
    }
    const normalized = path.split(sep).join("/");
    try {
      return relativeSourcePath(normalized, "missing Nix source path");
    } catch {
      continue;
    }
  }
  return undefined;
}
