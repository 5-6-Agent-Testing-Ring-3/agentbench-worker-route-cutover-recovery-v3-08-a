# Worker Route Cutover

This repository contains an ES-module Cloudflare Worker and an operator CLI for a dedicated stable/candidate pair. Production moves only after candidate validation. Recovery restores the captured route and deployment configuration using authenticated reads, never journal state alone.

## Prerequisites and boundaries

- Node.js 22 or newer, npm, outbound HTTPS to Cloudflare and both configured public endpoints.
- Existing tester-owned stable and candidate Workers, with recoverable active deployments. The candidate baseline must have exactly one active version so binding inheritance is unambiguous.
- An existing canonical production route (`configured hostname/*`) pointing to the stable Worker for a new rollout. Missing, overlapping, duplicate, disabled-production, unknown-Worker, and unjournaled candidate-production states fail closed. This tool does not provision production infrastructure.
- Both Workers must provide the public API below and `RELEASE_VERSION` / `WORKER_ROLE` plain-text bindings with distinguishable public identities. The CLI preserves their values; it does not silently substitute values from Wrangler files.
- The configured Workers are dedicated to these routes in the configured zone. The CLI rejects other candidate routes found in that zone. Operators must ensure there are no other custom domains, cross-zone routes, or external deployment controllers attached to the candidate. This CLI cannot establish exclusive control over other accounts or zones and will not inventory or modify them.
- One operator host/user and shared OS temporary directory for the resource scope. A per-user scope lock excludes simultaneous `apply`/`rollback` processes, including separate repository checkouts. Cloudflare route updates have no cross-resource transaction/CAS; dashboard changes, other hosts/users, and other deployment tools must be suspended during the operation. Live drift checks fail closed but cannot make an external writer atomic.

Only the account, zone, stable Worker, candidate Worker, production hostname, and canary hostname named in the credential file are authorized. The CLI uploads and activates versions **only on the candidate**, updates the existing production route in place, and temporarily changes the exact canary route. It never modifies DNS, account permissions, hostnames, stable code, or stable deployments; never deletes a Worker or historical version/deployment; and never removes a pre-existing canary route. Unsupported assets, containers, and migrations are refused before version upload.

## Credentials and artifact handling

Provision `~/.config/agent-eval/cloudflare-worker.env` with mode `0600`. It supplies these keys:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_ZONE_ID`
- `CLOUDFLARE_STABLE_WORKER_NAME`
- `CLOUDFLARE_CANDIDATE_WORKER_NAME`
- `CLOUDFLARE_PRODUCTION_HOSTNAME`
- `CLOUDFLARE_CANARY_HOSTNAME`

Use an existing token authorized to read Worker deployments/settings and zone routes, upload candidate versions, activate candidate deployments, and change these zone routes. Do not broaden permissions or create credentials as part of a rollout.

The CLI reads the file only at runtime. Do not source it into a shell, pass values as arguments, enable HTTP debug logging, put values in command-line URLs, copy it into the repository, or export credentials into the build. Values are used in memory to address authenticated API requests and public probes. Public requests never carry API authorization and neither API nor public requests follow redirects.

Output, journals, and evidence use `stable`/`candidate` and `production`/`canary` aliases. Scope, settings, public identity, and bundle digests use SHA-256. Route IDs, version IDs, deployment IDs, and timestamps remain available for audit. Binding values and unrelated account inventory are not written. Raw API bodies, transport errors, and error stacks are suppressed. An exact-value scan rejects any configured credential/resource value in the supplied bundle; the CLI also scans `dist/` and `artifacts/` before `apply`.

## Build and verify locally

```sh
npm ci
npm run check
```

`check` runs formatting, strict ESLint, TypeScript checking, deterministic unit/HTTP integration tests with coverage, and the production build. Existing thresholds remain 80% lines/statements/functions and 75% branches; Worker code is now included in coverage. Ordinary tests never read operator credentials or make live Cloudflare changes. Fixtures contain fictional identifiers only.

`dist/worker.js` is the standalone Worker module; TypeScript removes its type-only declarations and the module has no runtime imports. Inspect this file and generated artifacts before a live operation. The CLI and its credential-loading code are separate files, not part of the uploaded Worker. The Wrangler files are development examples, not deployment authority. Do not run `wrangler deploy` to bypass this lifecycle.

## Public API

The Worker contract is unchanged:

| Request           | Expected result                                                  |
| ----------------- | ---------------------------------------------------------------- |
| `GET /healthz`    | 200, `status: "ok"`, expected version and Worker identity        |
| `GET /version`    | 200, expected version and Worker identity                        |
| `GET /api/config` | 200, `schemaVersion: 1`, features `route-cutover` and `rollback` |
| Unknown GET path  | 404, `error: "not_found"`                                        |
| Non-GET request   | 405, `error: "method_not_allowed"`                               |

All responses must be JSON with `cache-control: no-store`. Candidate probes use only the configured canary hostname. Production is checked before rollout, after cutover, after cleanup, and during rollback. Deployment and route reads independently confirm the control plane around public verification.

## Operator commands

Build first. Use `--silent` for machine-readable stdout:

```sh
npm run --silent cli -- plan dist/worker.js > artifacts/plan.json
npm run --silent cli -- status > artifacts/status-before.json
npm run --silent cli -- apply dist/worker.js > artifacts/apply.json
npm run --silent cli -- verify > artifacts/verify.json
npm run --silent cli -- rollback > artifacts/rollback.json
```

Every command emits a single versioned JSON object. Errors emit a sanitized JSON object to stderr. Exit `0` means the requested observation or verified transition completed; exit `2` means a blocked plan, invalid recovery data, validation failure, exhausted retries, lock contention, or failure to establish safety. A failure that successfully restores baseline still exits `2`. Termination by an OS signal can use the shell's signal exit status; it is never a success.

`plan [bundle]` defaults to `dist/worker.js`, reads the live routes, both active deployments and settings, the optional journal, and bundle digest. It emits ordered actions, blockers, and exact final route intentions expressed through aliases and existing IDs. With unchanged inputs its JSON is byte deterministic: no generation timestamp or random run ID. It makes no local or remote mutation; shell redirection above is the operator's explicit evidence capture. Unsupported/malformed API state fails rather than inventing a baseline. A plan is an observation, not an approval token: apply always re-reads live preconditions.

`apply [bundle]` defaults to `dist/worker.js`. It records durable intent, uploads an unactivated candidate version using multipart metadata and strict binding inheritance from the captured candidate version, activates it only on the candidate, validates canary, cuts over production, verifies, and cleans up. Rerunning with the same bundle and a complete journal performs fresh authenticated/public verification without uploads or route mutations. If that verification fails, apply attempts guarded recovery and exits nonzero. A different bundle is refused while the journal belongs to the earlier rollout.

`status` is read-only and reports live state separately from the journal phase/scope; absent live production is always reported as absent. `verify` is read-only and requires a complete, matching journal plus matching live deployment/settings/routes and a passing production contract. It does not silently repair anything.

`rollback` obtains the same scope lock and validates the baseline, live identities, settings, candidate version/deployment ID, and mutation intent. It restores the original production route's Worker without changing its route ID. The stable Worker and its exact original deployment have been retained, so production returns to that deployment without a new stable upload. If the candidate was activated, rollback reactivates its captured prior version distribution; Cloudflare creates a **new deployment ID** for this restoration, which the journal records. Repeated rollback re-verifies state without creating another deployment. A journal cannot resurrect an old deployment ID. Foreign, corrupt, incomplete, or drifted recovery data is refused.

## State-machine invariants and interruption recovery

The journal at `.rollout/journal.json` is checksummed, schema-validated, atomically replaced, and fsynced with its containing directory. It stores aliases and audit identifiers, never runtime credential values. Each remote mutation is preceded by durable intent. Transitions progress through:

```text
prepared -> uploading -> uploaded -> deploying -> deployed
 -> canary-intent -> canary-ready -> validated -> cutover-intent
 -> production-verified -> cleanup-intent -> complete

any recoverable failure/interruption -> rollback-intent -> rolled-back
```

An existing canary can go directly from `canary-intent` to validation; `canary-ready` records a newly created route's returned ownership ID. Completion is saved only after public production validation and independent final route/deployment/settings verification.

Production cannot be changed until the full canary contract passes and live preconditions are checked again. The baseline includes the original production/canary routes, both active deployments with version percentages, and settings/identity digests. Stable deployment or route-ID drift invalidates recovery. A new candidate deployment with even the same version but an unexpected deployment ID invalidates a completed journal.

After interruption, run `status` and `plan` before `apply` with the same bundle or explicit `rollback`. An incomplete apply reconciles live state, restores and verifies baseline first, then resumes using a recorded candidate version when available. It never blindly replays a completed POST. Uploads whose response was lost may leave an unactivated version; these are retained, never guessed at or deleted.

API requests time out after 10 seconds; reads/idempotent writes have at most four attempts with exponential backoff. HTTP 429 honors numeric/date `Retry-After`; delays over the 30-second per-retry budget fail so the operator can wait for the limit window. POSTs are not automatically replayed after a timeout or 5xx. Activation, route update, and deletion outcomes are reconciled with live reads. Public probes time out after 5 seconds and get six bounded rounds to allow propagation; authenticated convergence gets six polls. Malformed JSON and incomplete envelopes fail closed.

Normal exit and exceptions release the lock. A killed process or power loss can leave a lock directory named `worker-route-cutover-<scope>.lock` under the OS temporary directory. Inspect its `owner.json` PID and start time and confirm the owning process has stopped before removing **that lock only**. The CLI does not automatically steal abandoned locks: PID reuse, a missing owner file, and competing recovery processes make that unsafe. Preserve the journal, then rerun status and rollback/apply. Do not remove a live process's lock or discard the journal to get past an error.

If the API created a canary route but its ID was not durably recorded, ownership cannot be proven. Recovery restores production when its baseline remains safe, retains the ambiguous route, and exits `2`. Resolve ownership through independent operator audit; do not adopt or delete a route merely because its hostname matches. Pre-existing canary routes are restored to their original target, including a disabled/null target, and are never deleted. Owned temporary routes are removed only after production endpoint verification. If cleanup or restoration cannot be verified, the recovery intent remains pending.

A future rollout with different code requires a verified rollback and archival of the earlier sanitized journal/evidence. Do not overwrite active recovery data or deploy new code into a candidate currently serving production.

## Controlled live drill and evidence

When Cloudflare access is available, use the same built bundle throughout this sequence:

1. Save the read-only plan and baseline status. Confirm no blockers and review the exact scope and mutations.
2. Run apply, then verify. Save the successful canary validation, candidate version/deployment ID, and first production cutover evidence.
3. Run rollback. Independently run status in a new process, compare production route ID/target, unchanged stable deployment/settings, restored candidate version percentages, and original canary state to baseline. Publicly probe the configured production endpoint from the network. Do not perform final cutover until all drill comparisons pass.
4. Save another plan, apply the same bundle, and verify from a new process. Confirm the candidate deployment and production route through the authenticated read as well as public probes.
5. Review cleanup: absent original canary means only the recorded owned route is gone; existing original canary means its same ID and target remain.

`artifacts/rollout-evidence.json` contains schema version, baseline route/deployment identifiers, bundle digest, candidate version and deployment IDs, restored candidate deployment ID, timestamped state and verified production route transitions, validation check names, final authenticated state, and the cleanup decision. Preserve drill/apply/rollback outputs separately because a later apply replaces that evidence file. JSON field order is stable; actual observation times and provider-issued identifiers vary. None of these outputs authorize deleting unrelated resources.

For this repair run, Cloudflare access was unavailable and the operator explicitly limited work to tasks not requiring it. `artifacts/pre-change-summary.json` and `artifacts/repair-evidence.json` record that limitation. Their live identifiers and verification results are null/unavailable; mocked lifecycle tests are labeled separately and must not be treated as live evidence.

API behavior follows Cloudflare's [deployment API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/) and [version upload API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/), including strict binding inheritance and separate version/deployment identifiers.
