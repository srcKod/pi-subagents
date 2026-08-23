# Task-Management Reference Branch

**Branch:** `feature/task-management-v2` — based on upstream main `30352a52` (v0.54.0).

This is a **reference implementation for review — not a PR**. It demonstrates a thin
task-semantics layer between decomposition and dispatch: the orchestrator declares
intent, the framework owns safety. The intended end state is an external orchestration
package that takes pi-subagents as a dependency; this branch exists as reviewable proof
that the layer is implementable against the current core.

## What problem it addresses

Current main's model selection has no concept of the work being dispatched. Three
conditions in upstream source permit three edge cases:

| Condition in main | Edge case it permits |
|---|---|
| `buildModelCandidates` orders by declaration, no cost/fit awareness | every task gets the same policy — a bulk transform rents the same model as a reasoning-heavy write |
| no context-window qualification anywhere | a 4K/8K-window model qualifies for any task; mismatch surfaces only at spend time as a 413 (worse under `context: fork`, where the inherited transcript shrinks headroom first) |
| parallel children resolve candidates independently | a whole batch can land on one rate-limited model and saturate it as a group |

Plus: nothing validates a task's shape before spend, and a fresh child's only knowledge
source is the crafted task text — underspecified work gets guessed at, expensively.

## Design principles

- **Deterministic selection; configuration stays authoritative.** Precedence is unchanged:
  explicit overrides > agent config > parent-session inheritance > configured fallback
  order. No rankings, no external benchmark data, no silent provider switches.
- **TaskProfile contract in three zones:** *declared* (kind, task text, dependencies,
  acceptance), *derived* (kind-derived budgets and a context floor the orchestrator may
  only raise), *validated* (standalone-ness, dependency completeness, kind/text
  consistency — checked before any model spend).
- **Kinds** are a coarse taxonomy (`code-write`, `code-read`, `transform`, `summarize`,
  `search`), each mapping to a defaults record. Dispatch without a kind is exactly
  today's behavior — fully backward compatible.
- **Right-sized selection:** candidates must pass the kind's context floor and capability
  tags and stay out of the exclusion store; among qualifiers, cheapest-first from static
  registry metadata. Parallel batches prefer distinct models (hard cap per model,
  undersized pool surfaced as a signal) — deterministic set policy over the configured
  pool, no mid-flight re-selection.
- **Overflow = re-decompose, never re-select.** Floors prevent it; validators catch
  coarse tasks pre-spend.
- **Deliberately dumb:** no leaderboards, no headroom tracking, no quality ranking.

## Commits (oldest → newest)

| Commit | What it adds |
|---|---|
| `97bcb4dd` feat: task profile, planner, validator, work-candidate core | `task-profile.ts`, `task-planner.ts`, `task-validators.ts` (7 validators), `task-context-floor.ts`, `task-to-chain.ts`, `work-candidate-selection.ts`, `model-capabilities.ts`, `TaskProfile` types in `shared/types.ts` + 5 unit test files |
| `fd212ebc` feat: integrate task profiles into the dispatch pipeline | optional `profiles` on dispatch params; qualification wired into `buildModelCandidates`; batch diversity in `async-execution.ts`; failure recording into the exclusion store; `task-dispatch.test.ts` |
| `94cc491b` docs: port task-decomposition skill | `skills/task-decomposition/SKILL.md` — the mutable-intelligence half ships as a curated skill, not code |
| `95b887ab` docs: adapt skill to the v2 runtime | skill rewritten against the ported runtime |
| `246bcf97` docs: align terminology | naming consistency between skill and code |

## Key files

```
src/runs/shared/task-profile.ts            TaskProfile schema + KIND_DEFAULTS
src/runs/shared/task-validators.ts         pre-spend validation (reject/warn/override)
src/runs/shared/task-planner.ts            kind inference / planning helpers
src/runs/shared/task-context-floor.ts      per-kind context floors (incl. legacy floor)
src/runs/shared/task-to-chain.ts           profile → chain-step translation
src/runs/shared/work-candidate-selection.ts  deterministic qualification + batch diversity
src/runs/shared/model-capabilities.ts      capability tags + qualification checks
src/runs/background/async-execution.ts     dispatch integration (profiles param)
src/runs/shared/model-fallback.ts          qualification hook in candidate building
skills/task-decomposition/SKILL.md         decomposition guidance (markdown, not code)
```

## Verification

```bash
npm install
npm run typecheck          # clean
# task-specific unit tests (85 tests):
node --experimental-strip-types --import ./test/support/isolated-temp-root.mjs --test \
  test/unit/task-profile.test.ts test/unit/task-planner.test.ts \
  test/unit/task-validators.test.ts test/unit/task-to-chain.test.ts \
  test/unit/work-candidate-selection.test.ts test/unit/task-dispatch.test.ts
```

Full unit suite maintains parity with clean main (one pre-existing upstream failure in
`agent-management.test.ts` reproduces identically on unmodified main).

## Status & scope

- Live-dispatch verification run: pending.
- Not included here (deliberately — follow-up material): validator tuning specifics,
  per-kind budget numbers rationale, selection tie-break mechanics, per-model cap
  internals.
- Related design discussion targets the two public seams core doesn't expose yet:
  a public model-failure report hook and read-only model-info helpers.
