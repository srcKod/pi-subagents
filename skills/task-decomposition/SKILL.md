---
name: task-decomposition
description: |
  Shape work into standalone, weak-model-digestible tasks before dispatching to
  subagents. Use whenever a project or multi-step request needs decomposition
  into a task graph (parallel, chain, or mixed). Provides the decomposition
  intelligence that the task-management framework validates: how to classify
  task kinds, declare dependencies, write checkable acceptance criteria, and
  avoid the failure modes (implicit context, undeclared deps, oversized tasks)
  that cause context overflow and dead subagents. Triggers: "break this down",
  "split into tasks", "decompose", "parallelize", "plan the work",
  "task graph", "divide and conquer", multi-step project dispatch, any time
  more than one subagent will be launched for a single goal. This skill
  accumulates decomposition lessons over time — check the Lessons section and
  memory before decomposing.
---

# Task Decomposition

> This is the **mutable intelligence layer** of the task-management architecture.
> The framework (validators, work candidate selection, exclusions) is immutable scaffolding.
> This skill is the only part that needs to be good — and it improves through
> curation, not code changes. Append lessons as you learn them.

## The One Principle

**Design for the weakest model that will run the task.**

A well-decomposed task succeeds on any qualifying free model. A poorly-decomposed
task fails on expensive models too — it just costs more before it dies. The
framework picks the cheapest model that qualifies; your job is to make the task
survivable on that model. Decomposition quality is the whole bet.

Precision on "weakest/cheapest": the framework's actual selection is the **cheapest free model that qualifies** by cost, context-window, and capability tags — it does NOT rank by output quality. So a model being merely "good enough" (e.g. a mid-tier free model) is the expected, intended outcome, not a deficiency to work around. Likewise, the framework's acceptance scoring is structural/schema-based, not a judgment of output quality: a correct result can be scored "rejected" on shape (e.g. a missing required evidence field), which is a false negative, not proof the task failed. See the [acceptance] [false-negative] lesson.

## The Contract

When you decompose, you produce a list of **TaskProfile** objects. Each has:

```
DECLARED (you fill these):
  id            — stable handle (e.g. "auth-1", "migrate-read")
  kind          — one of: code-write | code-read | transform | summarize | search
  task          — the full, self-contained instruction
  dependsOn[]   — ids of tasks that must complete before this one starts
  acceptanceCriteria[] — checkable success conditions (NOT "works correctly")
  needsReasoning? — true only if the task requires hard reasoning (default false)
  stakes?       — "high" only for critical tasks; the opt-in verifier is a future hook (v1 is failure-only by default)

DERIVED (framework fills, you can only raise estimates):
  toolBudget, tokenBudget, contextFloor, capabilities — from kind defaults
                (only matchable capabilities are enforced in selection — currently "reasoning";
                 the rest are advisory, not model-exclusion filters)

VALIDATED (framework checks, may reject):
  estimatedInputTokens — your guess; bumped to floor if below kind minimum
  standalone-ness      — no "the above", "as mentioned", "its output", "previous"
  dep-completeness     — every task you reference in text must be in dependsOn
  kind-consistency     — declared kind must match task-text signals
```

## Should You Decompose At All?

Decomposition has a cost: coordination overhead, dependency bookkeeping, and a
profile per task. Don't pay it for work that's already atomic. **You have the
full task context — you decide, not the framework.**

### Decompose when the task has…

- **Multiple natural seams** — independent parts, ordered steps, or
  parallel-safe work that would otherwise run serially in one bloated task.
- **Heterogeneous resource needs** — one part is a cheap `code-read`, another
  is a heavy `code-write`. Splitting lets each run on the right model.
- **A size that risks overflow on a weak model** — if the task would consume
  most of a 128k window, it's not atomic; split it.
- **Separate acceptance signals** — the parts have distinct done-conditions,
  so failure in one doesn't waste the work of the others.
- **Reusable intermediate output** — one task's output feeds several others
  (diamond / map-reduce shape). Splitting lets the shared work run once.

### Don't decompose when the task is…

- **Already atomic** — one coherent action, one acceptance signal, fits
  comfortably in context. Dispatch it as a single task; let the model work.
- **Tightly coupled** — the parts can't be specified without referencing each
  other, so decomposition would just add forward-ref violations. Keep it whole.
- **Smaller than the coordination cost** — a 30-line fix doesn't need a task
  graph. The overhead of profiling + validating exceeds the work.
- **Exploratory / undefined** — if you can't write checkable acceptance
  criteria, you don't understand it yet. Do the work first (or a `search`/`code-read`
  recon task), then decompose the now-understood result.

### The gate test

Before decomposing, ask: *"If I sent this as a single task to the cheapest
qualifying model, would it most likely succeed?"*

- **Yes** → don't decompose. Dispatch it. Save the coordination cost.
- **No, because of size** → decompose by splitting the work.
- **No, because of structure (ordered / parallel parts)** → decompose by seam.
- **No, because it's undefined** → don't decompose yet; run a recon task first.

This judgment is yours. The framework won't force decomposition on a single
task — it profiles and validates whatever you hand it, including a list of one.
Over-decomposition (splitting atomic work) is as much a failure mode as
under-decomposition; it wastes coordination budget and creates needless
dependencies. When in doubt, start coarser and let a runtime overflow signal
tell you to split.

## Decomposition Procedure

### Step 1: Identify the goal and the output

Before splitting, state in one sentence: *what artifact does this produce, and
how will we know it's done?* If you can't, you don't understand the work yet —
don't decompose.

### Step 2: Find the natural seams

Look for boundaries where:

- One task's output is another's input (→ declare a dependency)
- Work is independent and can run in parallel (→ separate tasks, no dep)
- A sub-task requires different tools or context than its siblings (→ different kind)
- A sub-task is large enough to overflow a weak model (→ split further)

### Step 3: Classify each task's kind

| kind         | when to use                                  | example                                           |
| ------------ | -------------------------------------------- | ------------------------------------------------- |
| `code-write` | produces or modifies source files            | "implement the auth middleware"                   |
| `code-read`  | reads code to extract structure, no mutation | "map all call sites of `foo()`"                   |
| `transform`  | mechanical in→out, same shape                | "rename `jstore` → `sunet` across all migrations" |
| `summarize`  | large input → small output                   | "summarize this 200-line log"                     |
| `search`     | exploratory, finds things                    | "find where the config is loaded"                 |

**Reasoning is not a kind.** If a `code-write` task requires hard reasoning
(architectural decisions, tricky algorithm), set `needsReasoning: true`. The kind
describes the *resource shape*; `needsReasoning` describes the *strength need*.

### Step 4: Write self-contained task instructions

Each task must be runnable by a fresh subagent with **zero context from sibling
tasks**. Rewrite any task that references:

- "the above" / "as mentioned" / "see earlier" → **inline the actual content**
- "its output" / "the previous task's result" → **either declare a dependency and
  pass the output, or inline the expected input**
- "we" / "our" / implicit shared state → **spell out exactly what state**

This is the #1 failure mode. The post-mortem documented it: 3 of 6 parallel
subagents died because their tasks referenced shared implicit context that the
weak model couldn't reconstruct. **Every task is an island.**

### Step 5: Declare dependencies explicitly

- If task B needs task A's output: `dependsOn: ["A"]`.
- If tasks are independent: `dependsOn: []`.
- The framework topologically sorts these into batches. Independent tasks run in
  parallel; dependent tasks wait.
- **Never leave a dependency implicit.** If the task text assumes another task
  ran, that task id MUST be in `dependsOn` — or the validator rejects it.

### Step 6: Write checkable acceptance criteria

Each task needs at least one condition that a cheap model (or the framework) can
verify without judgment:

- ✅ "file `src/auth.ts` exists and exports `verifyToken`"
- ✅ "all call sites of `foo()` are renamed to `bar()`" (grep-checkable)
- ✅ "migration runs without error on the test DB"
- ❌ "works correctly" (too vague — validator warns)
- ❌ "is good" (too vague)
- ❌ "is complete" (meaningless)

For `stakes: "high"` tasks, criteria should be concrete assertions the future
opt-in verifier can check — write them as concrete assertions, not vibes (v1 is
failure-only by default; the verifier is a documented future hook).

### Step 7: Estimate input tokens (be honest)

Give your best guess at the input size. The framework will:

- Bump it to the kind's floor if you under-estimate (non-negotiable).
- Reject the task if it exceeds the ceiling (~50k) — **this means your split is
  too coarse; decompose further.**

The estimate is a **decomposition-quality signal**, not a model-fit signal. If
you're hitting the ceiling, the task is too big for a weak model to digest —
split it, don't reach for a bigger model.

### Step 8: Check memory for past failures

Before finalizing, search for decomposition failures on similar work:

- `memory_search("decomposition failure")` or `memory_search("<domain> task overflow")`
- If a similar project failed before, check the **Lessons** section below for the
  fix.
- If you hit a new failure during this run, append a lesson (see § Lessons).

## The Guardrails (what the framework rejects, and how to fix)

| #   | Rejection                          | Why                                            | Fix                                                    |
| --- | ---------------------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| 1   | Empty task / no criteria           | Can't dispatch without a done-condition        | Write the task + at least one checkable criterion      |
| 2   | Estimate below floor               | Under-provisioning                             | Auto-corrected; just be more honest next time          |
| 3   | Not standalone                     | Weak model can't resolve forward refs          | Inline the referenced content or declare the dep       |
| 4   | Undeclared dependency              | Task assumes another ran but didn't declare it | Add the task id to `dependsOn`, or inline the input    |
| 5   | Over ceiling (~50k)                | Task too big for weak model                    | Split into 2+ smaller tasks; declare deps between them |
| 6   | Vague criteria (warn only)         | Can't check "works correctly"                  | Rewrite as a concrete, checkable condition             |
| 7   | Kind contradiction (override+warn) | Declared kind contradicts task text            | Reclassify; the framework will override and warn you   |

**Validators 3 and 4 are the ones that catch the post-mortem's failure.** They're
cheap regex checks with outsized value. When the framework rejects your task, it
returns the *specific* reason — fix exactly that and re-profile.

## Decomposition Patterns

Recurring shapes. Use these as starting points, not rigid templates.

### Linear chain

```
A → B → C
```

Each task feeds the next. Declare `dependsOn` linearly. Good for: migrations,
refactors with ordering, build-then-test.

### Parallel fan-out (independent)

```
[A, B, C] (no deps between them)
```

All run in one batch. Good for: applying the same transform to different files,
independent feature implementation. **Batch-diversity**: the framework prefers
distinct models per task — don't assume all will run on the same model.

### Parallel fan-out (shared read, independent write)

```
    read
   /  |  \
  A   B   C
```

One `code-read` task produces a shared artifact (map, index, summary); N
independent `code-write` tasks depend on it. Good for: "find all call sites,
then fix each one."

### Diamond

```
  A
 / \
B   C
 \ /
  D
```

A produces shared context; B and C run in parallel using it; D assembles.
Good for: research-then-implement-then-integrate.

### Map-reduce

```
[split] → [map₁, map₂, ..., mapₙ] → [reduce]
```

One task splits work; N parallel tasks process chunks; one task assembles.
Good for: bulk transformations across many files. The split task must produce
**explicit chunk boundaries** (file lists, line ranges) — never "split the work
evenly" without saying how.

## Runtime Integration (how your tasks run)

### Context shaping — use context-mode

For any task that will process large outputs (logs, test runs, API responses,
file dumps), instruct the subagent to use context-mode tools (`ctx_execute`,
`ctx_execute_file`) instead of dumping output into its own context. The
task instruction should say: *"Analyze the output via ctx_execute; print only
findings, not raw output."*

This is how the framework keeps weak models from drowning in runtime context —
not by picking a bigger model, but by shaping the context at runtime via the
existing context-mode package.

### Tool budgets

Each kind has a default tool budget. For tasks that need more (heavy
exploration, many file edits), raise the estimate — the framework will use the
higher of your estimate and the kind default.

### Overflow = re-decompose, never re-select

If a task overflows at runtime, the framework does **not** swap to a bigger
model. It signals re-decompose: the task comes back to you for further
splitting. This is deliberate — overflow means the task was too big, and a
bigger model would just delay the same failure. Split it.

### Exclusion-driven rotation

If a model rate-limits (429/quota), the framework records an exclusion (with
TTL) and rotates to the next candidate. You don't manage this — but you should
know it happens. If the *same* model keeps getting excluded, that's a
provider-side issue, not a decomposition problem.

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

- [ ] Can I state the goal and final output in one sentence?
- [ ] Is every task self-contained (no "the above", "its output", "as mentioned")?
- [ ] Is every cross-task reference declared in `dependsOn`?
- [ ] Does every task have at least one checkable acceptance criterion?
- [ ] Is every task's estimated input below the ~50k ceiling (or split further)?
- [ ] Did I check the Lessons section + memory for past failures on similar work?
- [ ] For large-output tasks: did I instruct the subagent to use context-mode?
- [ ] For parallel dispatch with worktree: true: did I run git stash or git commit first? (worktree requires clean tree)
- [ ] For parallel dispatch: is asyncByDefault set correctly? (async = no splash, fg = PTY splash)
- [ ] For parallel dispatch: are tasks unique enough to avoid overlap?
- [ ] After modifying extension source: did I fully restart pi agent? (/reload is interactive-only)

If any answer is "no", don't dispatch — fix the decomposition first. The
framework will reject bad shapes anyway; fixing them upfront saves a round-trip.
