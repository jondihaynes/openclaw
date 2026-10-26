Closes #119592
Related: #127785 (moving to `review` is intentionally unchanged here)

Title: `fix(workboard): moving a claimed card to done or blocked leaves its owner unable to start new work`

## What Problem This Solves

Fixes: a dispatched Workboard card moved to done or blocked with `workboard_move` (or Gateway update, bulk update, reassign, or release with a status) keeps its claim, its running execution, and its open attempts, so its owner's next card never starts.

## User Impact

User impact: moving an in-flight card to done or blocked now ends its run the same way `workboard_complete` and `workboard_block` do. The owner's slot is freed, attempts are closed, and subscribers get the matching completed/failed notification. A move to blocked counts as a failed attempt, as `block()` already does, so retry budgets see it. Moving a card to `review` behaves as before.

## Why This Change Was Made

`complete()` and `block()` tear the run down, but every other status writer went straight to `updateCard`, which never did. Owner-slot admission treats a running execution, or a claim on a card that is not done, as busy, so the stale state kept the slot occupied.

Every status writer reaches `updateCard`, so the teardown now runs there. It applies only to a manual transition into done or blocked. When the write ends an active run (a running execution or running attempt), it reuses the existing `finishRun` teardown: release the claim, finish the execution, close attempts, count a failure for blocked, and add the completed/failed notification. When only a stale claim is left after the run already ended, the claim is just released: no notification, failure count untouched, because `updateCard` re-derives the attempt and failure count from the execution and a finished run must not be reported as failed.

- `complete()`, `block()` and `reclaim()` already clear the run before they write, so they never get a second teardown or a second failure count. Tests cover this.
- Lifecycle-sourced writes (`syncLifecycle`, which carries a fresh `lifecycleStatusSourceUpdatedAt`) are excluded. They keep their own reconciliation (#122911 is not touched).
- Owner-slot accounting (`store-constants.ts`) is unchanged, including heartbeat grace and the capacity of claimed review cards (#88892, #114564).
- The teardown is computed from the card revision being written. `move()` already rebuilds it on every compare-and-swap retry and rechecks claim scope, so a claim reassigned concurrently still rejects the move.
- `finishRun`, the notification helper and the existing lifecycle-source preamble of `updateCard` move to `store-status-write.ts`, so `store-core.ts` stays within its line-cap ratchet. There's no behavior change in the moved preamble.

Accepted edge case: the dispatcher's retry-exhausted path, which blocks unclaimed cards, could in principle hit a card that is unclaimed but still has a running execution. That card would get its execution finalized and one extra failure counted. Its retry budget is already exhausted at that point.

## Evidence

Focused regression tests in `extensions/workboard/src/tools.test.ts`. They run against the real SQLite store, through the dispatch path: claim, then prepare and accept the execution launch. Each case catches a distinct failure:

| Test | upstream/main | This branch |
|---|---|---|
| `workboard_move` to done / to blocked: claim released, execution finished, attempt closed, failure count and notification match `complete()`/`block()`, owner can claim again | ❌ / ❌ | ✅ / ✅ |
| `update` to done (Gateway update and bulk) releases the run: proves the fix sits at the shared write boundary, not only in `move()` | ❌ | ✅ |
| Move to done / to blocked after the run already ended: only the claim is released, no notification, failure count 0 | ❌ / ❌ | ✅ / ✅ |
| `block()` then blocked writes via move and update: one blocked attempt, failure count 1, one notification (guards against double teardown; fails with failure count 2 if the teardown ran on top of `block()`) | ✅ | ✅ |
| Existing "moves cards with agent claim scope": now also asserts a review move keeps the claim (guards the review exclusion; fails if review is treated as terminal) | ✅ | ✅ |

The two guards (the last two rows) were checked by deliberate mutation: deciding the teardown from the pre-write card state, and adding review to the terminal set. Each makes its guard fail.

Test cost: `tools.test.ts` goes from 13 tests in 31.3s to 19 tests in 35.3s (`pnpm test extensions/workboard/src/tools.test.ts --maxWorkers=1`, Windows host).

Local gates on Windows 11 with Node 24.22.1:
- `tsgo` passes for both `tsconfig.extensions.json` and the extension test config.
- oxlint passes on the changed files.
- `oxfmt --check` passes.
- The line-cap ratchet passes.
- `pnpm test:extension workboard`: 355 passed and 11 failed. The same 11 also fail on unmodified upstream/main on this Windows host (workspace/sandbox path assertions and an EPERM temp-dir cleanup). On Linux the full workboard suite passes.

Independent review: the OpenClaw `autoreview` skill with the Codex engine (`--mode branch --base upstream/main --max-priority P2 --thinking high`, with `store-card-helpers.ts`, `store-promote.ts` and `store-workflow.ts` as source context) reported scoped-clean, "patch is correct (0.87)".

Gateway proof: an isolated Gateway with the mock-openai QA lane, driving the real `workboard_move` tool through `tools.invoke`. <!-- add the redacted before/after trace from the Linux run here -->
