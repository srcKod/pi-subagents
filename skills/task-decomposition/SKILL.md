---
name: task-decomposition
description: Decompose work into TaskProfiles for parallel subagent dispatch — when to decompose, how to size and type tasks, how model selection works, and what the validators will reject.
---

# Task Decomposition

> **Port note (v2).** This skill was written against pi-subagents v0.40.x. The
> task-management feature it documents has since been ported to v0.46.0+ and
> reworked. All API names, defaults, and behaviors below reflect the **v2**
> implementation (`src/runs/shared/schemas.ts`, `task-validators.ts`,
> `task-model-selection.ts`, `model-capabilities.ts`, `model-fallback.ts`,
> `model-exclusions.ts`). The **Lessons** section is preserved verbatim from the
> original — its principles still hold even where file paths have moved.

## The One Principle

Decompose so that each subagent gets **one task, one context, one budget** — and
so that the parent never blocks on a child.

A task profile is a *contract*, not a prompt. It declares what "done" looks like,
what kind of work it is, and what resources it needs. The runtime turns those
declarations into budgets, model candidates, dependency ordering, and failure
handling. Your job as the decomposer is to make the contract precise enough that
the machinery can do its job.

**On model selection precision:** selection is *cheapest-free-that-qualifies*,
then cheapest-paid, with free-vs-paid decided per-model by `isFree` (zero
advertised cost or a name containing `free`) — not by a global "free tier"
notion. Context qualification uses `modelQualifies`: the model's advertised
context window must cover `requiredContext + COMPACTION_RESERVE` (16,384), where
`requiredContext = max(estimatedInputTokens, kindFloor)` and the kind floor comes
from `KIND_DEFAULTS` (fallback 16,000). Capability matching intersects declared
needs (`capabilities`, plus `reasoning` when `needsReasoning`) with advertised
model capabilities. If no candidate qualifies, the parent model remains the
last-resort executor — decomposition degrades gracefully rather than failing.

## The Contract

```ts
interface TaskProfile {
  id: string;
  kind: 'code-write' | 'code-read' | 'transform' | 'summarize' | 'search';
  task: string;                       // full self-contained instructions
  dependsOn?: string[];               // IDs of tasks that must finish first
  acceptanceCriteria: string[];       // machine-checkable done conditions
  model?: string;                     // explicit pin (highest precedence)
  needsReasoning?: boolean;           // adds 'reasoning' capability requirement
  stakes?: 'normal' | 'high';         // high → stricter validation, wider floors
  toolBudget?: { maxToolCalls?: number; maxReads?: number; blockedTools?: string[] };
  tokenBudget?: number;               // output token ceiling for the child
  contextFloor?: number;              // minimum usable context required
  capabilities?: ModelCapability[];   // e.g. ['vision'] in addition to kind defaults
  estimatedInputTokens?: number;      // your own estimate of child input size
  testBaseClass?: string;             // base class/path the child must extend
}
```

**What actually reaches the model selector** (v2): only `profile.model` is read
directly. Everything else flows through `toSelectionInput(profile)`, which
computes:

- `requiredContext` — `max(estimatedInputTokens ?? floor, floor)` where
  `floor = KIND_DEFAULTS[kind]?.contextFloor ?? 16_000`
- `capabilities` — union of declared capabilities and `reasoning` if
  `needsReasoning`; the selector then intersects with what the model advertises

Fields like `toolBudget`, `tokenBudget`, `stakes`, `contextFloor`, and
`testBaseClass` are enforced elsewhere (validators, runner budgets) — they do
not participate in model choice except via `requiredContext`.

### Kind defaults (v2)

| Kind         | Context floor | Token budget | Tool calls (normal/high) | Default blocked tools |
|--------------|--------------:|-------------:|-------------------------|-----------------------|
| code-write   | 8,192         | 65,536       | 80 / 120                | none                  |
| code-read    | 16,384        | 32,768       | 60 / 90                 | write, edit           |
| transform    | 4,096         | 16,384       | 40 / 60                 | none                  |
| summarize    | 2,048         | 8,192        | 20 / 30                 | ctx_execute           |
| search       | 6,144         | 16,384       | 40 / 60                 | write, edit           |

`CONTEXT_CEILING` is 50,000 estimated input tokens — profiles above it are
rejected outright (see Guardrails).

## Should You Decompose At All?

Ask these before creating any TaskProfile:

1. **Would a competent engineer need to hold all of it in their head at once?**
   If no — don't decompose.
2. **Are there pieces whose results don't affect each other?** Independent
   leaves are the parallelism win. If everything feeds everything, a single
   agent with good notes wins.
3. **Is any piece dominated by mechanical transformation?** (rename across
   files, format conversion, bulk find-replace) Those are cheap parallel
   `transform`/`code-write` leaves.
4. **Is verification separable from production?** Writing code and auditing it
   want different contexts. A `code-write` leaf plus an independent review leaf
   beats one agent doing both.

If you answered "no" to all four: do the work yourself. Decomposition has real
cost — coordination overhead, duplicated context loading, merge risk.

## Decomposition Procedure

1. **Identify the deliverable.** What artifact proves the whole task done? Work
   backwards from acceptance criteria at the top level.
2. **Find the seams.** Look for: independent modules/files, mechanical sweeps,
   research questions with no interdependency, verify-after-produce splits.
3. **Draft leaves first, then dependencies.** Each leaf should be describable in
   two sentences without referencing sibling leaves' internals.
4. **Write acceptance criteria per leaf.** Machine-checkable: file exists +
   contains X, command exits 0, test passes. Not: "looks reasonable".
5. **Assign kinds honestly.** The kind drives budgets, floors, and default
   tool blocks — mislabeling a `summarize` task as `code-write` wastes budget
   and can fail validators (kind/task consistency check).
6. **Declare dependencies minimally.** Only where a leaf genuinely consumes
   another's output. Every edge you add serializes the graph. Cycles are
   rejected before dispatch; undeclared dependencies are rejected too.
7. **Estimate input tokens roughly.** If a child must read a large file set,
   say so via `estimatedInputTokens` — this feeds `requiredContext` and keeps
   small-context models out of the candidate pool. Don't inflate: estimates
   above `CONTEXT_CEILING` (50,000) are hard-rejected by validators.
8. **Let the runtime pick models.** Pin `model:` only when you have a reason
   the selector can't see (license constraints, benchmarked superiority).

## The Guardrails

The v2 validator suite runs before dispatch. Rejections are terminal for the
profile; some issues are auto-corrected with a warning.

| # | Check | Severity |
|---|-------|----------|
| V1 | Reject empty `task` or empty `acceptanceCriteria` entries | error |
| V2 | Estimated input above kind floor → warn, bump floor | warning |
| V3 | Reject standalone tasks mixed into a batch (use direct spawn) | error |
| V4 | Reject `dependsOn` pointing at unknown task IDs | error |
| V5 | Reject `estimatedInputTokens > CONTEXT_CEILING` (50,000) | error |
| V6 | Warn on vague acceptance criteria ("works", "good", etc.) | warning |
| V7 | Kind/task consistency heuristic mismatch → warn, auto-correct kind | warning |

Additional build-level gates beyond per-profile validation:

- **Cycle gate**: batches are planned over the dependency graph; cycles abort
  planning before any child spawns.
- **Leaf counting**: only parallel-ready leaves count toward batch sizing;
  dynamic fanout groups are skipped in the cycle gate.
- **Unique IDs + length checks**: duplicate or missing profile IDs, empty
  batches, and oversized batches fail fast.

## Decomposition Patterns

### Fan-out map/reduce
One coordinator (you) + N independent leaves + optional reduce step.
Leaves: `kind: 'transform'` or `'code-write'`, no `dependsOn`. Reduce: depends
on all leaves. Best win: leaves touch disjoint files.

### Produce-then-audit
Leaf A writes; leaf B audits A's output with fresh eyes.
B: `dependsOn: [A.id]`, often `kind: 'code-read'`. B must NOT reuse A's context
— that's the entire point.

### Scout-then-exploit
Scout maps territory cheaply; exploit acts on findings.
Scout: `kind: 'search'` or `'summarize'`, tiny budget. In v2, static parallel
fanout is capped at `SCOUT_MAX_FANOUT = 3` scouts alongside dynamic scout
spawning — plan scouting accordingly instead of fanning out dozens.

### Pipeline
Linear chain where each stage transforms the previous output. Declare strict
linear `dependsOn`. Prefer this only when stages genuinely cannot start early;
pipelines serialize everything.

### Batch diversity
When dispatching a batch in parallel, the runtime deliberately spreads tasks
across distinct models (with a round-robin cap of 2 tasks per model) so one bad
model doesn't poison every result. Write leaves so they're individually sound —
don't rely on cross-task consistency within a batch.

## Runtime Integration (v2)

Where the machinery lives after the port:

- `src/runs/background/subagent-runner.ts` — async/single-step execution
  (formerly `subagent-executor.ts`)
- `src/runs/shared/pi-args.ts` — CLI arg plumbing
- `src/runs/shared/model-capabilities.ts` — advertised capability/context
  registry; `isFree`; `toSelectableModel`
- `src/runs/shared/model-fallback.ts` — `buildModelCandidates` (explicit
  fallbacks kept verbatim; otherwise dynamic pool sorted free-first then by
  input cost; parent appended by caller as last resort)
- `src/runs/shared/model-exclusions.ts` — TTL exclusion store fed by retryable
  failures
- Retryable vs terminal: transport/rate-limit/auth/model-missing errors retry
  with fallback; `isContextOverflow` ("input too large") is deliberately
  terminal — shrinking context mid-flight corrupts results, so overflow fails
  the leaf loudly instead of silently retrying smaller.
- Failure propagation: `blockedDependentsOnFailure(failedId, profiles)` marks
  downstream dependents blocked; surfaced on async status.

Model resolution order per leaf:
`leaf.step.model` → `profile.model` → explicit override → assignment from the
qualified pool → parent model as last resort.


## Lessons

> **This section is append-only.** Every time a decomposition fails (validator
> rejection or runtime overflow), add a lesson here: the task shape, the failure,
> the fix. Over time this becomes the domain-specific decomposition corpus.
> Format: `### [date] [domain] [failure-type]` then the pattern + fix.

*(No lessons yet. The first real decomposition failure you encounter becomes
lesson #1. Append below this marker.)*

### [2026-07-26] [dispatch integration] [test-validity / runner-path]
**Task shape**: a chain/parallel decomposition dispatched to validate a framework change to the subagent runner (nested-subagent depth, model selection, spawn args).
**Failure**: a fix committed green on unit tests died at runtime with `ReferenceError: maxSubagentDepth is not defined` in `runSingleStep` — every chain step failed before any delegation. The `pi-args` unit suite only covers `buildPiArgs`, not the runner/spawn path, so it missed the undefined variable.
**Root cause**: runner execution (`runSingleStep` → `runPiStreaming` → spawn) is not covered by unit tests; "tests green" validates only the function the tests touch.
**Fix**: treat a live chain run as the real validation gate for any change to subagent execution/spawn/env. Unit-green is necessary, not sufficient. If you can't add a runner-path unit test, say so and rely on the live run.
**Reusable signal**: "unit tests pass but the chain dies at spawn/step" → the bug is in the runner path, not `buildPiArgs`; read `runSingleStep`/`runPiStreaming`/`spawnRunner` directly.

### [2026-07-26] [model selection] [exclusion/fallback test-validity]
**Task shape**: testing the exclusion/fallback feature (a model 400/429/503 → recorded exclusion → rotate to next candidate).
**Failure**: a re-run on a healthy pool completed but never exercised exclusions; an earlier run that pinned `hy3` masked the diverse pool entirely.
**Root cause**: exclusion/fallback only triggers when a pool member actually fails. A clean run (or a forced single model) proves nothing about rotation. Champion selection picks the cheapest free qualifier, so forcing one model removes the diversity the feature needs.
**Fix**: when validating exclusion/fallback, dispatch with NO model pin and ensure at least one pool member is a model that will fail (400/429/503). A green run on a healthy pool is not evidence the exclusion path works — look for the exclusion being recorded + the next candidate tried.
**Reusable signal**: "feature test passed but no model ever failed" → you didn't exercise exclusions; pin nothing or inject a known-bad model.

### [2026-07-26] [acceptance] [false-negative]
**Task shape**: a decomposition step whose acceptance was scored "rejected" by the framework.
**Failure**: a rejected acceptance was nearly read as a real step failure, but the step's output was correct.
**Root cause**: acceptance scoring is structural/schema-based, not a judgment of output quality. A correct result can be rejected on shape (wrong report shape, missing required evidence field) — a false negative.
**Fix**: with `failFast` off (default) a rejected acceptance does NOT stop the chain. Before treating "rejected" as failure, check whether the actual task output is correct. A rejected acceptance is a signal to tighten the acceptance contract, not proof the task failed.
**Reusable signal**: "step shows acceptance: rejected but output looks right" → false negative from structural scoring; don't abort the run on it.

### [2026-07-26] [nested delegation] [depth-accounting]
**Task shape**: a chain step that itself dispatches a subagent (a verify worker delegating a focused re-check to a nested worker).
**Failure**: nested delegation died with `Tool subagent not found` because the child wasn't armed with the subagent tool; a naive fix referenced an undefined variable and killed every step.
**Root cause**: nested-subagent depth is computed from `PI_SUBAGENT_DEPTH` propagated through the spawn env. The async runner inherits the orchestrator's depth (UNSET → 0), so chain workers sit at depth 1; under default `maxSubagentDepth=2` a depth-1 worker MAY delegate (depth-2 child) — but only if armed with the subagent tool + extension. The depth math must be checked against the actual spawn code, not assumed.
**Fix**: if you add a chain step that should delegate, verify the depth arithmetic in the spawn path: a step at depth D can delegate only if `D+1 < maxSubagentDepth` AND it is armed (subagent tool + pi-subagents extension loaded). Confirm via a live run that the child emits a `subagent` tool_use, not by reasoning alone.
**Reusable signal**: "verify/nested step should delegate but dies on `Tool subagent not found`" → the child wasn't armed; check `allowNestedSubagents` depth math in `buildPiArgs`/`runSingleStep`.

### [2026-07-26] [repro] [chain-definition-loss]
**Task shape**: re-running a previously-aborted decomposition chain to confirm a fix.
**Failure**: `status.json` had empty task text and no depth info, so the chain couldn't be reconstructed from the run artifact alone.
**Root cause**: the run artifact persists outcomes (step status, models, attemptedModels) but not the task instructions or depth; the chain definition lived only in the orchestrator's dispatch call.
**Fix**: when you need to reproduce a chain test, keep the chain definition (the array of `{agent, task, label}`) in the conversation/repo, not just the run id. Recover from `subagent-log-*.md` + project files if the artifact is all you have.
**Reusable signal**: "need to re-run run <id> but only have status.json" → status.json won't give you the tasks; recover from the subagent log or your own notes.


### [2025-07-22] [dispatch integration] [validator / build-reject]

**Task shape**: a `profiles` array handed to the subagent tool for a chain or
parallel dispatch.
**Failure**: the build was rejected with either `Invalid task profile "x:"
acceptanceCriteria is empty` (validator 1) or `profiles length (N) must match the
number of dispatched subagent steps (M)` (applyProfileModels length check).
**Root cause**: two easy-to-miss dispatch constraints. (1) Every profile is
validated as a standalone TaskProfile, so `acceptanceCriteria` MUST have >=1
explicit entry and `task` must be non-empty. (2) `profiles` is paired 1:1 with
*leaf* steps in execution order, counting every task inside a parallel group as
its own profile. A chain of 3 steps needs 3 profiles; a parallel group of 4
needs 4; a chain-with-parallel needs (sequential leaves + parallel leaves).
**Fix**: before dispatching, assert `profiles.length === totalLeafSteps` and that
each profile carries at least one concrete acceptance criterion. When a parallel
group's size is dynamic, omit `profiles` entirely (the static fallback list is
used instead) rather than guessing a count.
**Reusable signal**: "profiles array rejected at dispatch" -> recount leaves
(sequential + every parallel leaf) and re-check each profile's acceptanceCriteria.


### [2026-07-27] [runner-path] [test-exit-hang / module-stdin-bootstrap]
**Task shape**: a unit-test file that imports a runner module (e.g. `subagent-runner.ts`) whose top level wires `process.stdin` data/end listeners as a CLI bootstrap.
**Failure**: every test in the file passed, but the Node process never exited — `node --test` hit the wall-clock timeout and the file was reported failed even though all assertions were green.
**Root cause**: on *import*, `process.argv[2]` is undefined, so the CLI bootstrap's `else` branch registered `process.stdin` listeners, putting stdin into flowing mode. Under `node --test` stdin never ends, so the event loop stays alive and the process hangs after tests complete. (A `Socket` handle from `console.log` is a red herring — the dangling handle is `stdin`.)
**Fix**: guard the CLI bootstrap with an `isMain` check — `const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);` — and run the stdin branch only `if (isMain)`. When imported as a library the listeners are never registered, so the loop drains and the process exits.
**Reusable signal**: "tests pass but the process won't exit under `node --test`" → a module-level stdin/stdio listener is keeping the event loop alive; guard the CLI bootstrap with isMain, don't just add a timeout.

### [2026-07-27] [model-fallback] [retry-loop test-validity]
**Task shape**: testing the model-fallback retry loop in `runSingleStep` (budget caps: maxModelAttempts / maxRunCost / maxRunTokens; rotate-through-pool on 400/429/503).
**Failure**: the first attempt was a `test/integration/budget-stress.test.ts` that never called `runSingleStep`, re-declared `attemptedModels` fresh on every loop iteration, and left `step.maxModelAttempts` undefined — so it would have PASSED vacuously (the `assert.ok(exhausted)` could never fire) and proved nothing.
**Root cause**: an integration test that stubs the whole executor can't see the retry loop. The loop only runs when `runSingleStep` actually invokes its `piRunner` and processes `attempt.success` / retryable `error` / `usage` across attempts.
**Fix**: drive the loop directly with a fake `piRunner` that returns `{ exitCode: 1, error: "400 Bad Request", usage: { input, output, cost, ... }, model, ... }` and assert on the call count (`calls.length === N`). Retryable errors match `/\b400\b|\b429\b|\b503\b/`. This lives in `test/unit/budget.test.ts` and runs via `node --experimental-strip-types --test`.
**Reusable signal**: "fallback/budget test passes" → confirm it actually exercised `runSingleStep`'s retry loop (assert on attempt count), not just imported the executor.

### [2026-07-27] [editing] [CRLF / exact-match fragility]
**Task shape**: surgical edits to source files in this repo (several are CRLF, e.g. `subagent-runner.ts`, `subagent-executor.ts`).
**Failure**: the `edit` tool's exact-text replace silently missed because the oldText's tabs/indentation or CRLF didn't byte-match the file (the read view normalizes line endings, so the displayed text lies about raw bytes).
**Root cause**: CRLF files + invisible tab/space drift make literal multi-line matches unreliable. `node --experimental-strip-types --check` confirms parse but not match.
**Fix**: for CRLF/surgical edits, write a small `*.cjs` script that does `s.replace(/regex with capture groups/, replacement)` and `fs.writeFileSync` — capture indentation/`(\r?\n)` so you don't hard-code exact tabs/CRLF. Verify with a `grep -c`/hex check, then delete the script.
**Reusable signal**: "edit tool says NOT FOUND on a file I can see" → it's a CRLF/whitespace byte mismatch; use a regex+capture-group node script, not exact text.

### [2026-07-27] [test-hygiene] [orphaned config-mutating test]
**Task shape**: a root-level `test-config-budget.test.ts` intended to validate config-file budget defaults.
**Failure**: it wrote directly to the real `~/.pi/agent/extensions/subagent/config.json` and was never picked up by `test:unit` / `test:integration` (it sat at repo root), so it mutated user state on every run and provided zero CI coverage.
**Root cause**: a test that touches real config is a side-effecting liability; placing it outside the `test/` tree means no script runs it.
**Fix**: never let a test write the real extension config. Either cover the config-merge path with a temp config under `test/integration/`, or delete the orphan and rely on the runtime-loop unit test (`test/unit/budget.test.ts`). Prefer runtime-loop coverage over config-file mutation.
**Reusable signal**: "a test at repo root mutates ~/.pi config" → it's an orphan; relocate under test/ with a temp config or delete it.

### [2026-07-27] [git-hygiene] [interleaved atomic commits]
**Task shape**: a feature branch where several concerns (test-infra fix, fallback rotation, per-run budget, blockedDependents, contract hardening, docs) interleave in the same files (`async-execution.ts`, `subagent-runner.ts`).
**Failure**: one 284-line lump commit buries the test-infra fix and the contract hardening behind the budget feature, making bisect/revert painful.
**Root cause**: `git add -A` can't separate concerns that share a file; the changes are in different hunks but the same file.
**Fix**: split into atomic commits by hunk. Parse `git diff <file>` into hunks, classify each hunk (by pre-image start line) to a concern, write a per-commit patch, and `git apply --cached --whitespace=nowarn` it (verify `--check` first), then `git commit`. Whole-file adds (`preflight.ts`, `examples/`, `docs/`) go in their concern's commit. End with `git diff HEAD --stat` empty.
**Reusable signal**: "one file carries 3 unrelated changes" → stage by hunk into separate commits; don't lump.


### [2026-07-27] [git-hygiene] [stash-loss during rebase]
**Task shape**: rebasing a feature branch onto a synced upstream main, with uncommitted design changes that need to be restored after the rebase.
**Failure**: `git stash pop` after a successful rebase produced conflicts in 5 files. Resolving these by accepting HEAD (`git checkout --theirs`) and then running `git stash drop` permanently lost ALL stashed design changes — every cap, signal, gate, and test that lived only in the stash. The stash was not recoverable. Subsequent similar attempts (stash → sync → rebase → pop) lost changes a second time because only files with `git diff HEAD` conflicts were tracked.
**Root cause**: (1) the stash contained pre-rebase code structurally incompatible with the rebased tree, so stash pop could not reconstruct the design changes. (2) `git stash drop` after conflict resolution is irreversible. (3) uncommitted design changes have no recovery path once the stash is dropped.
**Fix**: before stashing, create a backup branch: `git branch design-backup-before-stash`. This gives a second recovery path independent of the stash. After the rebase, if `git stash pop` conflicts, resolve each file individually — use `git checkout stash -- <file>` for files where feature changes matter, or `git checkout --theirs <file>` for files where upstream logic supersedes the feature. **Commit design changes immediately** after re-applying them, so a stash operation can never silently destroy them again.
**Reusable signal**: "uncommitted design changes + stash + rebase + stash drop" → create a backup branch and commit immediately after re-applying; never rely on the stash as the only copy of uncommitted work.


### [2026-08-04] [model selection] [context-overflow / small-model]
**Task shape**: dispatching 4 parallel reviewers with asyncByDefault: true and no explicit kind profiles.
**Failure**: gemma-2b (8K) and llama-2-7b (4K) selected, causing HTTP 413 overflow and garbled output.
**Root cause**: applyProfileModels only runs when profiles.length > 0; without profiles, context qualification is bypassed. Default floor was 8K (not 16K), so gemma-2b passed 8192>=8000. Fixed: 16K default floor + kind profiles with 16K floor for code-read.
**Fix**: Always dispatch parallel tasks with kind: code-read profiles (16K floor). Name-based context inference catches known small models.
**Reusable signal**: HTTP 413 / garbled on small model -> check if profiles were provided; without profiles, use 16K default floor.

### [2026-08-04] [model selection] [async-path-bug / batch-diversity]
**Task shape**: parallel reviewer dispatch with asyncByDefault=true, expecting assignBatchWorkCandidates to assign diverse models.
**Failure**: all 4 subagents inherited the parent model. maxPerModel=2 cap never landed.
**Root cause**: Async dispatch (subagent-executor.ts:3086) used behaviorOverrides[i]?.model (parent-derived) instead of modelOverrides[i] (batch-assigned). Assignments computed but discarded.
**Fix**: Use modelOverrides[i]. Verify by output logs, not load.log.
**Reusable signal**: all parallel subagents same model -> check async path uses modelOverrides[i].

### [2026-08-04] [worktree] [sync-block / terminal-splash]
**Task shape**: parallel dispatch with worktree: true and asyncByDefault: true.
**Failure**: terminal splashes/flickers during dispatch.
**Root cause**: createWorktrees uses spawnSync (synchronous), blocking parent ~2s for 4 worktrees. Foreground PTY path creates the flicker.
**Fix**: Accept brief blocking, or use worktree: false for read-only tasks.
**Reusable signal**: terminal flickers with worktree: true -> spawnSync is synchronous; expected. Use worktree: false for read-only.

### [2026-08-04] [git-hygiene] [worktree-dirty-tree]
**Task shape**: worktree: true with uncommitted changes.
**Failure**: throws: worktree isolation requires a clean git working tree.
**Fix**: git stash or git commit first.
**Reusable signal**: requires clean git working tree -> stash or commit first.

### [2026-08-04] [extension-loading] [module-cache]
**Task shape**: modifying extension TS source, expecting hot-reload.
**Failure**: changes do not take effect after /reload. load.log stale.
**Root cause**: Extension loads once via jiti/tsx from npm symlink. ESM cache persists. /reload is interactive-only. load.log from older mechanism.
**Fix**: Full process restart required. Verify by behavior, not load.log.
**Reusable signal**: changes do not take effect after /reload -> full restart required; load.log is stale.

### [2026-08-04] [decomposition] [unique-task-per-subagent]
**Task shape**: N parallel reviewers for same feature, different angles (vision/implementation/tests/architecture).
**Failure**: all read same files, overlapping findings, Nx token cost.
**Root cause**: Angle-based review is valid but shares context. maxPerModel=2 does not reduce read redundancy.
**Fix**: Split by subject matter (file ranges) instead of angle, or accept Nx as thoroughness cost.
**Reusable signal**: parallel reviewers all read same files -> subject-matter split or accept overlap.


<!--
LESSON TEMPLATE — copy, fill, append above this comment:

### [YYYY-MM-DD] [domain] [validator-N | overflow | exclusion-storm]
**Task shape**: <what the task looked like>
**Failure**: <what happened — which validator rejected it, or runtime overflow>
**Root cause**: <why it failed>
**Fix**: <how to decompose this shape correctly next time>
**Reusable signal**: <a phrase or pattern to watch for in future decompositions>
-->


## Before You Decompose — Checklist

- [ ] Every leaf passes the 4-question test in "Should You Decompose At All?"
- [ ] Each leaf has machine-checkable acceptance criteria (no vague terms — V6)
- [ ] Each leaf is self-contained: full instructions, no references to sibling internals
- [ ] Kinds are honest (V7 auto-corrects, but don't rely on it)
- [ ] `estimatedInputTokens` set for children that must read large inputs; nothing near the 50,000 ceiling (V5)
- [ ] Dependencies declared exactly — no cycles, no undeclared edges (V3/V4)
- [ ] No explicit `model:` pin without a reason the selector can't infer
- [ ] Batch leaves are individually sound (batch diversity means no cross-leaf consistency)
- [ ] Failure story: if a leaf dies, `blockedDependentsOnFailure` keeps the rest of the graph coherent — is that the shape you want?
- [ ] If it failed before: is there a Lessons entry for this shape, and does the new decomposition follow the fix?
