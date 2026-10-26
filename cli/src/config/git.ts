/** Validate Git remotes accepted by a machine configuration. */
export function normalizeGitRepository(value: string): string {
  const repository = value.trim();
  if (repository.length === 0 || repository.startsWith("-") || /[\s\0]/.test(repository)) {
    throw new Error("Repository must be a Git remote URL or SSH-style Git address.");
  }

  const scpAddress = /^(?:[^@/:]+@)?[^:/]+:.+$/;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(repository) && scpAddress.test(repository)) {
    return repository;
  }

  let url: URL;
  try {
    url = new URL(repository);
  } catch {
    throw new Error("Repository must be a Git remote URL or SSH-style Git address.");
  }
  if (
    !["https:", "http:", "ssh:", "git:"].includes(url.protocol) ||
    url.hostname.length === 0 ||
    ["", "/"].includes(url.pathname) ||
    [url.password, url.search, url.hash].some(Boolean)
  ) {
    throw new Error("Repository must be a Git remote URL or SSH-style Git address.");
  }
  return repository;
}

export function validateGitRef(value: string): string {
  const ref = value.trim();
  if (ref.length === 0 || ref.startsWith("-") || /[\s\0]/.test(ref)) {
    throw new Error("Git ref must be non-empty and cannot begin with '-'.");
  }
  return ref;
}
