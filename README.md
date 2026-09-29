# Outfitting Manager

The `outfitting-manager` CLI and its lockfile API are maintained in this repository. The
standalone workspace also contains the API contract, Cloudflare router, and Alchemy resources used
by the CLI.

```sh
bun install
bun run test:cli
bun run --filter @outfitting/cli typecheck
```

`outfitting-manager provision` deploys the manager API, documentation, and their shared router.
The public API is `https://outfitting.jfa.dev/api`; the documentation is served at the bare host.
The `jfalava/machines` repository owns only the platform installer Workers and their hostnames.

The manager Alchemy stack owns its API, docs, router, lockfile storage, and private-font bucket. The
machines Alchemy stack owns only installer Workers and their platform hostnames.
