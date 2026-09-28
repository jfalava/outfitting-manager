# Outfitting Manager

The `outfitting-manager` CLI and its lockfile API are maintained in this repository. The
standalone workspace also contains the API contract, Cloudflare router, and Alchemy resources used
by the CLI.

```sh
bun install
bun run test:cli
bun run --filter @outfitting/cli typecheck
```

`outfitting-manager provision` deploys the manager API and its router at
`https://api.outfitting.jfa.dev/api`. The router only forwards `/api` requests. Documentation and
platform installer hosts remain in `jfalava/outfitting`.

The Cloudflare resources were previously provisioned from `jfalava/outfitting`. Do not deploy or
destroy either repository's Alchemy stack until the existing resources and state ownership have
been reviewed and migrated deliberately.
