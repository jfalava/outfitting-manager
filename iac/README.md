# Outfitting Manager IaC

Alchemy stack for the manager API, its `/api` router, lockfile KV/D1 storage, private-font R2
bucket, and API token binding. Documentation and installer workers are deployed from
`jfalava/outfitting`.

## Configuration

Precedence is **CLI flags → environment → `outfitting.deploy.json` → defaults**. Start from
`iac/outfitting.deploy.example.json` to override the API hostname or resource names.

| Setting             | Default                     |
| ------------------- | --------------------------- |
| Stack               | `OutfittingManager`         |
| Router              | `outfitting-manager-router` |
| API                 | `outfitting-api`            |
| KV and D1           | `outfitting-lockfiles`      |
| Private-font bucket | `outfitting-private-fonts`  |
| API hostname        | `api.outfitting.jfa.dev`    |

The router strips `/api` and forwards only API requests. The private-font bucket is owned by this
stack; the installer Worker in `jfalava/outfitting` binds to that bucket by physical name.

## Commands

- `bun run ci:build` typechecks the stack.
- `bun run test:api` and `bun run test:router` test its request paths.
- `bun run ci:deploy` deploys the stack non-interactively.

**Migration warning:** existing Cloudflare resources and Alchemy state were provisioned by
`jfalava/outfitting`. Do not deploy or destroy this stack until the resource ownership, live lockfile
data, token, font bucket, and hostname transfer have been reviewed and migrated deliberately.
