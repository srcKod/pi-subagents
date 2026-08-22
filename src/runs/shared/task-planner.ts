import type { TaskProfile, PlanResult } from "../../shared/types.ts";

/**
 * Task planner (Phase 4).
 *
 * Turns a set of validated task profiles into an ordered list of parallel
 * batches via topological sort on dependsOn. Tasks with no unsatisfied
 * dependencies go in the earliest batch; once a batch completes, tasks that
 * only waited on it move to the next batch. This is the framework's structural
 * intelligence — it decides ORDERING and PARALLELISM, not model selection
 * (that is work-candidate selection, Phase 3).
 *
 * The planner is pure: no I/O, no model calls. It also exposes dependentsOf,
 * used at runtime to mark a failed task's dependents as blocked rather than
 * letting them run against a missing input.
 */

/** Only count dependencies that actually resolve to a known task id. */
function resolveDeps(p: TaskProfile, known: Set<string>): Set<string> {
	const out = new Set<string>();
	for (const dep of p.dependsOn) {
		if (known.has(dep)) out.add(dep);
	}
	return out;
}

function findCycle(deps: Map<string, Set<string>>, scheduled: Set<string>): string[] | undefined {
	const color = new Map<string, 0 | 1 | 2>(); // 0 white, 1 gray, 2 black
	const stack: string[] = [];

	function dfs(node: string): string[] | undefined {
		color.set(node, 1);
		stack.push(node);
		for (const dep of deps.get(node) ?? []) {
			if (scheduled.has(dep)) continue;
			const c = color.get(dep) ?? 0;
			if (c === 1) {
				const idx = stack.indexOf(dep);
				// Close the loop: include the back-edge target so the path reads e.g. ["a","b","a"].
			return [...stack.slice(idx), dep];
			}
			if (c === 0) {
				const found = dfs(dep);
				if (found) return found;
			}
		}
		stack.pop();
		color.set(node, 2);
		return undefined;
	}

	for (const id of deps.keys()) {
		if ((color.get(id) ?? 0) === 0) {
			const found = dfs(id);
			if (found) return found;
		}
	}
	return undefined;
}

/**
 * Topologically sort tasks into parallel batches.
 *
 * @param profiles the validated task profiles to plan.
 * @returns batches (ordered) and ok/cycle. When ok is false, batches holds
 *          whatever was scheduled before the cycle was hit; the caller should
 *          reject the plan and surface `cycle`.
 */
export function planBatches(profiles: TaskProfile[]): PlanResult {
	const known = new Set(profiles.map((p) => p.id));
	const deps = new Map<string, Set<string>>();
	for (const p of profiles) deps.set(p.id, resolveDeps(p, known));

	const remaining = new Map<string, number>();
	for (const [id, d] of deps) remaining.set(id, d.size);

	const dependents = new Map<string, string[]>();
	for (const [id, d] of deps) {
		for (const dep of d) {
			if (!dependents.has(dep)) dependents.set(dep, []);
			dependents.get(dep)!.push(id);
		}
	}

	const byId = new Map(profiles.map((p) => [p.id, p]));
	const batches: TaskProfile[][] = [];
	const scheduled = new Set<string>();

	while (scheduled.size < profiles.length) {
		const batch = profiles.filter((p) => !scheduled.has(p.id) && (remaining.get(p.id) ?? 0) === 0);
		if (batch.length === 0) {
			const cycle = findCycle(deps, scheduled);
			return { batches, ok: false, cycle };
		}
		for (const p of batch) scheduled.add(p.id);
		for (const p of batch) {
			for (const depId of dependents.get(p.id) ?? []) {
				remaining.set(depId, (remaining.get(depId) ?? 0) - 1);
			}
		}
		batches.push(batch);
	}

	return { batches, ok: true };
}

/**
 * Return every task id that (transitively) depends on `failedId`.
 *
 * Used at runtime: when a task fails, the framework marks these dependents as
 * blocked rather than letting them run against a now-missing input. The planner
 * never auto-skips dependents — it surfaces them so the orchestrator decides.
 */
export function dependentsOf(failedId: string, profiles: TaskProfile[]): string[] {
	const result: string[] = [];
	const visited = new Set<string>();
	const queue: string[] = [failedId];
	while (queue.length) {
		const cur = queue.shift()!;
		for (const p of profiles) {
			if (p.dependsOn.includes(cur) && !visited.has(p.id)) {
				visited.add(p.id);
				result.push(p.id);
				queue.push(p.id);
			}
		}
	}
	return result;
}

/**
 * Runtime dependency-failure surface.
 *
 * When a dispatched task fails, the framework does NOT auto-skip its dependents
 * (that is the orchestrator's decision). Instead it exposes this helper: given
 * the failed task id and the full profile graph, return every (transitive)
 * dependent task id so the orchestrator can mark them blocked. This is the
 * framework↔orchestrator seam for "dependency failure handling" — the planner
 * provides the graph intelligence, the orchestrator decides what to do. It is a
 * thin named wrapper over {@link dependentsOf} so the dispatch integration and
 * skill can refer to a single clear entry point.
 */
export function blockedDependentsOnFailure(failedId: string, profiles: TaskProfile[]): string[] {
	return dependentsOf(failedId, profiles);
}
