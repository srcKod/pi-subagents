import type { ChainStep, ParallelStep, SequentialStep } from "../../shared/settings.ts";
import type { TaskProfile, PlanResult, SelectableModel } from "../../shared/types.ts";
import { planBatches } from "./task-planner.ts";

/**
 * Converts a list of TaskProfiles into a plain main-compatible ChainStep[].
 *
 * The bridge performs three steps:
 * 1. Runs topological planning (planBatches) to compute parallel batches.
 * 2. Maps each batch to a single chain step:
 *    - Single task -> SequentialStep
 *    - Multiple tasks -> ParallelStep
 * 3. Preserves only fields that exist in main's ChainStep contract:
 *    agent, task, model, and the parallel group structure.
 *
 * @param profiles      — task profiles to convert
 * @param agentForTask  — optional mapping from taskId -> agent name. Defaults to "worker" when not provided.
 * @returns ordered chain steps that can be passed directly to main's chain executor
 */
export function taskProfilesToChain(
	profiles: TaskProfile[],
	agentForTask?: ((taskId: string) => string) | Record<string, string>,
): ChainStep[] {
	const agentMap = normalizeAgentMapping(agentForTask);
	const plan = planBatches(profiles);
	if (!plan.ok) {
		throw new Error(`Cyclic task graph: ${plan.cycle?.join(" -> ") ?? "unknown"}`);
	}

	const steps: ChainStep[] = [];

	for (const batch of plan.batches) {
		if (batch.length === 1) {
			const task = batch[0]!;
			const step: SequentialStep = {
				agent: agentMap(task.id),
				task: task.task,
			};
			if (task.model) {
				step.model = task.model;
			}
			steps.push(step);
		} else {
			steps.push({
				parallel: batch.map((t) => ({
					agent: agentMap(t.id),
					task: t.task,
					...(t.model ? { model: t.model } : {}),
				})),
			} satisfies ParallelStep);
		}
	}

	return steps;
}

/** Build a taskId -> agent map from either a function or a plain object. */
function normalizeAgentMapping(
	mapping?: ((taskId: string) => string) | Record<string, string>,
): (taskId: string) => string {
	if (typeof mapping === "function") return mapping;
	if (mapping && typeof mapping === "object") return (id: string) => mapping[id] ?? "worker";
	return () => "worker";
}
