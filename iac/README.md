# Outfitting Manager IaC

Alchemy stack for the manager API, docs site, shared router, lockfile KV/D1 storage, private-font R2
bucket, and API token binding. Platform installer Workers and their hostnames are deployed from
`jfalava/machines`.

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
| API/docs hostname   | `outfitting.jfa.dev`        |

The router strips `/api` and forwards API requests, then sends allowlisted docs paths to the docs
Worker. The private-font bucket is owned by this stack; the installer Worker in `jfalava/machines`
binds to that bucket by physical name.

## Commands

- `bun run ci:build` typechecks the stack.
- `bun run test:api` and `bun run test:router` test its request paths.
- `bun run ci:deploy` deploys the stack non-interactively.

The API and docs share `outfitting.jfa.dev`; `/api` is the API path and the root serves docs. Do not
bind `api.outfitting.jfa.dev` or move installer hostnames onto the manager router.
