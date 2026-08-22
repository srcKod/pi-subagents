import { Type } from "typebox";
import { CONTEXT_FLOOR_BY_KIND } from "./task-context-floor.ts";
import { TASK_KINDS } from "../../shared/types.ts";
import type { KindDefaults, TaskKind, TaskProfile, TaskStakes, TaskToolBudget } from "../../shared/types.ts";



export const KIND_DEFAULTS: Record<TaskKind, KindDefaults> = {
	"code-write": {
		contextFloor: CONTEXT_FLOOR_BY_KIND["code-write"],
		tokenBudget: 64_000,
		toolBudget: { hard: 80, soft: 40, block: "*" },
		capabilities: ["write"],
	},
	"code-read": {
		contextFloor: CONTEXT_FLOOR_BY_KIND["code-read"],
		tokenBudget: 32_000,
		toolBudget: { hard: 60, soft: 30, block: ["read", "grep", "find", "ls"] },
		capabilities: ["read"],
	},
	"transform": {
		contextFloor: CONTEXT_FLOOR_BY_KIND["transform"],
		tokenBudget: 16_000,
		toolBudget: { hard: 40, soft: 20, block: "*" },
		capabilities: ["transform"],
	},
	"summarize": {
		contextFloor: CONTEXT_FLOOR_BY_KIND["summarize"],
		tokenBudget: 8_000,
		toolBudget: { hard: 20, soft: 10, block: ["read", "grep", "find", "ls", "ctx_execute"] },
		capabilities: ["summarize"],
	},
	"search": {
		contextFloor: CONTEXT_FLOOR_BY_KIND["search"],
		tokenBudget: 16_000,
		toolBudget: { hard: 40, soft: 20, block: ["read", "grep", "find", "ls"] },
		capabilities: ["search"],
	},
};



/** TypeBox schema for a single task. Mirrors the TaskProfile interface. */
export const TaskProfileSchema = Type.Object({
	id: Type.String({ minLength: 1, description: "Stable task handle, e.g. 'auth-1'." }),
	kind: Type.String({ enum: [...TASK_KINDS], description: "Resource shape: code-write | code-read | transform | summarize | search." }),
	task: Type.String({ minLength: 1, description: "Full, self-contained instruction for the subagent (no forward references)." }),
	dependsOn: Type.Array(Type.String({ minLength: 1 }), { description: "Task ids that must complete before this task starts." }),
	acceptanceCriteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Checkable success conditions — not 'works correctly'." }),
	needsReasoning: Type.Optional(Type.Boolean({ description: "true only if the task requires hard reasoning (default false)." })),
	stakes: Type.Optional(Type.String({ enum: ["normal", "high"], description: "'high' triggers an opt-in verifier subagent." })),
	model: Type.Optional(Type.String({ description: "Explicit model for this step (e.g. 'anthropic/claude-sonnet-4'). Overrides work candidate selection when set." })),
	toolBudget: Type.Optional(Type.Object({
		hard: Type.Integer({ minimum: 1 }),
		soft: Type.Optional(Type.Integer({ minimum: 1 })),
		block: Type.Union([Type.Literal("*"), Type.Array(Type.String())]),
	}, { additionalProperties: false, description: "Tool budget override (hard/soft/block). Framework fills if omitted." })),
	tokenBudget: Type.Optional(Type.Integer({ minimum: 1, description: "Token budget override. Framework fills if omitted." })),
	contextFloor: Type.Optional(Type.Integer({ minimum: 1, description: "Context floor override. Framework fills if omitted." })),
	capabilities: Type.Optional(Type.Array(Type.String(), { description: "Required capabilities override. Framework fills if omitted." })),
	estimatedInputTokens: Type.Optional(Type.Integer({ minimum: 0, description: "Orchestrator's input-size guess; framework bumps to the kind floor." })),
}, { additionalProperties: false, description: "A single task in the managed task graph." });

/** TypeBox schema for a list of tasks (a batch or a whole graph). */
export const TaskProfileListSchema = Type.Array(TaskProfileSchema, { description: "An ordered or unordered list of task profiles." });

/** True when `value` is a valid TaskKind. */
export function isTaskKind(value: unknown): value is TaskKind {
	return typeof value === "string" && (TASK_KINDS as readonly string[]).includes(value);
}

/**
 * Uniform-CRUD routing heuristic.
 *
 * When all leaf tasks in a batch share the same `kind` and have similar
 * `estimatedInputTokens` (within 50% of each other), the work is likely
 * a uniform CRUD pattern. In such cases, parent-direct execution is faster
 * than parallel dispatch.
 */
export function isUniformCRUD(tasks: TaskProfile[]): boolean {
	if (tasks.length < 2) return false;
	const kinds = new Set(tasks.map((t) => t.kind));
	if (kinds.size !== 1) return false;
	const tokens = tasks.map((t) => t.estimatedInputTokens ?? 0).filter((t) => t > 0);
	if (tokens.length < tasks.length * 0.5) return false;
	const max = Math.max(...tokens);
	const min = Math.min(...tokens);
	return max > 0 && min / max >= 0.5;
}
