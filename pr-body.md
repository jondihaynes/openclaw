Closes #119592
Related: #127785 (moving to `review` is intentionally unchanged here)

Title: `fix(workboard): moving a claimed card to done or blocked leaves its owner unable to start new work`

## What Problem This Solves

Fixes: a dispatched Workboard card moved to done or blocked with `workboard_move` (or Gateway update, bulk update, reassign, or release with a status) keeps its claim, its running execution, and its open attempts, so its owner's next card never starts.

## User Impact

User impact: moving an in-flight card to done or blocked now ends its run the same way `workboard_complete` and `workboard_block` do. The owner's slot is freed, attempts are closed, and subscribers get the matching completed/failed notification. A move to blocked counts as a failed attempt, as `block()` already does, so retry budgets see it. Moving a card to `review` behaves as before.

## Why This Change Was Made

`complete()` and `block()` tear the run down, but every other status writer went straight to `updateCard`, which never did. Owner-slot admission treats a running execution, or a claim on a card that is not done, as busy, so the stale state kept the slot occupied.

Every status writer reaches `updateCard`, so the teardown now runs there. It applies only to a manual transition into done or blocked that would still leave a claim, a running execution, or a running attempt. It reuses the existing `finishRun` teardown.

- `complete()`, `block()` and `reclaim()` already clear the run before they write, so they never get a second teardown or a second failure count. Tests cover this.
- Lifecycle-sourced writes (`syncLifecycle`, which carries a fresh `lifecycleStatusSourceUpdatedAt`) are excluded. They keep their own reconciliation (#122911 is not touched).
- Owner-slot accounting (`store-constants.ts`) is unchanged, including heartbeat grace and the capacity of claimed review cards (#88892, #114564).
- The teardown is computed from the card revision being written. `move()` already rebuilds it on every compare-and-swap retry and rechecks claim scope, so a claim reassigned concurrently still rejects the move.
- `finishRun`, the notification helper and the existing lifecycle-source preamble of `updateCard` move to `store-status-write.ts`, so `store-core.ts` stays within its line-cap ratchet. There's no behavior change in the moved preamble.

Accepted edge case: the dispatcher's retry-exhausted path, which blocks unclaimed cards, could in principle hit a card that is unclaimed but still has a running execution. That card would get its execution finalized and one extra failure counted. Its retry budget is already exhausted at that point.

## Evidence

Focused regression tests in `extensions/workboard/src/tools.test.ts` ("workboard terminal status writes"). They run against the real SQLite store, through the dispatch path: claim, then prepare and accept the execution launch.

| Test | Base (upstream/main) | This branch |
|---|---|---|
| `workboard_move` to done: claim cleared, execution done, attempt succeeded, completed notification, owner's next card claimable | ❌ | ✅ |
| `workboard_move` to blocked: same, attempt blocked, `failureCount` 1, failed notification | ❌ | ✅ |
| `update` to done releases the run | ❌ | ✅ |
| `reassign` to done releases the run | ❌ | ✅ |
| Move to review keeps the claim and running execution | ✅ | ✅ |
| `complete()`: one succeeded attempt, no failure, one notification (no double teardown) | ✅ | ✅ |
| `block()`: exactly one blocked attempt, `failureCount` 1, one notification | ✅ | ✅ |
| A blocked card written as blocked again via move/update keeps `failureCount` 1 | ✅ | ✅ |
| Another owner without the claim token is rejected and the card is unchanged | ✅ | ✅ |

Local gates on Windows 11 with Node 24.22.1:
- `tsgo` passes for both `tsconfig.extensions.json` and the extension test config.
- oxlint passes on the changed files.
- `oxfmt --check` passes.
- The line-cap ratchet passes.
- `pnpm test:extension workboard`: 358 passed and 11 failed. The same 11 also fail on unmodified upstream/main on this Windows host (workspace/sandbox path assertions in command, dispatcher, gateway and tools tests, plus an EPERM temp-dir cleanup), so they are pre-existing and platform-specific. PR CI covers Linux.

Gap: I did not complete an isolated-Gateway run on this host. The QA live-lane E2E setup refuses to prepare build artifacts here. Its `live-gateway-dist-fence` cannot verify on Windows that the checkout is separate from the locally installed OpenClaw desktop Gateway task, and I did not bypass the fence. I'm happy to add a redacted mock-openai Gateway trace from a Linux run if reviewers want one.
