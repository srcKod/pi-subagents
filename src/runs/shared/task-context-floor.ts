import type { TaskKind } from "../../shared/types.ts";

/**
 * Per-kind minimum input-token floor.
 *
 * The framework bumps a task's declared `estimatedInputTokens` up to this floor.
 * Below it, even a well-decomposed task lacks the context a weak model needs to
 * ground its work. The floor is a decomposition guardrail, not a model-fit signal:
 * if a task's real input is below the floor, the decomposition probably omitted
 * context that should have been inlined.
 */
export const CONTEXT_FLOOR_BY_KIND: Record<TaskKind, number> = {
	"code-write": 8_000,
	"code-read": 16_000,
	"transform": 4_000,
	"summarize": 2_000,
	"search": 6_000,
};

/**
 * Ceiling: a task whose estimated input exceeds this is too big for a weak model
 * to digest in one pass. The validator rejects it and the orchestrator must
 * re-decompose. This is a decomposition-quality signal, never a reason to pick a
 * bigger model — overflow means the task is too coarse, not that the model is too
 * small.
 */
export const CONTEXT_CEILING = 50_000;

/**
 * Context floor applied to the LEGACY (no-profile) fallback-pool qualification.
 *
 * The profile-backed paths derive `minContext` from `bumpToFloor`, which already
 * guarantees at least the kind floor. But the legacy step-builder (which builds
 * the model-candidate list without a `TaskProfile`) used to pass `minContext: 0`,
 * so any chat-capable model qualified — including the known sub-16K window models
 * (gemma-2b 8K, llama-2-7b 4K, mistral-7b 8K) that overflowed and produced the
 * 413 errors in the failing runs. This floor excludes those tiny models from the
 * dynamic pool while letting normal models (128K default) pass through unchanged.
 */
export const LEGACY_FALLBACK_MIN_CONTEXT = 16_384;

/** Raise an estimate to its kind's floor. Estimates at or above the floor pass through unchanged. */
export function bumpToFloor(estimate: number, kind: TaskKind): number {
	const floor = CONTEXT_FLOOR_BY_KIND[kind] ?? 0;
	return Math.max(estimate, floor);
}

/** True when the estimate exceeds the ceiling and the task must be re-decomposed. */
export function exceedsCeiling(estimate: number): boolean {
	return estimate > CONTEXT_CEILING;
}
