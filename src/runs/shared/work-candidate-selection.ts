/**
 * Work candidate selection + batch-diversity (Phase 3).
 *
 * This module is the task-management layer's model-selection primitive. It is
 * deliberately COARSE — it does not rank models, track headroom, or consult a
 * leaderboard. Given a task's requirements and a pool of available models, it:
 *
 *   - selectWorkCandidate:  picks the cheapest FREE model that qualifies
 *                           (has the required capabilities and enough context),
 *                           skipping excluded models. Falls back to the cheapest
 *                           paid model only when no free model qualifies.
 *   - assignBatchWorkCandidates: for a batch of parallel tasks, prefers DISTINCT
 *                           models per task so N parallel subagents don't all
 *                           hammer the same free model (which would cause an
 *                           N x 429 burst before exclusions even propagate).
 *                           Reuses a model only as a last resort.
 *
 * The selection shape (SelectableModel) is intentionally minimal. The caller
 * (the dispatch integration in Phase 5) maps whatever model pool it has into
 * this shape. This keeps selection decoupled from main's ModelInfo, which
 * carries no price/context/capability data.
 */

import type { SelectableModel, SelectionTaskInput, WorkCandidateAssignment } from "../../shared/types.ts";
import { hasCapabilities, modelQualifies } from "./model-capabilities.ts";
export { hasCapabilities, modelQualifies };

/** Hard cap: no single model can be assigned more than 2 tasks in a parallel batch. */
const MAX_PER_MODEL = 2;

/**
 * Order: free first, then smallest context window (least over-provisioned ==
 * effectively cheapest), then fullId for a stable tiebreak.
 */
function compareModels(a: SelectableModel, b: SelectableModel): number {
	if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
	if (a.contextWindow !== b.contextWindow) return a.contextWindow - b.contextWindow;
	return a.fullId.localeCompare(b.fullId);
}

function qualifyingModels(task: SelectionTaskInput, models: SelectableModel[], excluded: Set<string>): SelectableModel[] {
	return models
		.filter(
			(m) =>
				!excluded.has(m.fullId) &&
				modelQualifies(m, task.capabilities, task.requiredContext),
		)
		.sort(compareModels);
}

/**
 * Pick the cheapest free model that qualifies for the task, skipping excluded
 * models. Returns undefined when no model qualifies.
 */
export function selectWorkCandidate(
	task: SelectionTaskInput,
	models: SelectableModel[],
	excluded: Set<string> = new Set(),
): string | undefined {
	const qualifying = qualifyingModels(task, models, excluded);
	// Free models sort first, so [0] is the cheapest free (or cheapest paid).
	return qualifying[0]?.fullId;
}

/**
 * Assign a model to each task in a parallel batch.
 *
 * Prefers a distinct model per task (batch-diversity) so parallel subagents
 * don't all hit the same free model. When there are fewer qualifying models
 * than tasks, the surplus tasks reuse an already-used model (last resort) and
 * the reused fullId is reported in `reused`.
 */
export function assignBatchWorkCandidates(
	tasks: SelectionTaskInput[],
	models: SelectableModel[],
	excluded: Set<string> = new Set(),
): WorkCandidateAssignment {
	const assignments = new Map<string, string>();
	const reused: string[] = [];
	const usedThisBatch = new Set<string>();
	const perModelCount = new Map<string, number>();

	for (const task of tasks) {
		const qualifying = qualifyingModels(task, models, excluded);
		if (qualifying.length === 0) continue;

		// Round-robin among models that haven't hit MAX_PER_MODEL yet, to
		// prevent same-model saturation under parallel dispatch.
		const underCap = qualifying.filter((m) => (perModelCount.get(m.fullId) ?? 0) < MAX_PER_MODEL);
		const fresh = (underCap.length > 0 ? underCap : qualifying).find((m) => !usedThisBatch.has(m.fullId));
		// Round-robin overflow: cycle through qualifying models by using a rotating index
		let overflowIndex = 0;
		const getNextOverflow = () => {
			const model = qualifying[overflowIndex % qualifying.length]!;
			overflowIndex++;
			return model;
		};
		const chosen = fresh ?? (underCap.length > 0 ? underCap[0]! : getNextOverflow());
		assignments.set(task.id, chosen.fullId);
		usedThisBatch.add(chosen.fullId);
		perModelCount.set(chosen.fullId, (perModelCount.get(chosen.fullId) ?? 0) + 1);
		if (!fresh) reused.push(chosen.fullId);
	}

	// Use the minimum qualifying count across all tasks for poolUndersized (capability-aware)
	const minQualifyingCount = Math.min(...tasks.map(t => qualifyingModels(t, models, excluded).length));
	const poolUndersized = tasks.length > minQualifyingCount * MAX_PER_MODEL;

	// Which models ended up assigned more than MAX_PER_MODEL? These are the cap
	// violations the callers surface as a warning so the operator can add models
	// to the pool, relax the cap, or reduce parallel batch size.
	const overflows: Array<{ fullId: string; count: number }> = [];
	for (const [fullId, count] of perModelCount) {
		if (count > MAX_PER_MODEL) overflows.push({ fullId, count });
	}
	overflows.sort((a, b) => b.count - a.count);

	return { assignments, reused, poolUndersized, overflows };
}

/**
 * Human-readable summary for a pool-undersized result, naming the models that
 * exceeded MAX_PER_MODEL (if any) and the operator remedies. Kept in one place
 * so the async and foreground warn sites stay consistent.
 */
export function poolUndersizeMessage(
	taskCount: number,
	poolSize: number,
	assignment: Pick<WorkCandidateAssignment, "reused" | "overflows">,
): string {
	const over = (assignment.overflows ?? []).filter((o) => o.count > 2);
	const detail =
		over.length > 0
			? `; models over cap: ${over.map((o) => `"${o.fullId}" x${o.count}`).join(", ")}`
			: `; overflow=${assignment.reused.length > 0}`;
	return (
		`[preflight] model pool undersized: ${taskCount} tasks, ${poolSize} qualifying models, ` +
		`maxPerModel=2${detail}. Remedy: add models to the pool, raise the per-model cap, ` +
		`or reduce the parallel batch size to avoid same-model saturation (N x 429).`
	);
}
