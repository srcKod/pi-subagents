import {
	CONTEXT_CEILING,
	CONTEXT_FLOOR_BY_KIND,
} from "./task-context-floor.ts";
import { KIND_DEFAULTS } from "./task-profile.ts";
import { TASK_KINDS } from "../../shared/types.ts";
import type {
	TaskKind,
	TaskProfile,
} from "../../shared/types.ts";

/**
 * Rule-based validators for a TaskProfile.
 *
 * These are the framework's guardrails — cheap, deterministic, no model calls.
 * They catch the failure modes that kill weak-model subagents: implicit context
 * (forward references), undeclared dependencies, oversized tasks, and vague
 * acceptance criteria. The orchestrator (skill) is expected to shape work so
 * these rarely fire; when they do, the message tells the orchestrator exactly
 * how to fix the task.
 *
 * Severity:
 *   - "reject": the task cannot be dispatched as-is; re-decompose / fix it.
 *   - "warn":   the task will dispatch, but the framework corrected or flagged it.
 */

export type IssueSeverity = "reject" | "warn";

export interface ValidationIssue {
	validator: number;
	severity: IssueSeverity;
	message: string;
}

export interface ValidationResult {
	/** false when any validator rejected the profile. */
	ok: boolean;
	/** true when at least one reject-severity issue was raised. */
	rejected: boolean;
	issues: ValidationIssue[];
	/** The (possibly auto-corrected / kind-overridden) profile to dispatch. */
	profile: TaskProfile;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Validator 3 — not-standalone. A task that references shared/implicit context
 * ("the above", "its output", "the previous task") cannot be run by a fresh
 * subagent with zero sibling context. This is the post-mortem's primary failure
 * mode: parallel subagents died because their tasks assumed context they could
 * not reconstruct.
 */
const FORWARD_REFERENCE_PATTERNS: RegExp[] = [
	/\bthe above\b/i,
	/\bas mentioned\b/i,
	/\bas discussed\b/i,
	/\bsee (?:above|earlier|previous)\b/i,
	/\bits? (?:output|result)\b/i,
	/\bthe (?:previous|preceding) (?:task|step|result)\b/i,
	/\b(?:earlier|previous) (?:task|step|work|result)\b/i,
	/\b(?:the|that) prior (?:change|commit|version)\b/i,
];

export function checkStandalone(p: TaskProfile): ValidationIssue | null {
	for (const re of FORWARD_REFERENCE_PATTERNS) {
		if (re.test(p.task)) {
			return {
				validator: 3,
				severity: "reject",
				message: `task is not self-contained: contains forward reference matching /${re.source}/ — inline the referenced content or declare a dependency`,
			};
		}
	}
	return null;
}

/**
 * Validator 4 — undeclared dependency. If the task text references another known
 * task by id but does not declare it in dependsOn, the dependency is implicit and
 * the framework cannot order it. Reject so the orchestrator makes it explicit.
 */
export function checkUndeclaredDep(p: TaskProfile, knownTaskIds: Set<string>): ValidationIssue | null {
	for (const id of knownTaskIds) {
		if (id === p.id) continue;
		const re = new RegExp(`\\b${escapeRegex(id)}\\b`, "i");
		if (re.test(p.task) && !p.dependsOn.includes(id)) {
			return {
				validator: 4,
				severity: "reject",
				message: `task references '${id}' but does not declare it in dependsOn — add '${id}' to dependsOn`,
			};
		}
	}
	return null;
}

/**
 * Validator 5 — over ceiling. A task whose estimated input exceeds the ceiling is
 * too big for a weak model to digest. Reject -> re-decompose. This is a
 * decomposition-quality signal, never a reason to pick a bigger model.
 */
export function checkCeiling(p: TaskProfile): ValidationIssue | null {
	if (p.estimatedInputTokens !== undefined && p.estimatedInputTokens > CONTEXT_CEILING) {
		return {
			validator: 5,
			severity: "reject",
			message: `estimatedInputTokens ${p.estimatedInputTokens} exceeds ceiling ${CONTEXT_CEILING}; split the task into smaller pieces`,
		};
	}
	return null;
}

/**
 * Validator 1 — empty task / criteria. Nothing to dispatch and no done-condition.
 * Reject before any further checks (a task with no text can't be analyzed).
 */
export function checkEmpty(p: TaskProfile): ValidationIssue | null {
	if (!p.task || !p.task.trim()) return { validator: 1, severity: "reject", message: "task text is empty" };
	if (!p.acceptanceCriteria || p.acceptanceCriteria.length === 0) {
		return { validator: 1, severity: "reject", message: "acceptanceCriteria is empty — add at least one checkable criterion" };
	}
	if (p.acceptanceCriteria.some((c) => !c || !c.trim())) {
		return { validator: 1, severity: "reject", message: "acceptanceCriteria contains an empty criterion" };
	}
	return null;
}

/**
 * Validator 2 — estimate-below-floor auto-correct. The framework bumps a missing
 * or too-low estimatedInputTokens up to the kind floor. A missing estimate (the
 * orchestrator didn't guess) is filled silently; a provided-but-too-low estimate
 * is corrected and reported as a warn so the orchestrator learns to estimate better.
 */
export function applyFloor(p: TaskProfile): { profile: TaskProfile; corrected: boolean; hadEstimate: boolean } {
	const floor = CONTEXT_FLOOR_BY_KIND[p.kind] ?? 0;
	if (p.estimatedInputTokens === undefined) {
		return { profile: { ...p, estimatedInputTokens: floor }, corrected: false, hadEstimate: false };
	}
	if (p.estimatedInputTokens < floor) {
		return { profile: { ...p, estimatedInputTokens: floor }, corrected: true, hadEstimate: true };
	}
	return { profile: p, corrected: false, hadEstimate: true };
}

/**
 * Validator 6 — vague criteria (warn only). "works correctly", "is good", etc.
 * can't be checked. Flag so the orchestrator rewrites them as concrete assertions.
 */
const VAGUE_CRITERIA_PATTERNS: RegExp[] = [
	/\bworks? (?:correctly|well|fine)\b/i,
	/\bis (?:good|complete|done|correct|right)\b/i,
	/\blooks? (?:good|right|correct)\b/i,
	/\b(?:behaves?|functions?) (?:correctly|as expected)\b/i,
];

export function checkVagueCriteria(p: TaskProfile): ValidationIssue | null {
	for (const c of p.acceptanceCriteria) {
		for (const re of VAGUE_CRITERIA_PATTERNS) {
			if (re.test(c)) {
				return {
					validator: 6,
					severity: "warn",
					message: `acceptance criterion is vague: "${c.trim()}" — rewrite as a checkable condition`,
				};
			}
		}
	}
	return null;
}

/**
 * Validator 7 — kind contradiction (override + warn). If the declared kind has no
 * signal verb in the task text but another kind has a clear signal, override the
 * kind to the detected one. Never hard-reject — the framework prefers the
 * text's signal over the declared label.
 */
const KIND_SIGNALS: Record<TaskKind, RegExp> = {
	"code-write": /\b(implement|write|create|add|fix|refactor|build|develop|introduce|author)\b/i,
	"code-read": /\b(read|inspect|map|trace|understand|review|examine|audit)\b/i,
	"transform": /\b(rename|replace|migrate|convert|move|translate|substitute)\b/i,
	"summarize": /\b(summar\w*|explain|document|describe|outline|recap)\b/i,
	"search": /\b(search|find|locate|discover|grep|identify (?:the|all))\b/i,
};

export function checkKindConsistency(p: TaskProfile): { issue: ValidationIssue | null; corrected: TaskProfile } {
	const declared = p.kind;
	const scores = Object.fromEntries(TASK_KINDS.map((k) => [k, 0])) as Record<TaskKind, number>;
	for (const kind of TASK_KINDS) {
		const m = p.task.match(KIND_SIGNALS[kind]);
		if (m) scores[kind] += m.length;
	}
	const declaredScore = scores[declared];
	let bestOther: TaskKind | null = null;
	let bestOtherScore = 0;
	for (const kind of TASK_KINDS) {
		if (kind === declared) continue;
		if (scores[kind] > bestOtherScore) {
			bestOther = kind;
			bestOtherScore = scores[kind];
		}
	}
	// Contradiction only when the declared kind has no signal at all and another
	// kind clearly does. Conservative: avoids overriding when the task text simply
	// mentions a verb of another kind while confirming its own.
	if (declaredScore === 0 && bestOther && bestOtherScore >= 1) {
		return {
			issue: {
				validator: 7,
				severity: "warn",
				message: `declared kind '${declared}' has no signal in task text but '${bestOther}' does; overriding kind to '${bestOther}'`,
			},
			corrected: { ...p, kind: bestOther },
		};
	}
	return { issue: null, corrected: p };
}

/**
 * Validate a single task profile.
 *
 * @param profile       the task to validate
 * @param knownTaskIds  the set of all task ids in the graph (for the undeclared-
 *                      dependency check). Omit for validating a single task in
 *                      isolation — validator 4 is then skipped.
 *
 * Order: empty (short-circuit) -> floor auto-correct -> standalone / undeclared-dep
 * / ceiling (rejects) -> vague-criteria / kind-consistency (warns). All issues are
 * collected so the orchestrator sees the full picture and can fix everything at once.
 */
export function validateTaskProfile(profile: TaskProfile, knownTaskIds: Set<string> = new Set()): ValidationResult {
	const issues: ValidationIssue[] = [];

	const empty = checkEmpty(profile);
	if (empty) return { ok: false, rejected: true, issues: [empty], profile };

	const floor = applyFloor(profile);
	let working = floor.profile;
	if (floor.corrected) {
		issues.push({
			validator: 2,
			severity: "warn",
			message: `estimatedInputTokens bumped to ${working.estimatedInputTokens} (kind '${working.kind}' floor)`,
		});
	}

	const standalone = checkStandalone(working);
	if (standalone) issues.push(standalone);

	const undeclared = checkUndeclaredDep(working, knownTaskIds);
	if (undeclared) issues.push(undeclared);

	const ceiling = checkCeiling(working);
	if (ceiling) issues.push(ceiling);

	const vague = checkVagueCriteria(working);
	if (vague) issues.push(vague);

	const kind = checkKindConsistency(working);
	working = kind.corrected;
	if (kind.issue) issues.push(kind.issue);

	const rejected = issues.some((i) => i.severity === "reject");
	return { ok: !rejected, rejected, issues, profile: working };
}

/** Convenience: validate every task in a graph. Returns results keyed by task id. */
export function validateTaskGraph(profiles: TaskProfile[]): Map<string, ValidationResult> {
	const known = new Set(profiles.map((p) => p.id));
	const out = new Map<string, ValidationResult>();
	for (const p of profiles) out.set(p.id, validateTaskProfile(p, known));
	return out;
}

// Re-export so callers can reference kind defaults without a second import.
export { KIND_DEFAULTS };
