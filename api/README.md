# Outfitting Manager API

Cloudflare Worker that stores generated, machine-local lock state for `outfitting-manager`.

The manager repository's Alchemy stack deploys this API behind its dedicated `/api` router. The
default URL is `https://api.outfitting.jfa.dev/api`.

See the [CLI sync reference](https://outfitting.jfa.dev/docs/cli/sync/) for lockfile operations.
