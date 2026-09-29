# Outfitting Manager API

Cloudflare Worker that stores generated, machine-local lock state for `outfitting-manager`.

The manager repository's Alchemy stack deploys this API behind the shared docs/API router. The CLI
does not choose a default API URL: configure it with `outfitting-manager sync configure-worker` or
set `OUTFITTING_LOCKFILES_URL`. `outfitting-manager provision` saves the URL and token for its new
deployment unless `--skip-configure` is passed. Amp orbs require `OUTFITTING_LOCKFILES_URL` and
`OUTFITTING_LOCKFILES_TOKEN` as environment variables.

See the [API overview](https://outfitting.jfa.dev/docs/api/) for its supported operations and how the CLI uses them.

See the [CLI sync reference](https://outfitting.jfa.dev/docs/cli/sync/) for user-facing lockfile commands.
