# Worker Route Cutover

This repository contains a Cloudflare Worker and an operator CLI for moving a dedicated production route from a stable Worker to a candidate Worker.

## Requirements

- Node.js 22 or newer
- npm
- A tester-owned Cloudflare account and zone
- `~/.config/agent-eval/cloudflare-worker.env`

The environment file supplies the API token, account and zone identifiers, Worker names, and hostnames. Do not commit it.

## Install and check

```sh
npm ci
npm run check
```

## Worker endpoints

- `GET /healthz`
- `GET /version`
- `GET /api/config`

## Operator commands

```sh
npm run cli -- plan
npm run cli -- apply ./dist/worker.js
npm run cli -- status
npm run cli -- verify
npm run cli -- rollback
```

`plan` reads Cloudflare state and prints intended actions. `apply` uploads the supplied bundle and moves the configured routes. `status` and `verify` report route state. `rollback` uses `.rollout/journal.json` to restore the previous production route.

Local tests mock Cloudflare and do not mutate live resources.
