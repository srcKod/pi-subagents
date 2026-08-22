/**
 * Async execution logic for subagent tool
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../agents/agents.ts";
import { appendAgentRefinementOverlay } from "../../agents/agent-refinements.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { currentCompletionOwnerId } from "../../shared/completion-owner.ts";
import { applyThinkingSuffix, projectLaunchResolvedChildExtensions, resolvePiLaunchToolPlan } from "../shared/pi-args.ts";
import { injectOutputPathSystemPrompt, injectSingleOutputInstruction, normalizeSingleOutputOverride, resolveSingleOutputPath, validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { buildChainInstructions, isDynamicParallelStep, isParallelStep, resolveChainPath, resolveExistingReadPaths, resolveStepBehavior, suppressProgressForReadOnlyTask, writeInitialProgressFile, type ChainStep, type ResolvedStepBehavior, type SequentialStep, type StepOverrides } from "../../shared/settings.ts";
import { type RunnerStep, type RunnerSubagentStep, isParallelGroup, isDynamicRunnerGroup } from "../shared/parallel-utils.ts";
import type { ContextMode } from "../shared/context-mode.ts";
import { resolvePiPackageRoot } from "../shared/pi-spawn.ts";
import { resolveNodeExecutable } from "../../shared/node-executable.ts";
import { buildSkillInjection, normalizeSkillInput, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { buildAgentMemoryInjection } from "../../agents/agent-memory.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV, PROMPT_REDACTED, resolveChildCwd } from "../../shared/utils.ts";
import { buildModelCandidates, inheritsParentModel, resolveEffectiveSubagentModel, resolveModelCandidate, resolveSubagentModelOverride, type AvailableModelInfo, type ParentModel } from "../shared/model-fallback.ts";
import { filterFallbackCandidates, isExcluded, parseModelKey } from "../shared/model-exclusions.ts";
import { selectWorkCandidate, assignBatchWorkCandidates, poolUndersizeMessage } from "../shared/work-candidate-selection.ts";
import { toSelectableModel, modelQualifies } from "../shared/model-capabilities.ts";
import { LEGACY_FALLBACK_MIN_CONTEXT } from "../shared/task-context-floor.ts";
import { validateTaskProfile } from "../shared/task-validators.ts";
import { planBatches } from "../shared/task-planner.ts";
import { KIND_DEFAULTS, isUniformCRUD } from "../shared/task-profile.ts";
import { resolveToolTimeoutMs, toolTimeoutFromEnv } from "../shared/tool-timeout.ts";
import { resolveModelScopesForAgent, type ModelScopeConfig } from "../shared/model-scope.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { resolveExpectedWorktreeAgentCwd } from "../shared/worktree.ts";
import { buildWorkflowGraphSnapshot } from "../shared/workflow-graph.ts";
import { ChainOutputValidationError, validateChainOutputBindings } from "../shared/chain-outputs.ts";
import { createStructuredOutputRuntime } from "../shared/structured-output.ts";
import { resolveEffectiveAcceptance, validateAcceptanceInput, validateExecutionAcceptance } from "../shared/acceptance.ts";
import { createRunFanoutBudget, writeRunFanoutBudgetDescriptor } from "../shared/run-fanout-budget.ts";
import { validateImplementationToolContract } from "../shared/completion-guard.ts";
import {
	type AcceptanceInput,
	type AgentContract,
	type AsyncStatus,
	type ArtifactConfig,
	type Details,
	type IntercomBridgeConfig,
	type JsonSchemaObject,
	type MaxOutputConfig,
	type NestedRouteInfo,
	type ResolvedControlConfig,
	type ResolvedTurnBudget,
	type ResolvedToolBudget,
	type RunFanoutBudgetDescriptor,
	type SelectableModel,
	type SelectionTaskInput,
	type TaskProfile,
	type ToolBudgetConfig,
	type SubagentRunMode,
	type SteeringRecoveryDescriptor,
	type UsageBudgetConfig,
	DIRS,
	SCOUT_MAX_FANOUT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
	TEMP_ROOT_DIR,
	getAsyncConfigPath,
	resolveChildMaxSubagentDepth,
} from "../../shared/types.ts";
import { nestedResultsPath, nestedSummaryFromAsyncStatus, resolveInheritedNestedRouteFromEnv, resolveNestedParentAddressFromEnv, writeNestedEvent } from "../shared/nested-events.ts";
import { resultFilePath } from "./result-files.ts";
import { appendTurnBudgetSystemPrompt, initialTurnBudgetState } from "../shared/turn-budget.ts";
import { validateToolBudgetConfig } from "../shared/tool-budget.ts";
import { usageBudgetState } from "../shared/usage-budget.ts";
import type { ImportedAsyncRoot } from "./chain-root-attachment.ts";
import type { SessionLeaseRequest } from "../shared/session-lease.ts";
import { finalizeProcessTerminal, readProcessTerminal } from "./process-terminal.ts";
import type { ActiveAsyncCapacityHandle } from "./active-async-capacity.ts";
import { SUBAGENT_PROCESS_TERMINAL_EVENT } from "../../shared/types.ts";
import { assertAgentAllowedByCapabilityCeiling, decodeSubagentCapabilityCeiling, intersectSubagentCapabilityCeilings, resolveCurrentSubagentCapabilityCeiling, SUBAGENT_CAPABILITY_CEILING_ENV, type ResolvedSubagentCapabilityCeiling } from "../shared/capability-ceiling.ts";
import { agentDefinitionDigest, launchBindingDigest } from "../../shared/launch-contract.ts";
import { resolvePermissionRules, type PermissionConfig } from "../shared/permissions.ts";

const require = createRequire(import.meta.url);
const piPackageRoot = resolvePiPackageRoot();

function resolveJitiCliFromPackageJson(packageJsonPath: string): string | undefined {
	if (!fs.existsSync(packageJsonPath)) return undefined;
	const packageRoot = path.dirname(packageJsonPath);
	const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
		bin?: string | Record<string, string>;
	};
	const binField = pkg.bin;
	const binPath = typeof binField === "string"
		? binField
		: binField?.jiti ?? Object.values(binField ?? {})[0];
	const candidates = [binPath, "lib/jiti-cli.mjs"].filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of candidates) {
		const cliPath = path.resolve(packageRoot, candidate);
		if (fs.existsSync(cliPath)) return cliPath;
	}
	return undefined;
}

function resolveJitiCliPath(): string | undefined {
	const candidates: Array<() => string | undefined> = [
		() => require.resolve("jiti/package.json"),
		() => piPackageRoot
			? createRequire(path.join(piPackageRoot, "package.json")).resolve("jiti/package.json")
			: undefined,
		() => {
			if (!process.argv[1]) return undefined;
			const piEntry = fs.realpathSync(process.argv[1]);
			return createRequire(piEntry).resolve("jiti/package.json");
		},
		() => piPackageRoot ? path.join(piPackageRoot, "node_modules", "jiti", "package.json") : undefined,
	];
	for (const candidate of candidates) {
		try {
			const packageJsonPath = candidate();
			if (!packageJsonPath) continue;
			const cliPath = resolveJitiCliFromPackageJson(packageJsonPath);
			if (cliPath) return cliPath;
		} catch {
			// Candidate not available in this install, continue probing.
		}
	}
	return undefined;
}

const jitiCliPath = resolveJitiCliPath();

interface AsyncExecutionContext {
	pi: ExtensionAPI;
	cwd: string;
	currentSessionId: string;
	completionOwnerId?: string;
	/** Parent session id used by permission-system ask forwarding. */
	parentSessionId?: string;
	permissions?: PermissionConfig;
	currentModelProvider?: string;
	currentModel?: ParentModel;
	/** Optional model-scope enforcement resolved from subagent settings. */
	modelScope?: ModelScopeConfig;
	/** Whether the parent session has an interactive UI. */
	interactive?: boolean;
}

export const DEFAULT_ASYNC_TIMEOUT_MS = 30 * 60 * 1000;

interface AsyncChainParams {
	chain: ChainStep[];
	task?: string;
	/** Raw caller-facing goal used only by the started event. */
	goal?: string;
	attachRoot?: ImportedAsyncRoot & { agent: string; outputName?: string; label?: string };
	resultMode?: SubagentRunMode;
	agents: AgentConfig[];
	ctx: AsyncExecutionContext;
	availableModels?: AvailableModelInfo[];
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	agentContract?: AgentContract;
	chainSkills?: string[];
	sessionFilesByFlatIndex?: (string | undefined)[];
	thinkingOverridesByFlatIndex?: (AgentConfig["thinking"] | undefined)[];
	contextForAgent?: (agentName: string) => ContextMode;
	progressDir?: string;
	dynamicFanoutMaxItems?: number;
	maxSubagentDepth: number;
	waitToolEnabled?: boolean;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	worktreeBaseDir?: string;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	nestedRoute?: NestedRouteInfo;
	acceptance?: AcceptanceInput;
	timeoutMs?: number;
	turnBudget?: ResolvedTurnBudget;
	toolBudget?: ResolvedToolBudget;
	usageBudget?: UsageBudgetConfig;
	configToolBudget?: ResolvedToolBudget;
	/** Optional per-call hard toolTimeoutMs override (highest precedence). */
	callToolTimeoutMs?: number;
	/** Global config.toolTimeoutMs (third precedence, after agent frontmatter). */
	configToolTimeoutMs?: number;
	/** PI_SUBAGENT_TOOL_TIMEOUT_MS override (lowest precedence). */
	toolTimeoutMsEnv?: string | undefined;
	/** Global cap on simultaneously-running subagent tasks within the async run. */
	globalConcurrencyLimit?: number;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	runFanoutBudget?: RunFanoutBudgetDescriptor;
	parentWorkflowRunId?: string;
	workflowKey?: string;
	activeAsyncCapacity?: ActiveAsyncCapacityHandle;
	profiles?: TaskProfile[];
}

interface AsyncSingleParams {
	agent: string;
	task?: string;
	/** Raw caller-facing goal used only by the started event. */
	goal?: string;
	agentConfig: AgentConfig;
	/** Agent contract before per-run bridge injection, used only for recovery persistence. */
	recoveryAgentConfig?: AgentConfig;
	ctx: AsyncExecutionContext;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	sessionDir?: string;
	sessionFile?: string;
	revivalLease?: SessionLeaseRequest;
	context?: ContextMode;
	skills?: string[];
	output?: string | boolean;
	reads?: string[] | false;
	outputMode?: "inline" | "file-only";
	outputBaseDir?: string;
	agentContract?: AgentContract;
	structuredOutputSchema?: JsonSchemaObject;
	modelOverride?: string;
	modelOverrideFromParent?: boolean;
	thinkingOverride?: AgentConfig["thinking"];
	availableModels?: AvailableModelInfo[];
	maxSubagentDepth: number;
	waitToolEnabled?: boolean;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	worktreeBaseDir?: string;
	worktree?: boolean;
	controlConfig?: ResolvedControlConfig;
	intercomBridge?: IntercomBridgeConfig;
	controlIntercomTarget?: string;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	nestedRoute?: NestedRouteInfo;
	acceptance?: AcceptanceInput;
	timeoutMs?: number;
	absoluteDeadlineAt?: number;
	/** Optional per-call hard toolTimeoutMs override (highest precedence). */
	toolTimeoutMs?: number;
	turnBudget?: { maxTurns: number; graceTurns?: number };
	toolBudget?: ResolvedToolBudget | ToolBudgetConfig;
	usageBudget?: UsageBudgetConfig;
	configToolBudget?: ResolvedToolBudget;
	/** Global config.toolTimeoutMs (third precedence, after agent frontmatter). */
	configToolTimeoutMs?: number;
	/** PI_SUBAGENT_TOOL_TIMEOUT_MS override (lowest precedence). */
	toolTimeoutMsEnv?: string | undefined;
	allowZeroToolBudget?: boolean;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	runFanoutBudget?: RunFanoutBudgetDescriptor;
	parentWorkflowRunId?: string;
	workflowKey?: string;
	workflowAwaitAsync?: boolean;
	activeAsyncCapacity?: ActiveAsyncCapacityHandle;
	externalJobFollowUp?: {
		sourceRunId: string;
		sourceStepIndex: number;
		parentProviderJobId: string;
		requestId: string;
		requestDigest: string;
	};
	profiles?: TaskProfile[];
}

interface AsyncExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: Details;
	isError?: boolean;
}

export interface AsyncRunnerStepBuildParams {
	chain: ChainStep[];
	task?: string;
	attachRoot?: ImportedAsyncRoot & { agent: string; outputName?: string; label?: string };
	resultMode?: SubagentRunMode;
	agents: AgentConfig[];
	ctx: AsyncExecutionContext;
	availableModels?: AvailableModelInfo[];
	cwd?: string;
	chainSkills?: string[];
	sessionFilesByFlatIndex?: (string | undefined)[];
	thinkingOverridesByFlatIndex?: (AgentConfig["thinking"] | undefined)[];
	contextForAgent?: (agentName: string) => ContextMode;
	progressDir?: string;
	agentContract?: AgentContract;
	dynamicFanoutMaxItems?: number;
	maxSubagentDepth: number;
	waitToolEnabled?: boolean;
	worktreeBaseDir?: string;
	asyncDir: string;
	outputBaseDir?: string;
	validateOutputBindings?: boolean;
	toolBudget?: ResolvedToolBudget;
	configToolBudget?: ResolvedToolBudget;
	/** Optional per-call hard toolTimeoutMs override from the subagent invocation. */
	callToolTimeoutMs?: number;
	/** Global config.toolTimeoutMs (third precedence, after agent frontmatter). */
	configToolTimeoutMs?: number;
	/** PI_SUBAGENT_TOOL_TIMEOUT_MS override (lowest precedence). */
	toolTimeoutMsEnv?: string | undefined;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	profiles?: TaskProfile[];
}

export type AsyncRunnerStepBuildResult =
	| {
		steps: RunnerStep[];
		runnerCwd: string;
		workflowGraph: ReturnType<typeof buildWorkflowGraphSnapshot>;
		eventChain: ChainStep[];
		originalTask?: string;
	}
	| { error: string };

/**
 * Map a task profile into the coarse selection input.
 *
 * Required capabilities = the union of the profile's declared `capabilities`
 * (or the kind default when omitted) and `"reasoning"` when `needsReasoning` is
 * set. They are then intersected with `advertised` — the capabilities any
 * available model actually advertises (currently `reasoning` and, when the
 * model's `input` modalities include `"image"`, `vision`). Capabilities no
 * model advertises (e.g. `"write"`/`"read"`) are treated as advisory: they shape
 * the task but must not exclude every model and silently disable work candidate
 * selection. Matchable capabilities are enforced.
 */
function toSelectionInput(p: TaskProfile, advertised: Set<string>): SelectionTaskInput {
	const floor = KIND_DEFAULTS[p.kind]?.contextFloor ?? 16_000;
	// The kind floor is a HARD minimum context requirement. Clamp the declared
	// estimatedInputTokens up to the floor (never below) so a small estimate can't
	// shrink requiredContext and let a sub-floor model (e.g. 4K llama-2-7b) be
	// selected for a code-write/code-read task where it would overflow.
	const requiredContext = Math.max(p.estimatedInputTokens ?? floor, floor);
	const declared = new Set<string>([
		...(p.capabilities ?? KIND_DEFAULTS[p.kind]?.capabilities ?? []),
		...(p.needsReasoning ? ["reasoning"] : []),
	]);
	const capabilities = [...declared].filter((c) => advertised.has(c));
	return { id: p.id, requiredContext, capabilities };
}

/**
 * Apply task-profile-driven model selection to a built step list.
 *
 * Every leaf subagent step (in execution order) is paired with the profile at
 * the same index. For a parallel group the group's profiles get distinct models
 * via {@link assignBatchWorkCandidates}; sequential steps each pick a work candidate via
 * {@link selectWorkCandidate}. The chosen model overrides the step's
 * `model`/`modelCandidates` so dispatch honours the task-management layer
 * instead of the static fallback list. Profiles are validated first (as a set,
 * so intra-profile dependencies resolve); a rejected profile aborts the build.
 */
/**
 * Fallback list length is NOT artificially capped. The runtime retry loop in
 * `runSingleStep` rotates through *every* candidate in `modelCandidates` and
 * only stops on a MEANINGFUL condition — the work succeeded, a NON-retryable
 * error (context overflow, tool failure, non-retryable 400), or a real run/step
 * timeout. So exhaustion is defined by the task, not by an arbitrary slot count.
 *
 * The agent-configured list (inherited parent model + agent.fallbackModels,
 * already exclusion-filtered) is preserved and the work candidate is prepended,
 * so the loop falls back across the whole qualified pool on 400/429/503 etc.
 * A failing model is recorded via `recordModelFailure` (TTL exclusion store), so
 * it is skipped on subsequent attempts/runs without re-hitting it. There is no
 * need to pre-truncate the list: if the qualified pool is large, the loop simply
 * keeps selecting the next candidate and excluding failures until one succeeds or
 * the pool is genuinely exhausted.
 */

function applyProfileModels(
	steps: RunnerStep[],
	profiles: TaskProfile[],
	availableModels: AvailableModelInfo[] | undefined,
	explicitModel?: string,
	parentModel?: ParentModel,
	agents?: AgentConfig[],
): { error?: string } {
	const knownTaskIds = new Set(profiles.map((p) => p.id));
	for (const profile of profiles) {
		const result = validateTaskProfile(profile, knownTaskIds);
		if (result.rejected) {
			return { error: `Invalid task profile "${profile.id ?? "?"}:" ${result.issues.map((i) => i.message).join("; ")}` };
		}
	}

	// Live planning stage: the dependsOn graph must be acyclic and must respect
	// the runner step execution order. The topological planner (planBatches) is
	// the canonical task planner; its ordered batches give us both a cycle gate
	// and a structural ordering check. Per-profile validators catch undeclared
	// dependencies, and planBatches rejects cycles; here we also verify that the
	// dispatched step tree orders every dependency before its dependent.
	const plan = planBatches(profiles);
	if (!plan.ok) {
		const cycle = plan.cycle?.join(" → ") ?? "(unknown cycle)";
		return { error: `Invalid task profile graph: cyclic dependency detected: ${cycle}` };
	}

	const leaves: { step: RunnerSubagentStep; group: number; index: number }[] = [];
	const groups: { steps: RunnerSubagentStep[]; leafIndices: number[] }[] = [];
	let leafIndex = 0;
	for (const step of steps) {
		if (isParallelGroup(step)) {
			const gi = groups.length;
			const entry: { steps: RunnerSubagentStep[]; leafIndices: number[] } = { steps: step.parallel, leafIndices: [] };
			for (const leaf of step.parallel) {
				leaves.push({ step: leaf, group: gi, index: leafIndex });
				entry.leafIndices.push(leafIndex);
				leafIndex++;
			}
			groups.push(entry);
		} else if (isDynamicRunnerGroup(step)) {
			// Dynamic fan-out count is unknown until runtime; profiles are not applied.
			continue;
		} else {
			leaves.push({ step, group: -1, index: leafIndex });
			leafIndex++;
		}
	}

	if (leaves.length !== profiles.length) {
		return {
			error: `profiles length (${profiles.length}) must match the number of dispatched subagent steps (${leaves.length})`,
		};
	}

	// Profiles must be unique and aligned positionally with `leaves` (profiles[i]
	// <-> leaves[i], the step dispatch order). We build the id->leafIndex map from the
	// SAME index source the assignment loop below uses (`profiles[leaf.index]`) so
	// validation and assignment can never diverge. Duplicate ids would collapse the
	// map key, so reject them up front.
	const profileIdSet = new Set(profiles.map((pr) => pr.id));
	if (profileIdSet.size !== profiles.length) {
		return { error: "Invalid task profiles: profile ids must be unique." };
	}
	const leafIndexById = new Map<string, number>();
	for (const leaf of leaves) {
		const profile = profiles[leaf.index];
		if (!profile) continue;
		leafIndexById.set(profile.id, leaf.index);
	}
	for (const profile of profiles) {
		const currentIndex = leafIndexById.get(profile.id);
		if (currentIndex === undefined) continue;
		for (const dep of profile.dependsOn) {
			const depIndex = leafIndexById.get(dep);
			if (depIndex === undefined) continue;
			if (depIndex >= currentIndex) {
				return {
					error: `Invalid task profile graph: task '${profile.id}' depends on '${dep}', but the dependency is not executed before it.`,
			};
			}
		}
	}

	const selectable = (availableModels ?? []).map(toSelectableModel).filter((m): m is SelectableModel => m !== null);
	const advertised = new Set<string>();
	for (const m of selectable)
		for (const c of m.capabilities)
			advertised.add(c);
	const excluded = new Set(
		(availableModels ?? [])
			.filter((m) => {
				const key = parseModelKey(m.fullId);
				return isExcluded(key.modelId, key.provider ?? m.provider);
			})
			.map((m) => m.fullId),
	);

	// In FEATURE mode (no explicit model), exclude the parent (orchestrator) from the
	// selectable pool so it is never chosen as a primary work candidate - it is only a
	// last-resort fallback. In MAIN mode (explicit model) the pool is untouched.
	const parentFullId = parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined;
	const selectablePool = explicitModel || !parentFullId ? selectable : selectable.filter((m) => m.fullId !== parentFullId);

	const assignments: (string | undefined)[] = new Array(leafIndex).fill(undefined);
	for (const group of groups) {
		const groupProfiles = group.leafIndices.map((li) => toSelectionInput(profiles[li]!, advertised));
		const assigned = assignBatchWorkCandidates(groupProfiles, selectablePool, excluded);
		if (assigned.poolUndersized) {
			console.warn(poolUndersizeMessage(groupProfiles.length, selectablePool.length, assigned));
		}
		group.leafIndices.forEach((li) => {
			assignments[li] = assigned.assignments.get(profiles[li]!.id);
		});
	}
	for (const leaf of leaves) {
		if (leaf.group !== -1) continue;
		assignments[leaf.index] = selectWorkCandidate(toSelectionInput(profiles[leaf.index]!, advertised), selectablePool, excluded);
	}

	leaves.forEach((leaf) => {
		const profile = profiles[leaf.index]!;
		// An explicit per-profile model, OR a model pre-assigned by the foreground batch
		// assignment (leaf.step.model), OR a top-level override is authoritative.
		// Otherwise fall back to the batch-diverse work candidate pick.
		const model = leaf.step.model ?? profile.model ?? explicitModel ?? assignments[leaf.index];
		// Annotate the leaf step with its task-profile id so the runtime can map a
		// failed step back to its profile and surface blocked dependents.
		leaf.step.profileId = profile.id;
		if (model) {
			leaf.step.model = model;
			const existing = Array.isArray(leaf.step.modelCandidates) ? leaf.step.modelCandidates : [];
			// The fallback pool is qualified (task capabilities + context) only when no
			// explicit fallbackModels are declared - that is the feature fallback policy.
			// When fallbackModels ARE pinned (main behavior) the declared list is preserved
			// exactly and not re-qualified.
			const agentCfg = agents?.find((a) => a.name === leaf.step.agent);
			const hasExplicitFallbacks = Array.isArray(agentCfg?.fallbackModels) && agentCfg.fallbackModels.length > 0;
			const qualifyPool = !hasExplicitFallbacks;
			let pool = existing.filter((m) => m !== model);
			if (qualifyPool) {
				const selectionInput = toSelectionInput(profile, advertised);
				const qualified = new Set(
					(availableModels ?? [])
						.map(toSelectableModel)
						.filter((m): m is SelectableModel => modelQualifies(m, selectionInput.capabilities, selectionInput.requiredContext))
						.map((m) => m.fullId),
				);
				pool = pool.filter((m) => qualified.has(m));
			}
			// The inherited parent is the orchestrator (planning/decomposition); task work
			// is delegated to pool models, so the parent is the LAST-RESORT candidate -
			// appended at the end after the qualified pool (or moved there if already present).
			if (parentFullId && !model.includes(parentFullId)) {
				const idx = pool.indexOf(parentFullId);
				if (idx !== -1) { const c = pool.slice(); c.push(c.splice(idx, 1)[0]!); pool = c; }
				else pool = [...pool, parentFullId];
			}
			// No hard cap: rotate through the entire qualified pool. The retry loop in
			// runSingleStep defines exhaustion by meaningful conditions (success, non-retryable
			// error, context overflow, or a real timeout), not by a slot count. A failed
			// candidate is recorded into the TTL exclusion store so it is skipped next time.
			leaf.step.modelCandidates = [model, ...pool];
		}
	});

	return {};
}
export function formatAsyncStartedMessage(headline: string, interactive: boolean): string {
	const guidance = interactive
		? [
			"The async run is detached and running in the background.",
			"You are in an interactive session. By default, return control to the user now; Pi will wake you on completion when the run finishes or needs attention. Do NOT call subagent_wait() merely to wait, and do not run sleep/polling loops to wait for it.",
			"When you need an explicit wake for one known run but do not need same-turn results, call subagent_wait({ id: \"...\", nonBlocking: true }) to arm a subscription and return immediately.",
			"Override the default and call blocking subagent_wait() before ending the turn only when the current request is run-to-completion — for example, the user asked you to report results back here before continuing, or a skill must finish in one turn. In that case, call subagent_wait() to block until the run completes so its results are delivered in this turn instead of deferred.",
			"Otherwise, continue any independent work or return control to the user. Use subagent({ action: \"status\", id: \"...\" }) for a one-shot status/result or to inspect a blocked/stale run, never as a wait loop.",
		]
		: [
			"The async run is detached. Do not run sleep timers or polling loops just to wait for it.",
			"This is a non-interactive run: Pi auto-drains current-session background work at agent_end so detached children are not abandoned; call subagent_wait() when this turn must receive the run's results before it ends, otherwise let the headless auto-drain finish the work.",
			"Use subagent({ action: \"status\", id: \"...\" }) when you need a one-shot status/result or to inspect a blocked/stale run. To block until completion, use subagent_wait() — do not poll in a loop.",
		];
	return [headline, "", ...guidance].join("\n");
}

/**
 * Check if jiti is available for async execution
 */
export function isAsyncAvailable(): boolean {
	return jitiCliPath !== undefined;
}

export function resolveAsyncRunnerLogPaths(cfg: object): { stdoutPath: string; stderrPath: string } | undefined {
	const asyncDir = typeof (cfg as { asyncDir?: unknown }).asyncDir === "string"
		? (cfg as { asyncDir: string }).asyncDir
		: undefined;
	if (!asyncDir) return undefined;
	return {
		stdoutPath: path.join(asyncDir, "runner.stdout.log"),
		stderrPath: path.join(asyncDir, "runner.stderr.log"),
	};
}

function closeFd(fd: number | undefined): void {
	if (fd === undefined) return;
	try {
		fs.closeSync(fd);
	} catch {
		// Best-effort cleanup; child process already owns its duplicated stdio fd.
	}
}

/**
 * Spawn the async runner process
 */
const RUNNER_STARTUP_TIMEOUT_MS = 10_000;
const RUNNER_STARTUP_WAIT_BUFFER = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(4) : undefined;
const RUNNER_STARTUP_WAIT_VIEW = RUNNER_STARTUP_WAIT_BUFFER ? new Int32Array(RUNNER_STARTUP_WAIT_BUFFER) : undefined;

type RunnerStartupState = "ready" | "acknowledged";

type RunnerStartupWaitResult =
	| { ok: true; token: string }
	| { ok: false; error: string; startupDidNotProceed?: boolean };

function waitForStartupInterval(delayMs = 20): void {
	if (RUNNER_STARTUP_WAIT_VIEW) {
		Atomics.wait(RUNNER_STARTUP_WAIT_VIEW, 0, 0, delayMs);
		return;
	}
	const waitUntil = Date.now() + delayMs;
	while (Date.now() < waitUntil) {
		// Startup handshakes are synchronous so resume rejects before reporting a run as started.
	}
}

function readRunnerStartup(startupPath: string, expectedState: RunnerStartupState, expectedToken?: string): RunnerStartupWaitResult | undefined {
	if (!fs.existsSync(startupPath)) return undefined;
	try {
		const payload = JSON.parse(fs.readFileSync(startupPath, "utf-8")) as { state?: unknown; token?: unknown; error?: unknown };
		if (payload.state === "error" && typeof payload.error === "string") return { ok: false, error: payload.error, startupDidNotProceed: true };
		if (payload.state !== expectedState) return undefined;
		if (typeof payload.token !== "string" || (expectedToken !== undefined && payload.token !== expectedToken)) {
			return { ok: false, error: `Async runner wrote an invalid ${expectedState} startup handshake: ${startupPath}`, startupDidNotProceed: true };
		}
		return { ok: true, token: payload.token };
	} catch (error) {
		return { ok: false, error: `Failed to read async runner startup handshake '${startupPath}': ${error instanceof Error ? error.message : String(error)}`, startupDidNotProceed: true };
	}
}

function waitForRunnerStartup(startupPath: string, expectedState: RunnerStartupState, timeoutMs: number, expectedToken?: string): RunnerStartupWaitResult {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const result = readRunnerStartup(startupPath, expectedState, expectedToken);
		if (result) return result;
		if (Date.now() >= deadline) break;
		waitForStartupInterval(Math.min(20, Math.max(1, deadline - Date.now())));
	}
	const finalResult = readRunnerStartup(startupPath, expectedState, expectedToken);
	if (finalResult) return finalResult;
	return { ok: false, error: `Timed out after ${timeoutMs}ms waiting for the async runner startup state '${expectedState}'.`, startupDidNotProceed: true };
}

function writeRunnerStartupControl(filePath: string, payload: { action: "ack" | "proceed"; token: string }): void {
	// Delegate to the shared atomic JSON writer (temp file + rename, retrying
	// transient Windows EPERM/EBUSY/EACCES locks and cleaning up the temp file
	// on failure), so the startup handshake gets the same locking resilience as
	// every other async control/result file. This is exercised by
	// test/unit/atomic-json.test.ts.
	writePrivateAtomicJson(filePath, payload);
}

function runnerIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function terminateRunnerBeforeProceed(pid: number): boolean {
	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		if (!runnerIsAlive(pid)) return true;
		try {
			process.kill(pid, signal);
		} catch {
			if (!runnerIsAlive(pid)) return true;
		}
		const deadline = Date.now() + 1000;
		while (runnerIsAlive(pid) && Date.now() < deadline) waitForStartupInterval();
	}
	return !runnerIsAlive(pid);
}

function persistPreProceedStartupFailure(asyncDir: string, runId: string, runnerProcessInstanceId: string, sessionId: string | undefined, completionOwnerId: string | undefined, message: string): void {
	const now = Date.now();
	try {
		const statusPath = path.join(asyncDir, "status.json");
		let status: Partial<AsyncStatus> = {};
		try {
			status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as Partial<AsyncStatus>;
		} catch {}
		writePrivateAtomicJson(statusPath, {
			...status,
			runId,
			...(sessionId ? { sessionId } : {}),
			...(completionOwnerId ? { completionOwnerId } : {}),
			state: "failed",
			lastUpdate: now,
			error: message,
			processTerminal: {
				version: 1,
				state: "not-started",
				runId,
				runnerProcessInstanceId,
			},
		});
		writePrivateAtomicJson(path.join(asyncDir, "process-terminal-candidate.json"), {
			version: 1,
			runId,
			runnerProcessInstanceId,
			writers: {},
			expectedWriters: { 0: 0 },
		});
	} catch {
		// Startup failures must still return the original launch error.
	}
}

interface SpawnRunnerResult {
	pid?: number;
	runnerProcessInstanceId?: string;
	error?: string;
	terminationObserved?: boolean;
	startupDidNotProceed?: boolean;
}

function spawnRunner(cfg: object, suffix: string, cwd: string, onProcessTerminal?: (proof: unknown) => void): SpawnRunnerResult {
	if (!jitiCliPath) {
		return { error: "upstream jiti for TypeScript execution could not be found; ensure package dependencies are installed" };
	}

	try {
		const cwdStats = fs.statSync(cwd);
		if (!cwdStats.isDirectory()) {
			return { error: `cwd is not a directory: ${cwd}` };
		}
	} catch {
		return { error: `cwd does not exist: ${cwd}` };
	}

	fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
	const cfgPath = getAsyncConfigPath(suffix);
	const runnerProcessInstanceId = randomUUID();
	const launchConfig = { ...cfg, runnerProcessInstanceId };
	fs.writeFileSync(cfgPath, JSON.stringify(launchConfig));
	const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "subagent-runner.ts");
	const nodeCommand = resolveNodeExecutable();
	const launchForStartup = launchConfig as typeof launchConfig & { asyncDir?: unknown; id?: unknown; sessionId?: unknown; completionOwnerId?: unknown; revivalLease?: unknown };
	const launchAsyncDir = typeof launchForStartup.asyncDir === "string" ? launchForStartup.asyncDir : undefined;
	const launchRunId = typeof launchForStartup.id === "string" ? launchForStartup.id : suffix;
	const launchSessionId = typeof launchForStartup.sessionId === "string" ? launchForStartup.sessionId : undefined;
	const launchCompletionOwnerId = typeof launchForStartup.completionOwnerId === "string" ? launchForStartup.completionOwnerId : undefined;
	const startupPath = typeof launchForStartup.revivalLease === "object" && launchAsyncDir
		? path.join(launchAsyncDir, "runner-startup.json")
		: undefined;
	const startupAckPath = startupPath ? path.join(path.dirname(startupPath), "runner-startup-ack.json") : undefined;
	const startupProceedPath = startupPath ? path.join(path.dirname(startupPath), "runner-startup-proceed.json") : undefined;
	if (startupPath) fs.rmSync(startupPath, { force: true });
	if (startupAckPath) fs.rmSync(startupAckPath, { force: true });
	if (startupProceedPath) fs.rmSync(startupProceedPath, { force: true });

	const logPaths = resolveAsyncRunnerLogPaths(launchConfig);
	let stdoutFd: number | undefined;
	let stderrFd: number | undefined;
	try {
		if (logPaths) {
			fs.mkdirSync(path.dirname(logPaths.stdoutPath), { recursive: true });
			stdoutFd = fs.openSync(logPaths.stdoutPath, "a");
			stderrFd = fs.openSync(logPaths.stderrPath, "a");
		}
		const proc = spawn(nodeCommand, [jitiCliPath, runner, cfgPath], {
			cwd,
			detached: true,
			stdio: ["ignore", stdoutFd ?? "ignore", stderrFd ?? "ignore"],
			windowsHide: true,
			env: {
				...process.env,
				...(piPackageRoot ? { [PI_CODING_AGENT_PACKAGE_ROOT_ENV]: piPackageRoot } : {}),
			},
		});
		closeFd(stdoutFd);
		closeFd(stderrFd);
		proc.on("error", (error) => {
			console.error(`[pi-subagents] async spawn failed: ${error.message}`);
		});
		proc.once("close", (exitCode, signal) => {
			const launch = launchConfig as { asyncDir?: unknown; id?: unknown; nestedRoute?: NestedRouteInfo; nestedSelf?: { parentRunId: string; parentStepIndex?: number; depth: number; path?: Array<{ runId: string; stepIndex?: number; agent?: string }> } };
			const asyncDir = launch.asyncDir;
			const runId = launch.id;
			if (typeof asyncDir !== "string" || typeof runId !== "string") return;
			finalizeProcessTerminal(asyncDir, runId, {
				processInstanceId: runnerProcessInstanceId,
				closeObservedAt: Date.now(),
				exitCode,
				signal,
			});
			const persisted = readProcessTerminal(asyncDir, { runId, runnerProcessInstanceId });
			if (!persisted) return;
			if (launch.nestedRoute && launch.nestedSelf) {
				try {
					let status: import("../../shared/types.ts").AsyncStatus;
					try {
						status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as import("../../shared/types.ts").AsyncStatus;
						status.processTerminal = persisted;
					} catch {
						status = {
							runId,
							mode: "single",
							state: persisted.state === "observed" ? "complete" : "failed",
							startedAt: persisted.observedAt ?? Date.now(),
							lastUpdate: Date.now(),
							processTerminal: persisted,
						};
					}
					writeNestedEvent(launch.nestedRoute, {
						type: "subagent.nested.completed",
						ts: Date.now(),
						parentRunId: launch.nestedSelf.parentRunId,
						parentStepIndex: launch.nestedSelf.parentStepIndex,
						child: nestedSummaryFromAsyncStatus(status, asyncDir, {
							id: runId,
							parentRunId: launch.nestedSelf.parentRunId,
							parentStepIndex: launch.nestedSelf.parentStepIndex,
							depth: launch.nestedSelf.depth,
							path: launch.nestedSelf.path,
							mode: status.mode,
							ts: Date.now(),
						}),
					});
				} catch (error) {
					console.error("Failed to emit final nested process-terminal status:", error);
				}
			}
			onProcessTerminal?.(persisted);
		});
		if (typeof proc.pid !== "number") {
			return { error: `async runner did not produce a pid for cwd: ${cwd}` };
		}
		proc.unref();
		if (startupPath && startupAckPath && startupProceedPath) {
			const persistStartupFailure = (message: string) => {
				if (launchAsyncDir) persistPreProceedStartupFailure(launchAsyncDir, launchRunId, runnerProcessInstanceId, launchSessionId, launchCompletionOwnerId, message);
			};
			const ready = waitForRunnerStartup(startupPath, "ready", RUNNER_STARTUP_TIMEOUT_MS);
			if (ready.ok === false) {
				persistStartupFailure(ready.error);
				const terminationObserved = terminateRunnerBeforeProceed(proc.pid);
				return { pid: proc.pid, runnerProcessInstanceId, error: ready.error, terminationObserved, startupDidNotProceed: ready.startupDidNotProceed };
			}
			try {
				writeRunnerStartupControl(startupAckPath, { action: "ack", token: ready.token });
			} catch (error) {
				const message = `Failed to acknowledge async runner startup: ${error instanceof Error ? error.message : String(error)}`;
				persistStartupFailure(message);
				const terminationObserved = terminateRunnerBeforeProceed(proc.pid);
				return { pid: proc.pid, runnerProcessInstanceId, error: message, terminationObserved, startupDidNotProceed: true };
			}
			const acknowledged = waitForRunnerStartup(startupPath, "acknowledged", RUNNER_STARTUP_TIMEOUT_MS, ready.token);
			if (acknowledged.ok === false) {
				persistStartupFailure(acknowledged.error);
				const terminationObserved = terminateRunnerBeforeProceed(proc.pid);
				return { pid: proc.pid, runnerProcessInstanceId, error: acknowledged.error, terminationObserved, startupDidNotProceed: acknowledged.startupDidNotProceed };
			}
			try {
				writeRunnerStartupControl(startupProceedPath, { action: "proceed", token: ready.token });
			} catch (error) {
				const message = `Failed to authorize async runner startup: ${error instanceof Error ? error.message : String(error)}`;
				persistStartupFailure(message);
				const terminationObserved = terminateRunnerBeforeProceed(proc.pid);
				return { pid: proc.pid, runnerProcessInstanceId, error: message, terminationObserved, startupDidNotProceed: true };
			}
			try {
				fs.rmSync(startupPath, { force: true });
			} catch {
				// Proceed is the commit point; handshake cleanup cannot turn a running revival into a start error.
			}
		}
		return { pid: proc.pid, runnerProcessInstanceId };
	} catch (error) {
		closeFd(stdoutFd);
		closeFd(stderrFd);
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function formatAsyncStartError(mode: SubagentRunMode, message: string): AsyncExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode, results: [] },
	};
}

const UNAVAILABLE_SUBAGENT_SKILL_ERROR = "Skills not found: pi-subagents";

class UnavailableSubagentSkillError extends Error {}
class AsyncStartValidationError extends Error {}

export function buildAsyncRunnerSteps(id: string, params: AsyncRunnerStepBuildParams): AsyncRunnerStepBuildResult {
	const {
		chain,
		agents,
		ctx,
		cwd,
		sessionFilesByFlatIndex,
		thinkingOverridesByFlatIndex,
		maxSubagentDepth,
		worktreeBaseDir,
		asyncDir,
	} = params;
	const outputBaseDir = params.outputBaseDir;
	const resultMode = params.resultMode ?? "chain";
	const chainSkills = params.chainSkills ?? [];
	const availableModels = params.availableModels;
	const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
	const progressDir = params.progressDir ?? runnerCwd;
	const graphChain: ChainStep[] = params.attachRoot
		? [{
				agent: params.attachRoot.agent,
				task: `Attach async root ${params.attachRoot.runId}`,
				label: params.attachRoot.label ?? `Attached root ${params.attachRoot.runId}`,
				...(params.attachRoot.outputName ? { as: params.attachRoot.outputName } : {}),
			}, ...chain]
		: chain;
	const firstStep = chain[0];
	const originalTask = params.task ?? (firstStep
		? (isParallelStep(firstStep)
			? firstStep.parallel[0]?.task
			: isDynamicParallelStep(firstStep)
				? firstStep.parallel.task
				: (firstStep as SequentialStep).task)
		: undefined);
	try {
		if (params.validateOutputBindings !== false) {
			validateChainOutputBindings(chain, { maxItems: params.dynamicFanoutMaxItems });
		}
	} catch (error) {
		if (error instanceof ChainOutputValidationError) return { error: error.message };
		throw error;
	}
	const workflowGraph = buildWorkflowGraphSnapshot({ runId: id, mode: resultMode, steps: graphChain });

	for (const s of chain) {
		const stepAgents = isParallelStep(s)
			? s.parallel.map((t) => t.agent)
			: isDynamicParallelStep(s)
				? [s.parallel.agent]
				: [(s as SequentialStep).agent];
		for (const agentName of stepAgents) {
			if (!agents.find((x) => x.name === agentName)) {
				return { error: `Unknown agent: ${agentName}` };
			}
		}
	}

	let progressInstructionCreated = false;
	const buildStepOverrides = (s: SequentialStep): StepOverrides => {
		const stepSkillInput = normalizeSkillInput(s.skill);
		return {
			...(s.output !== undefined ? { output: s.output } : {}),
			...(s.outputMode !== undefined ? { outputMode: s.outputMode } : {}),
			...(s.reads !== undefined ? { reads: s.reads } : {}),
			...(s.progress !== undefined ? { progress: s.progress } : {}),
			...(stepSkillInput !== undefined ? { skills: stepSkillInput } : {}),
			...(s.model !== undefined ? { model: s.model } : {}),
		};
	};
	const buildSeqStep = (s: SequentialStep, sessionFile?: string, behaviorCwd?: string, progressPrecreated = false, resolvedBehavior?: ResolvedStepBehavior, flatIndex?: number, parallelOutputNamespace?: { stepIndex: number; taskIndex?: number }, runFanoutPath?: string) => {
		const a = agents.find((x) => x.name === s.agent)!;
		const externalRunner = a.runner?.type === "external-cli" || a.runner?.type === "external-job";
		const externalRunnerType = a.runner?.type;
		if (externalRunner) {
			const unsupported: string[] = [];
			if (s.model !== undefined) unsupported.push("model override");
			if (s.outputSchema !== undefined) unsupported.push("structured output");
			if (s.acceptance !== undefined || params.agentContract !== undefined || s.agentContract !== undefined) unsupported.push("acceptance/agent contract");
			if (s.toolBudget !== undefined || params.toolBudget !== undefined || a.toolBudget !== undefined || params.configToolBudget !== undefined) unsupported.push("tool budget");
			if (params.contextForAgent?.(s.agent) === "fork") unsupported.push("fork context");
			if (unsupported.length > 0) throw new AsyncStartValidationError(`Agent '${a.name}' uses runner.type='${externalRunnerType}' and does not support: ${unsupported.join(", ")}.`);
		}
		try {
			assertAgentAllowedByCapabilityCeiling(a.name, intersectSubagentCapabilityCeilings(params.capabilityCeiling, decodeSubagentCapabilityCeiling(process.env[SUBAGENT_CAPABILITY_CEILING_ENV])));
		} catch (error) {
			throw new AsyncStartValidationError(error instanceof Error ? error.message : String(error));
		}
		const toolBudgetInput = s.toolBudget ?? params.toolBudget ?? a.toolBudget ?? params.configToolBudget;
		const resolvedToolBudget = validateToolBudgetConfig(toolBudgetInput, s.toolBudget ? "toolBudget" : a.toolBudget ? "agent.toolBudget" : "config.toolBudget");
		if (resolvedToolBudget.error) throw new AsyncStartValidationError(resolvedToolBudget.error);
		const resolvedToolTimeout = resolveToolTimeoutMs({
			callValue: params.callToolTimeoutMs,
			agentValue: a.defaultToolTimeoutMs,
			configValue: params.configToolTimeoutMs,
			envValue: params.toolTimeoutMsEnv ?? toolTimeoutFromEnv(),
		});
		if (resolvedToolTimeout.error) throw new AsyncStartValidationError(resolvedToolTimeout.error);
		const stepCwd = resolveChildCwd(runnerCwd, s.cwd);
		const instructionCwd = behaviorCwd ?? stepCwd;
		const readExistenceCwd = behaviorCwd ? stepCwd : instructionCwd;
		let behavior = suppressProgressForReadOnlyTask(resolvedBehavior ?? resolveStepBehavior(a, buildStepOverrides(s), chainSkills), s.task, originalTask);
		const inheritedRelativeParallelOutput = parallelOutputNamespace && s.output === undefined && typeof behavior.output === "string" && !path.isAbsolute(behavior.output);
		if (inheritedRelativeParallelOutput && parallelOutputNamespace.taskIndex !== undefined) {
			behavior = {
				...behavior,
				output: path.join(`parallel-${parallelOutputNamespace.stepIndex}`, `${parallelOutputNamespace.taskIndex}-${s.agent}`, behavior.output as string),
			};
		}
		const namespaceOutputPath = Boolean(inheritedRelativeParallelOutput && parallelOutputNamespace.taskIndex === undefined);
		const skillNames = behavior.skills === false ? [] : behavior.skills;
		const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(
			skillNames,
			stepCwd,
			ctx.cwd,
			a.skillPath,
			a.filePath ? path.dirname(a.filePath) : stepCwd,
		);
		if (missingSkills.includes("pi-subagents")) throw new UnavailableSubagentSkillError(UNAVAILABLE_SUBAGENT_SKILL_ERROR);

		let systemPrompt = a.systemPrompt?.trim() ?? "";
		if (resolvedSkills.length > 0) {
			const injection = buildSkillInjection(resolvedSkills);
			systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
		}
		const memoryInjection = buildAgentMemoryInjection(a, stepCwd);
		if (memoryInjection) {
			systemPrompt = systemPrompt ? `${systemPrompt}\n\n${memoryInjection}` : memoryInjection;
		}
		systemPrompt = appendAgentRefinementOverlay(systemPrompt, { cwd: stepCwd, agentName: a.name });

		const readInstructions = buildChainInstructions({ ...behavior, output: false, progress: false }, instructionCwd, false, undefined, readExistenceCwd);
		const isFirstProgressAgent = behavior.progress && !progressPrecreated && !progressInstructionCreated;
		if (behavior.progress) progressInstructionCreated = true;
		const progressInstructions = buildChainInstructions({ ...behavior, output: false, reads: false }, progressDir, isFirstProgressAgent);
		const outputPath = resolveSingleOutputPath(behavior.output, ctx.cwd, instructionCwd, outputBaseDir);
		if (!namespaceOutputPath) systemPrompt = injectOutputPathSystemPrompt(systemPrompt, outputPath, a);
		const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath, `Async step (${s.agent})`);
		if (validationError) throw new AsyncStartValidationError(validationError);
		let taskTemplate = s.task ?? "{previous}";
		taskTemplate = taskTemplate.replace(/\{task\}/g, originalTask ?? "");
		taskTemplate = taskTemplate.replace(/\{chain_dir\}/g, runnerCwd);
		const taskText = `${readInstructions.prefix}${taskTemplate}${progressInstructions.suffix}`;
		const task = namespaceOutputPath ? taskText : injectSingleOutputInstruction(taskText, outputPath, a);

		const modelScopes = resolveModelScopesForAgent(ctx.modelScope, a.name, ctx.currentModel);
		const primaryModelFromParent = inheritsParentModel(s.model, a.model, ctx.currentModel);
		const primaryModel = externalRunner ? undefined : resolveEffectiveSubagentModel(
			s.model,
			a.model,
			ctx.currentModel,
			availableModels,
			ctx.currentModelProvider,
			{ scope: modelScopes },
		);
		const thinkingOverride = flatIndex === undefined ? undefined : thinkingOverridesByFlatIndex?.[flatIndex];
		const effectiveThinking = externalRunner ? undefined : thinkingOverride ?? a.thinking;
		const model = externalRunner ? undefined : applyThinkingSuffix(primaryModel, effectiveThinking, thinkingOverride !== undefined);
		const agentContract = s.agentContract ?? params.agentContract;
		const permissionRules = resolvePermissionRules(ctx.permissions, a.permissions);
		const toolPlan = resolvePiLaunchToolPlan({
			tools: a.tools,
			extensions: a.extensions,
			subagentOnlyExtensions: a.subagentOnlyExtensions,
			mcpDirectTools: a.mcpDirectTools,
			cwd: stepCwd,
			requireReadTool: Boolean(resolvedSkills.length),
			structuredOutput: Boolean(s.outputSchema),
			capabilityCeiling: params.capabilityCeiling,
			inheritedCapabilityCeiling: decodeSubagentCapabilityCeiling(process.env[SUBAGENT_CAPABILITY_CEILING_ENV]),
			agentName: a.name,
			permissionRules,
		});
		const launchResolvedExtensions = externalRunner ? undefined : projectLaunchResolvedChildExtensions(toolPlan);
		if (externalRunner && permissionRules) {
			throw new AsyncStartValidationError(`Agent '${a.name}' uses runner.type='${externalRunnerType}', which cannot enforce native Pi child permission rules.`);
		}
		if (!externalRunner) {
			const contractTools = toolPlan.explicitToolAllowlist ? toolPlan.effectiveToolAllowlist : undefined;
			const contractError = validateImplementationToolContract({
				agent: a.name,
				task,
				tools: contractTools,
				mcpDirectTools: toolPlan.effectiveMcpTools,
				configuredExtensions: toolPlan.configuredExtensions,
				requestedTools: toolPlan.requestedBuiltinTools,
				acceptanceRole: a.acceptanceRole,
				completionGuard: a.completionGuard,
			});
			if (contractError) throw new AsyncStartValidationError(contractError);
		}
		return {
			parentSessionId: ctx.parentSessionId ?? ctx.currentSessionId,
			permissionRules,
			...(params.capabilityCeiling ? { capabilityCeiling: params.capabilityCeiling } : {}),
			...(runFanoutPath ? { runFanoutPath } : {}),
			agent: s.agent,
			task,
			...(a.runner ? { runner: a.runner } : {}),
			...(params.contextForAgent ? { context: params.contextForAgent(s.agent) } : {}),
			...(agentContract ? { agentContract } : {}),
			phase: s.phase,
			label: s.label,
			outputName: s.as,
			structured: Boolean(s.outputSchema),
			cwd: stepCwd,
			model,
			thinking: resolveEffectiveThinking(model, effectiveThinking),
			launchResolvedExtensions,
			modelCandidates: externalRunner ? undefined : buildModelCandidates(primaryModel, a.fallbackModels, availableModels, ctx.currentModelProvider, {
				scope: modelScopes,
				primaryModelFromParent,
				// No profiles yet on the legacy path: qualify with the legacy floor so a
				// fallback pool never silently includes models too small for the task.
				qualification: { requiredCapabilities: [], minContext: LEGACY_FALLBACK_MIN_CONTEXT },
			}).map((candidate) =>
				applyThinkingSuffix(candidate, effectiveThinking, thinkingOverride !== undefined),
			),
			...(primaryModelFromParent ? { skipPrimaryModelVerification: true } : {}),
			...(availableModels && availableModels.length > 0 ? { modelVerificationRegistry: availableModels } : {}),
			tools: a.tools,
			extensions: a.extensions,
			subagentOnlyExtensions: a.subagentOnlyExtensions,
			mcpDirectTools: a.mcpDirectTools,
			completionGuard: a.completionGuard,
			systemPrompt,
			systemPromptMode: a.systemPromptMode,
			inheritProjectContext: a.inheritProjectContext,
			inheritSkills: a.inheritSkills,
			skills: resolvedSkills.map((r) => r.name),
			outputPath,
			...(namespaceOutputPath ? { namespaceOutputPath: true } : {}),
			outputMode: behavior.outputMode,
			sessionFile,
			maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, a.maxSubagentDepth),
			timeoutMs: a.defaultTimeoutMs ?? DEFAULT_ASYNC_TIMEOUT_MS,
			toolTimeoutMs: resolvedToolTimeout.toolTimeoutMs,
			waitToolEnabled: params.waitToolEnabled,
			effectiveAcceptance: resolveEffectiveAcceptance({
				explicit: s.acceptance,
				agentName: s.agent,
				acceptanceRole: a.acceptanceRole,
				task,
				mode: resultMode,
				async: true,
				dynamic: false,
				agentContract,
			}),
			acceptanceInput: s.acceptance,
			acceptanceRole: a.acceptanceRole,
			...(s.gateOn ? { gateOn: s.gateOn } : {}),
			...(s.outputSchema ? { structuredOutputSchema: s.outputSchema } : {}),
			...(s.outputSchema ? { structuredOutput: createStructuredOutputRuntime(s.outputSchema, path.join(asyncDir, "structured-output")) } : {}),
			...(resolvedToolBudget.budget ? { toolBudget: resolvedToolBudget.budget } : {}),
			...(s.worktree ? { worktree: true } : {}),
		};
	};

	let flatStepIndex = 0;
	const nextFlatStep = (): { index: number; sessionFile?: string; thinkingOverride?: AgentConfig["thinking"] } => {
		const index = flatStepIndex;
		const sessionFile = sessionFilesByFlatIndex?.[flatStepIndex];
		const thinkingOverride = thinkingOverridesByFlatIndex?.[flatStepIndex];
		flatStepIndex++;
		return {
			index,
			...(sessionFile ? { sessionFile } : {}),
			...(thinkingOverride ? { thinkingOverride } : {}),
		};
	};

	try {
		const builtSteps = chain.map((s, stepIndex) => {
			if (isParallelStep(s)) {
				const parallelBehaviors = s.parallel.map((task) => {
					const agent = agents.find((candidate) => candidate.name === task.agent)!;
					return suppressProgressForReadOnlyTask(resolveStepBehavior(agent, buildStepOverrides(task), chainSkills), task.task, originalTask);
				});
				const progressPrecreated = parallelBehaviors.some((behavior) => behavior.progress);
				if (progressPrecreated) {
					if (!s.worktree || params.progressDir) writeInitialProgressFile(progressDir);
					progressInstructionCreated = true;
				}
				// Task-management: cap all-scout fan-out so one scout pool isn't saturated
				// by a large parallel group running the same model concurrently.
				const isScoutFanout = s.parallel.every((task) => task.agent === "scout");
				const concurrency = isScoutFanout
					? Math.min(s.concurrency ?? 10, SCOUT_MAX_FANOUT)
					: (s.concurrency ?? 10);
				return {
					parallel: s.parallel.map((t, taskIndex) => {
						let behaviorCwd: string | undefined;
						if (s.worktree) {
							try {
								behaviorCwd = resolveExpectedWorktreeAgentCwd(runnerCwd, `${id}-s${stepIndex}`, taskIndex, worktreeBaseDir);
							} catch {
								behaviorCwd = undefined;
							}
						}
						const staticStep = nextFlatStep();
						return buildSeqStep({ ...t, agentContract: t.agentContract ?? s.agentContract, gateOn: t.gateOn ?? s.gateOn }, staticStep.sessionFile, behaviorCwd, progressPrecreated, parallelBehaviors[taskIndex], staticStep.index, { stepIndex, taskIndex }, resultMode === "parallel" ? `tasks[${taskIndex}]` : `chain[${stepIndex}].parallel[${taskIndex}]`);
					}),
					concurrency,
					failFast: s.failFast,
					worktree: s.worktree,
				};
			}
			if (isDynamicParallelStep(s)) {
				const agent = agents.find((candidate) => candidate.name === s.parallel.agent)!;
				const behavior = suppressProgressForReadOnlyTask(resolveStepBehavior(agent, buildStepOverrides(s.parallel), chainSkills), s.parallel.task, originalTask);
				const progressPrecreated = behavior.progress;
				if (progressPrecreated) {
					writeInitialProgressFile(progressDir);
					progressInstructionCreated = true;
				}
				const maxItems = s.expand.maxItems ?? params.dynamicFanoutMaxItems ?? 0;
				const dynamicFlatSteps = Array.from({ length: maxItems }, () => nextFlatStep());
				const parallel = buildSeqStep({ ...(s.parallel as SequentialStep), agentContract: s.parallel.agentContract ?? s.agentContract, gateOn: s.parallel.gateOn ?? s.gateOn }, undefined, undefined, progressPrecreated, behavior, undefined, { stepIndex });
				// Task-management: cap dynamic scout fan-out to SCOUT_MAX_FANOUT (same-model saturation guard).
				const isScoutFanout = s.parallel.agent === "scout";
				const concurrency = isScoutFanout
					? Math.min(s.concurrency ?? 10, SCOUT_MAX_FANOUT)
					: (s.concurrency ?? 10);
				return {
					expand: s.expand,
					parallel,
					collect: s.collect,
					concurrency,
					failFast: s.failFast,
					phase: s.phase,
					label: s.label,
					sessionFiles: dynamicFlatSteps.map((step) => step.sessionFile),
					thinkingOverrides: dynamicFlatSteps.map((step) => step.thinkingOverride),
					effectiveAcceptance: resolveEffectiveAcceptance({
						explicit: s.acceptance,
						agentName: s.parallel.agent,
						acceptanceRole: agent.acceptanceRole,
						task: parallel.task,
						mode: resultMode,
						async: true,
						dynamicGroup: true,
						agentContract: s.agentContract ?? params.agentContract,
					}),
					acceptanceInput: s.acceptance,
					acceptanceRole: agent.acceptanceRole,
					...(s.agentContract ?? params.agentContract ? { agentContract: s.agentContract ?? params.agentContract } : {}),
					...(s.gateOn ? { gateOn: s.gateOn } : {}),
				};
			}
			const sequential = s as SequentialStep;
			let behaviorCwd: string | undefined;
			if (sequential.worktree) {
				try {
					behaviorCwd = resolveExpectedWorktreeAgentCwd(runnerCwd, `${id}-s${stepIndex}`, 0, worktreeBaseDir);
				} catch {
					behaviorCwd = undefined;
				}
			}
			const staticStep = nextFlatStep();
			return buildSeqStep(sequential, staticStep.sessionFile, behaviorCwd, false, undefined, staticStep.index, undefined, `chain[${stepIndex}]`);
		});
		const steps = params.attachRoot
			? [{
					agent: params.attachRoot.agent,
					task: "",
					label: params.attachRoot.label ?? `Attached root ${params.attachRoot.runId}`,
					outputName: params.attachRoot.outputName,
					importAsyncRoot: {
						runId: params.attachRoot.runId,
						asyncDir: params.attachRoot.asyncDir,
						resultPath: params.attachRoot.resultPath,
						index: params.attachRoot.index,
					},
					inheritProjectContext: false,
					inheritSkills: false,
				}, ...builtSteps]
			: builtSteps;
		for (const step of steps) {
			if (!("parallel" in step) || !Array.isArray(step.parallel)) continue;
			const seen = new Map<string, { index: number; agent: string }>();
			for (let index = 0; index < step.parallel.length; index++) {
				const task = step.parallel[index]!;
				if (!task.outputPath) continue;
				const previous = seen.get(task.outputPath);
				if (previous) {
					throw new AsyncStartValidationError(`Parallel tasks ${previous.index + 1} (${previous.agent}) and ${index + 1} (${task.agent}) resolve output to the same path: ${task.outputPath}. Use distinct output paths.`);
				}
				seen.set(task.outputPath, { index, agent: task.agent });
			}
		}
		// Task-management: apply profiles (batch-diverse work candidates) to the planned
		// steps before the runner sees them. A rejected profile (bad graph, length
		// mismatch, invalid field) aborts the build.
		if (params.profiles) {
			const profileResult = applyProfileModels(steps as RunnerStep[], params.profiles, params.availableModels, undefined, ctx.currentModel, agents);
			if (profileResult.error) return { error: profileResult.error };
		}
		return { steps: steps as RunnerStep[], runnerCwd, workflowGraph, eventChain: graphChain, ...(originalTask !== undefined ? { originalTask } : {}) };
	} catch (error) {
		if (error instanceof UnavailableSubagentSkillError || error instanceof AsyncStartValidationError) return { error: error.message };
		throw error;
	}
}

/**
 * Execute a chain asynchronously
 */
export function executeAsyncChain(
	id: string,
	params: AsyncChainParams,
): AsyncExecutionResult {
	const {
		chain,
		agents,
		ctx,
		cwd,
		maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled,
		sessionRoot,
		sessionFilesByFlatIndex,
		thinkingOverridesByFlatIndex,
		maxSubagentDepth,
		worktreeSetupHook,
		worktreeSetupHookTimeoutMs,
		worktreeBaseDir,
		controlConfig,
		controlIntercomTarget,
		childIntercomTarget,
		nestedRoute,
	} = params;
	const resultMode = params.resultMode ?? "chain";
	const acceptanceErrors = validateExecutionAcceptance({
		chain: chain.map((step) => {
			if (isParallelStep(step)) return { parallel: step.parallel };
			if (isDynamicParallelStep(step)) return { acceptance: step.acceptance, parallel: step.parallel };
			return { acceptance: step.acceptance };
		}),
	});
	if (acceptanceErrors.length > 0) return formatAsyncStartError(resultMode, acceptanceErrors.join(" "));
	const capabilityCeiling = params.capabilityCeiling ?? resolveCurrentSubagentCapabilityCeiling(ctx.currentSessionId);
	const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
	const nestedAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
	const asyncDir = inheritedNestedRoute
		? path.join(TEMP_ROOT_DIR, "nested-subagent-runs", inheritedNestedRoute.rootRunId, id)
		: path.join(DIRS.async, id);
	let runFanoutBudget: RunFanoutBudgetDescriptor;
	try {
		runFanoutBudget = params.runFanoutBudget ?? createRunFanoutBudget(id, 64);
		fs.mkdirSync(asyncDir, { recursive: true });
		writeRunFanoutBudgetDescriptor(asyncDir, runFanoutBudget);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` }],
			isError: true,
			details: { mode: resultMode, results: [] },
		};
	}

	const built = buildAsyncRunnerSteps(id, {
		chain,
		task: params.task,
		attachRoot: params.attachRoot,
		resultMode,
		agents,
		ctx,
		availableModels: params.availableModels,
		cwd,
		chainSkills: params.chainSkills,
		sessionFilesByFlatIndex,
		thinkingOverridesByFlatIndex,
		contextForAgent: params.contextForAgent,
		progressDir: params.progressDir ?? (artifactsDir ? path.join(artifactsDir, "progress", id) : resultMode === "parallel" ? path.join(asyncDir, "progress") : undefined),
		agentContract: params.agentContract,
		outputBaseDir: artifactsDir ? path.join(artifactsDir, "outputs", id) : undefined,
		dynamicFanoutMaxItems: params.dynamicFanoutMaxItems,
		maxSubagentDepth,
		waitToolEnabled: params.waitToolEnabled,
		worktreeBaseDir,
		asyncDir,
		toolBudget: params.toolBudget,
		configToolBudget: params.configToolBudget,
		callToolTimeoutMs: params.callToolTimeoutMs,
		configToolTimeoutMs: params.configToolTimeoutMs,
		toolTimeoutMsEnv: params.toolTimeoutMsEnv ?? toolTimeoutFromEnv(),
		capabilityCeiling,
		profiles: params.profiles,
	});
	if ("error" in built) {
		try {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup for validation failures before the runner is spawned.
		}
		return formatAsyncStartError(resultMode, built.error);
	}
	const { steps, runnerCwd, workflowGraph, eventChain } = built;
	const deadlineAt = params.timeoutMs !== undefined ? Date.now() + params.timeoutMs : undefined;
	const initialTurnBudget = params.turnBudget ? initialTurnBudgetState(params.turnBudget) : undefined;
	const initialUsageBudget = usageBudgetState(params.usageBudget, undefined);
	let childTargetIndex = 0;
	const childIntercomTargets = childIntercomTarget ? steps.flatMap((step) => {
		if (!("parallel" in step) && "importAsyncRoot" in step && step.importAsyncRoot) {
			childTargetIndex++;
			return [undefined];
		}
		if ("parallel" in step) {
			if (!Array.isArray(step.parallel)) {
				childTargetIndex++;
				return [undefined];
			}
			return step.parallel.map((task) => childIntercomTarget(task.agent, childTargetIndex++));
		}
		return "agent" in step ? [childIntercomTarget(step.agent, childTargetIndex++)] : [undefined];
	}) : undefined;

	let spawnResult: SpawnRunnerResult = {};
	try {
		spawnResult = spawnRunner(
			{
				id,
				steps,
				profiles: params.profiles,
				resultPath: inheritedNestedRoute ? nestedResultsPath(inheritedNestedRoute.rootRunId, id) : resultFilePath(DIRS.results, id),
				cwd: runnerCwd,
				placeholder: "{previous}",
				maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				share: shareEnabled,
				sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
				asyncDir,
				sessionId: ctx.currentSessionId,
				completionOwnerId: ctx.completionOwnerId ?? currentCompletionOwnerId(),
				...(capabilityCeiling ? { capabilityCeiling } : {}),
				piPackageRoot,
				piArgv1: process.argv[1],
				worktreeSetupHook,
				worktreeSetupHookTimeoutMs,
				worktreeBaseDir,
				controlConfig,
				turnBudget: params.turnBudget,
				toolBudget: params.toolBudget,
				usageBudget: params.usageBudget,
				controlIntercomTarget,
				childIntercomTargets,
				resultMode,
				dynamicFanoutMaxItems: params.dynamicFanoutMaxItems,
				timeoutMs: params.timeoutMs,
				deadlineAt,
				globalConcurrencyLimit: params.globalConcurrencyLimit,
				runFanoutBudget,
				workflowGraph,
				...(params.parentWorkflowRunId ? { parentWorkflowRunId: params.parentWorkflowRunId } : {}),
				...(params.workflowKey ? { workflowKey: params.workflowKey } : {}),
				nestedRoute: nestedRoute ?? inheritedNestedRoute,
				nestedSelf: inheritedNestedRoute && nestedAddress ? {
					parentRunId: nestedAddress.parentRunId,
					parentStepIndex: nestedAddress.parentStepIndex,
					depth: nestedAddress.depth,
					path: nestedAddress.path,
				} : undefined,
			},
			id,
			runnerCwd,
			(proof) => ctx.pi.events.emit(SUBAGENT_PROCESS_TERMINAL_EVENT, proof),
		);
	} catch (error) {
		params.activeAsyncCapacity?.rollback();
		const message = error instanceof Error ? error.message : String(error);
		return formatAsyncStartError(resultMode, `Failed to start async ${resultMode} '${id}': ${message}`);
	}

	if (spawnResult.error) {
		if (!spawnResult.pid || !spawnResult.runnerProcessInstanceId || (spawnResult.startupDidNotProceed && spawnResult.terminationObserved)) params.activeAsyncCapacity?.rollback();
		else params.activeAsyncCapacity?.markStarted(spawnResult.runnerProcessInstanceId);
		return formatAsyncStartError(resultMode, `Failed to start async ${resultMode} '${id}': ${spawnResult.error}`);
	}
	if (!spawnResult.pid || !spawnResult.runnerProcessInstanceId) {
		params.activeAsyncCapacity?.rollback();
		return formatAsyncStartError(resultMode, `Failed to start async ${resultMode} '${id}': runner identity unavailable`);
	}
	params.activeAsyncCapacity?.markStarted(spawnResult.runnerProcessInstanceId);

	if (spawnResult.pid) {
		const eventFirstStep = eventChain[0];
		if (!eventFirstStep) {
			return formatAsyncStartError(resultMode, `Failed to start async ${resultMode} '${id}': event chain has no steps`);
		}
		const firstAgents = isParallelStep(eventFirstStep)
			? eventFirstStep.parallel.map((t) => t.agent)
			: isDynamicParallelStep(eventFirstStep)
				? [eventFirstStep.parallel.agent]
			: [(eventFirstStep as SequentialStep).agent];
		const firstTask = isParallelStep(eventFirstStep)
			? eventFirstStep.parallel[0]?.task
			: isDynamicParallelStep(eventFirstStep)
				? eventFirstStep.parallel.task
				: (eventFirstStep as SequentialStep).task;
		const workflowGoal = params.goal ?? (params.task?.trim() || firstTask);
		const parallelGroups: Array<{ start: number; count: number; stepIndex: number }> = [];
		const flatAgents: string[] = [];
		let flatStepStart = 0;
		for (let stepIndex = 0; stepIndex < eventChain.length; stepIndex++) {
			const step = eventChain[stepIndex]!;
			if (isParallelStep(step)) {
				parallelGroups.push({ start: flatStepStart, count: step.parallel.length, stepIndex });
				flatAgents.push(...step.parallel.map((task) => task.agent));
				flatStepStart += step.parallel.length;
			} else if (isDynamicParallelStep(step)) {
				parallelGroups.push({ start: flatStepStart, count: 1, stepIndex });
				flatAgents.push(step.parallel.agent);
				flatStepStart++;
			} else {
				flatAgents.push((step as SequentialStep).agent);
				flatStepStart++;
			}
		}
		if (inheritedNestedRoute && nestedAddress) {
			const now = Date.now();
			try {
				writeNestedEvent(inheritedNestedRoute, {
					type: "subagent.nested.started",
					ts: now,
					parentRunId: nestedAddress.parentRunId,
					parentStepIndex: nestedAddress.parentStepIndex,
					child: {
						id,
						parentRunId: nestedAddress.parentRunId,
						parentStepIndex: nestedAddress.parentStepIndex,
						depth: nestedAddress.depth,
						path: nestedAddress.path,
						asyncDir,
						pid: spawnResult.pid,
						ownerIntercomTarget: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
						leafIntercomTarget: childIntercomTargets?.[0],
						intercomTarget: childIntercomTargets?.[0],
						ownerState: "live",
						mode: resultMode,
						state: "running",
						agent: firstAgents[0],
						agents: flatAgents,
						chainStepCount: eventChain.length,
						parallelGroups,
						...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, deadlineAt } : {}),
						...(initialTurnBudget ? { turnBudget: initialTurnBudget } : {}),
						startedAt: now,
						lastUpdate: now,
						...(capabilityCeiling ? { capabilityCeiling } : {}),
					},
				});
			} catch (error) {
				console.error("Failed to emit nested async start event:", error);
			}
		}
		ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			id,
			pid: spawnResult.pid,
			sessionId: ctx.currentSessionId,
			completionOwnerId: ctx.completionOwnerId ?? currentCompletionOwnerId(),
			mode: resultMode,
			agent: firstAgents[0],
			agents: flatAgents,
			task: firstTask?.trim() ? PROMPT_REDACTED : undefined,
			goal: workflowGoal?.trim() ? PROMPT_REDACTED : undefined,
			chain: eventChain.map((s) =>
				isParallelStep(s) ? `[${s.parallel.map((t) => t.agent).join("+")}]` : isDynamicParallelStep(s) ? `expand:${s.parallel.agent}` : (s as SequentialStep).agent,
			),
			chainStepCount: eventChain.length,
			parallelGroups,
			workflowGraph,
			cwd: runnerCwd,
			asyncDir,
			...(sessionRoot ? { sessionRoot } : {}),
			...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, deadlineAt } : {}),
			...(initialTurnBudget ? { turnBudget: initialTurnBudget } : {}),
			...(initialUsageBudget ? { usageBudget: initialUsageBudget } : {}),
			...(capabilityCeiling ? { capabilityCeiling } : {}),
			...(params.parentWorkflowRunId ? { parentWorkflowRunId: params.parentWorkflowRunId } : {}),
			...(params.workflowKey ? { workflowKey: params.workflowKey } : {}),
			nestedRoute,
		});
	}

	const chainDesc = chain
		.map((s) =>
			isParallelStep(s) ? `[${s.parallel.map((t) => t.agent).join("+")}]` : isDynamicParallelStep(s) ? `expand:${s.parallel.agent}` : (s as SequentialStep).agent,
		)
		.join(" -> ");

	return {
		content: [{ type: "text", text: formatAsyncStartedMessage(`Async ${resultMode}: ${chainDesc} [${id}]`, ctx.interactive === true) }],
		details: { mode: resultMode, runId: id, results: [], asyncId: id, asyncDir, workflowGraph, ...(capabilityCeiling ? { capabilityCeiling } : {}), ...(params.parentWorkflowRunId ? { parentWorkflowRunId: params.parentWorkflowRunId } : {}), ...(params.workflowKey ? { workflowKey: params.workflowKey } : {}), ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, deadlineAt } : {}), ...(params.turnBudget ? { turnBudget: params.turnBudget } : {}), ...(params.toolBudget ? { toolBudget: params.toolBudget } : {}), ...(initialUsageBudget ? { usageBudget: initialUsageBudget } : {}) },
	};
}

/**
 * Execute a single agent asynchronously
 */
export function workflowAwaitedAsyncResultPath(asyncDir: string): string {
	return path.join(asyncDir, "workflow-result.json");
}

export function executeAsyncSingle(
	id: string,
	params: AsyncSingleParams,
): AsyncExecutionResult {
	const {
		agent,
		agentConfig,
		ctx,
		cwd,
		maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled,
		sessionRoot,
		sessionFile,
		maxSubagentDepth,
		worktreeSetupHook,
		worktreeSetupHookTimeoutMs,
		worktreeBaseDir,
		controlConfig,
		controlIntercomTarget,
		childIntercomTarget,
		nestedRoute,
	} = params;
	const task = params.task ?? "";
	const acceptanceErrors = validateAcceptanceInput(params.acceptance);
	if (acceptanceErrors.length > 0) return formatAsyncStartError("single", acceptanceErrors.join(" "));
	const externalRunner = agentConfig.runner?.type === "external-cli" || agentConfig.runner?.type === "external-job";
	const externalRunnerType = agentConfig.runner?.type;
	const permissionRules = resolvePermissionRules(ctx.permissions, agentConfig.permissions);
	if (externalRunner) {
		const unsupported: string[] = [];
		if (params.modelOverride !== undefined) unsupported.push("model override");
		if (params.thinkingOverride !== undefined) unsupported.push("thinking override");
		if (params.structuredOutputSchema !== undefined) unsupported.push("structured output");
		if (params.acceptance !== undefined || params.agentContract !== undefined) unsupported.push("acceptance/agent contract");
		if (params.toolBudget !== undefined || agentConfig.toolBudget !== undefined || params.configToolBudget !== undefined) unsupported.push("tool budget");
		if (params.context === "fork") unsupported.push("fork context");
		if ((params.skills?.length ?? 0) > 0) unsupported.push("skills");
		if (permissionRules) unsupported.push("native Pi child permissions");
		if (unsupported.length > 0) return formatAsyncStartError("single", `Agent '${agentConfig.name}' uses runner.type='${externalRunnerType}' and does not support: ${unsupported.join(", ")}.`);
	}
	const capabilityCeiling = intersectSubagentCapabilityCeilings(params.capabilityCeiling ?? resolveCurrentSubagentCapabilityCeiling(ctx.currentSessionId), decodeSubagentCapabilityCeiling(process.env[SUBAGENT_CAPABILITY_CEILING_ENV]));
	try {
		assertAgentAllowedByCapabilityCeiling(agentConfig.name, capabilityCeiling);
	} catch (error) {
		return formatAsyncStartError("single", error instanceof Error ? error.message : String(error));
	}
	const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
	const instructionCwd = params.worktree === true
		? resolveExpectedWorktreeAgentCwd(runnerCwd, `${id}-s0`, 0, worktreeBaseDir)
		: runnerCwd;
	const readExistenceCwd = params.worktree === true ? runnerCwd : instructionCwd;
	const skillNames = params.skills ?? agentConfig.skills ?? [];
	const availableModels = params.availableModels;
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(
		skillNames,
		runnerCwd,
		ctx.cwd,
		agentConfig.skillPath,
		agentConfig.filePath ? path.dirname(agentConfig.filePath) : runnerCwd,
	);
	if (missingSkills.includes("pi-subagents")) return formatAsyncStartError("single", UNAVAILABLE_SUBAGENT_SKILL_ERROR);
	let systemPrompt = agentConfig.systemPrompt?.trim() ?? "";
	if (resolvedSkills.length > 0) {
		const injection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
	}
	const memoryInjection = buildAgentMemoryInjection(agentConfig, runnerCwd);
	if (memoryInjection) {
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${memoryInjection}` : memoryInjection;
	}
	systemPrompt = appendAgentRefinementOverlay(systemPrompt, { cwd: runnerCwd, agentName: agentConfig.name });

	const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
	const nestedAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
	const asyncDir = inheritedNestedRoute
		? path.join(TEMP_ROOT_DIR, "nested-subagent-runs", inheritedNestedRoute.rootRunId, id)
		: path.join(DIRS.async, id);
	let runFanoutBudget: RunFanoutBudgetDescriptor;
	try {
		runFanoutBudget = params.runFanoutBudget ?? createRunFanoutBudget(id, 64);
		fs.mkdirSync(asyncDir, { recursive: true });
		writeRunFanoutBudgetDescriptor(asyncDir, runFanoutBudget);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	const effectiveOutput = normalizeSingleOutputOverride(params.output, agentConfig.output);
	const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, instructionCwd, params.outputBaseDir ?? (artifactsDir ? path.join(artifactsDir, "outputs", id) : undefined));
	systemPrompt = injectOutputPathSystemPrompt(systemPrompt, outputPath, agentConfig);
	const outputMode = params.outputMode ?? agentConfig.outputMode ?? "inline";
	const validationError = validateFileOnlyOutputMode(outputMode, outputPath, `Async single run (${agent})`);
	if (validationError) return formatAsyncStartError("single", validationError);
	const taskWithOutputInstruction = injectSingleOutputInstruction(task, outputPath, agentConfig);
	// Reads: caller override > agent defaultReads > none. `~`/`~/` expand to home;
	// absolute paths pass through; relative paths resolve against the child cwd.
	const reads = params.reads !== undefined ? params.reads : agentConfig.defaultReads ?? false;
	const readPaths = Array.isArray(reads) ? resolveExistingReadPaths(reads, readExistenceCwd) : [];
	const readsInstruction = readPaths.length > 0
		? `[Read from: ${readPaths.join(", ")}]\n\n`
		: "";
	const taskText = readsInstruction + taskWithOutputInstruction;
	const modelScopes = resolveModelScopesForAgent(ctx.modelScope, agentConfig.name, ctx.currentModel);
	const primaryModel = externalRunner ? undefined : params.modelOverrideFromParent
		? params.modelOverride
		: resolveSubagentModelOverride(
			params.modelOverride ?? agentConfig.model,
			ctx.currentModel,
			availableModels,
			ctx.currentModelProvider,
			{ scope: modelScopes },
		);
	const effectiveThinking = externalRunner ? undefined : params.thinkingOverride ?? agentConfig.thinking;
	let model = externalRunner ? undefined : applyThinkingSuffix(primaryModel, effectiveThinking, params.thinkingOverride !== undefined);
	let workCandidate: string | undefined;
	// Task qualification (capabilities + required context) used to restrict the dynamic
	// fallback pool to models that can actually do the job. Set only when a profile exists.
	let qualification: { requiredCapabilities: string[]; minContext: number } | undefined;
	// MAIN behavior: an explicit model (per-profile, agent config, or top-level override)
	// is authoritative and skips feature selection. Computed up-front so it is also
	// available when building the fallback candidate list below.
	const explicitModel = params.modelOverride ?? (params.profiles?.[0]?.model) ?? agentConfig.model;
	if (params.profiles && params.profiles.length > 0) {
		const profile = params.profiles[0]!;
		const validated = validateTaskProfile(profile, new Set(params.profiles.map((p) => p.id)));
		if (validated.rejected) {
			return formatAsyncStartError("single", `Invalid task profile "${profile.id ?? "?"}: ${validated.issues.map((i) => i.message).join("; ")}`);
		}
		const selectable = (availableModels ?? []).map(toSelectableModel).filter((m): m is SelectableModel => m !== null);
		const advertised = new Set<string>();
		for (const m of selectable)
			for (const c of m.capabilities)
				advertised.add(c);
		const excluded = new Set(
			(availableModels ?? []).filter((m) => {
				const key = parseModelKey(m.fullId);
				return isExcluded(key.modelId, key.provider ?? m.provider);
			}).map((m) => m.fullId),
		);
		// Derive the task qualification so the dynamic fallback pool is restricted to
		// models that advertise the required capabilities and have enough context.
		const selectionInput = toSelectionInput(profile, advertised);
		qualification = { requiredCapabilities: selectionInput.capabilities, minContext: selectionInput.requiredContext };
		// In FEATURE mode, exclude the parent (orchestrator) from the selectable pool so it
		// is never chosen as the primary work candidate - it is only a last-resort fallback.
		// In MAIN mode (explicit model) the pool is untouched.
		const parentFullId = ctx.currentModel ? `${ctx.currentModel.provider}/${ctx.currentModel.id}` : undefined;
		const selectablePool = explicitModel || !parentFullId ? selectable : selectable.filter((m) => m.fullId !== parentFullId);
		if (!explicitModel) {
			// FEATURE behavior: no explicit model -> pick free + cheapest from the pool
			// (dynamic selection policy). This is skipped when a model is pinned, so the
			// static/declarative main behavior is preserved exactly.
			workCandidate = selectWorkCandidate(selectionInput, selectablePool, excluded);
			if (workCandidate) {
				model = applyThinkingSuffix(workCandidate, effectiveThinking, params.thinkingOverride !== undefined);
			}
		}
		// else: model stays as primaryModel (explicit or inherited parent) - main behavior.
	}
	const toolBudgetInput = params.toolBudget ?? agentConfig.toolBudget ?? params.configToolBudget;
	const resolvedToolBudget = validateToolBudgetConfig(toolBudgetInput, params.toolBudget ? "toolBudget" : agentConfig.toolBudget ? "agent.toolBudget" : "config.toolBudget");
	if (resolvedToolBudget.error) return formatAsyncStartError("single", resolvedToolBudget.error);
	const deadlineAt = params.absoluteDeadlineAt ?? (params.timeoutMs !== undefined ? Date.now() + params.timeoutMs : undefined);
	const timeoutMs = params.absoluteDeadlineAt !== undefined && deadlineAt !== undefined
		? deadlineAt - Date.now()
		: params.timeoutMs;
	if (timeoutMs !== undefined && timeoutMs <= 0) return formatAsyncStartError("single", "The source run's absolute deadline expired before recovery could launch.");
	const resolvedToolTimeout = resolveToolTimeoutMs({
		callValue: params.toolTimeoutMs,
		agentValue: agentConfig.defaultToolTimeoutMs,
		configValue: params.configToolTimeoutMs,
		envValue: params.toolTimeoutMsEnv ?? toolTimeoutFromEnv(),
	});
	if (resolvedToolTimeout.error) return formatAsyncStartError("single", resolvedToolTimeout.error);
	const toolTimeoutMs = resolvedToolTimeout.toolTimeoutMs;
	const initialTurnBudget = params.turnBudget ? initialTurnBudgetState(params.turnBudget) : undefined;
	const initialUsageBudget = usageBudgetState(params.usageBudget, undefined);
	const resolvedSessionDir = params.sessionDir ?? (sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined);
	const structuredOutput = params.structuredOutputSchema
		? createStructuredOutputRuntime(params.structuredOutputSchema, path.join(asyncDir, "structured-output"))
		: undefined;
	// Build the fallback candidate list: the resolved primary model leads (workCandidate when
	// FEATURE selection picked one), followed by the qualified dynamic pool, then
	// agent-configured fallbacks. The retry loop in subagent-runner.ts iterates this list
	// on 429/400/503 failures so the run can rotate through the pool.
	const primaryCandidate = workCandidate ?? primaryModel;
	const modelCandidates = externalRunner
		? []
		: filterFallbackCandidates(
			buildModelCandidates(primaryCandidate, agentConfig.fallbackModels, availableModels, ctx.currentModelProvider, {
				scope: modelScopes,
				primaryModelFromParent: params.modelOverrideFromParent,
				qualification,
			}),
		).flatMap((candidate) => {
			const resolved = applyThinkingSuffix(candidate, effectiveThinking, params.thinkingOverride !== undefined);
			return resolved ? [resolved] : [];
		});
	// In FEATURE mode (no explicit model pinned), include the inherited parent model as the
	// LAST-RESORT fallback candidate (appended at the end, after all qualified pool models).
	// The parent is the orchestrator (planning/decomposition); task work is delegated to
	// free/cheap QUALIFIED pool models, so the parent is only used when no qualified pool
	// model remains. Skipped entirely when a model is pinned (main behavior).
	if (!externalRunner && !explicitModel && ctx.currentModel) {
		const parentFullId = `${ctx.currentModel.provider}/${ctx.currentModel.id}`;
		const parentWithSuffix = applyThinkingSuffix(parentFullId, effectiveThinking, params.thinkingOverride !== undefined);
		if (parentWithSuffix && !modelCandidates.includes(parentWithSuffix)) {
			modelCandidates.push(parentWithSuffix);
		}
	}
	const effectiveSystemPrompt = appendTurnBudgetSystemPrompt(systemPrompt, params.turnBudget);
	const toolPlan = resolvePiLaunchToolPlan({
		tools: agentConfig.tools,
		extensions: agentConfig.extensions,
		subagentOnlyExtensions: agentConfig.subagentOnlyExtensions,
		mcpDirectTools: agentConfig.mcpDirectTools,
		cwd: runnerCwd,
		requireReadTool: Boolean(resolvedSkills.length),
		structuredOutput: Boolean(params.structuredOutputSchema),
		capabilityCeiling,
		inheritedCapabilityCeiling: decodeSubagentCapabilityCeiling(process.env[SUBAGENT_CAPABILITY_CEILING_ENV]),
		agentName: agentConfig.name,
		permissionRules: resolvePermissionRules(ctx.permissions, agentConfig.permissions),
	});
	const launchResolvedExtensions = externalRunner ? undefined : projectLaunchResolvedChildExtensions(toolPlan);
	if (!externalRunner) {
		const contractTools = toolPlan.explicitToolAllowlist ? toolPlan.effectiveToolAllowlist : undefined;
		const contractError = validateImplementationToolContract({
			agent: agentConfig.name,
			task: taskText,
			tools: contractTools,
			mcpDirectTools: toolPlan.effectiveMcpTools,
			configuredExtensions: toolPlan.configuredExtensions,
			requestedTools: toolPlan.requestedBuiltinTools,
			acceptanceRole: agentConfig.acceptanceRole,
			completionGuard: agentConfig.completionGuard,
		});
		if (contractError) return formatAsyncStartError("single", contractError);
	}
	const launchContractDigest = launchBindingDigest({
		definitionDigest: agentDefinitionDigest(agentConfig),
		task,
		...(model ? { model } : {}),
		modelCandidates,
		...(resolveEffectiveThinking(model, effectiveThinking) ? { thinking: resolveEffectiveThinking(model, effectiveThinking) } : {}),
		systemPrompt: effectiveSystemPrompt,
		systemPromptMode: agentConfig.systemPromptMode,
		inheritProjectContext: agentConfig.inheritProjectContext,
		inheritSkills: agentConfig.inheritSkills,
		skills: resolvedSkills.map((skill) => skill.name),
		tools: toolPlan.effectiveToolAllowlist,
		extensions: toolPlan.extensionArgs,
		mcpDirectTools: toolPlan.effectiveMcpTools,
		...(outputPath ? { outputPath } : {}),
		outputMode,
		...(params.structuredOutputSchema ? { structuredOutputSchema: params.structuredOutputSchema } : {}),
	});
	const resolvedAcceptance = resolveEffectiveAcceptance({
		explicit: params.acceptance,
		agentName: agent,
		acceptanceRole: agentConfig.acceptanceRole,
		task,
		mode: "single",
		async: true,
		agentContract: params.agentContract,
	});
	const recoveryAgentConfig = params.recoveryAgentConfig ?? agentConfig;
	const recoveryDescriptor: SteeringRecoveryDescriptor = {
		version: 1,
		launchContractDigest,
		runFanoutBudget,
		sourceRunId: id,
		...(params.agentContract ? { agentContract: params.agentContract } : {}),
		agent,
		launchResolvedExtensions,
		...(sessionFile ? { sessionFile } : {}),
		cwd: runnerCwd,
		...(model ? { model } : {}),
		...(params.modelOverrideFromParent ? { modelOverrideFromParent: true } : {}),
		...(recoveryAgentConfig.fallbackModels ? { fallbackModels: [...recoveryAgentConfig.fallbackModels] } : {}),
		...(effectiveThinking ? { thinking: resolveEffectiveThinking(model, effectiveThinking) } : {}),
		...(recoveryAgentConfig.tools ? { tools: [...recoveryAgentConfig.tools] } : {}),
		...(recoveryAgentConfig.extensions ? { extensions: [...recoveryAgentConfig.extensions] } : {}),
		...(recoveryAgentConfig.subagentOnlyExtensions ? { subagentOnlyExtensions: [...recoveryAgentConfig.subagentOnlyExtensions] } : {}),
		...(recoveryAgentConfig.mcpDirectTools ? { mcpDirectTools: [...recoveryAgentConfig.mcpDirectTools] } : {}),
		...(recoveryAgentConfig.systemPrompt ? { systemPrompt: recoveryAgentConfig.systemPrompt } : {}),
		systemPromptMode: recoveryAgentConfig.systemPromptMode,
		inheritProjectContext: recoveryAgentConfig.inheritProjectContext,
		inheritSkills: recoveryAgentConfig.inheritSkills,
		...(resolvedSkills.length ? { skills: resolvedSkills.map((skill) => skill.name) } : {}),
		...(recoveryAgentConfig.skillPath ? { skillPath: [...recoveryAgentConfig.skillPath] } : {}),
		...(recoveryAgentConfig.filePath ? { agentFilePath: recoveryAgentConfig.filePath } : {}),
		...(recoveryAgentConfig.completionGuard !== undefined ? { completionGuard: recoveryAgentConfig.completionGuard } : {}),
		...(recoveryAgentConfig.memory ? { memory: { ...recoveryAgentConfig.memory } } : {}),
		...(outputPath ? { outputPath } : {}),
		outputMode,
		...(params.structuredOutputSchema ? { structuredOutputSchema: params.structuredOutputSchema } : {}),
		...(params.acceptance !== undefined ? { acceptance: params.acceptance } : {}),
		...(controlConfig ? { controlConfig } : {}),
		...(params.context ? { context: params.context } : {}),
		...(params.intercomBridge !== undefined ? { intercomBridge: params.intercomBridge } : {}),
		...(deadlineAt !== undefined ? { absoluteDeadlineAt: deadlineAt } : {}),
		...(initialTurnBudget ? { initialTurnBudget: { maxTurns: initialTurnBudget.maxTurns, graceTurns: initialTurnBudget.graceTurns } } : {}),
		...(resolvedToolBudget.budget ? { initialToolBudget: resolvedToolBudget.budget } : {}),
		maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, recoveryAgentConfig.maxSubagentDepth),
		...(maxOutput ? { maxOutput } : {}),
		share: shareEnabled,
		...(resolvedSessionDir ? { sessionDir: resolvedSessionDir } : {}),
		...(artifactsDir ? { artifactsDir } : {}),
		artifactConfig,
		...(capabilityCeiling ? { capabilityCeiling } : {}),
	};
	if (!externalRunner) {
		try {
			writePrivateAtomicJson(path.join(asyncDir, "recovery-descriptor.json"), recoveryDescriptor);
		} catch (error) {
			return formatAsyncStartError("single", `Failed to persist async recovery descriptor for '${id}': ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	let spawnResult: SpawnRunnerResult = {};
	try {
		spawnResult = spawnRunner(
			{
				id,
				profiles: params.profiles,
				steps: [
					{
						parentSessionId: ctx.parentSessionId ?? ctx.currentSessionId,
						permissionRules,
						...(capabilityCeiling ? { capabilityCeiling } : {}),
						agent,
						task: taskText,
						...(agentConfig.runner ? { runner: agentConfig.runner } : {}),
						...(params.externalJobFollowUp ? { externalJobFollowUp: params.externalJobFollowUp } : {}),
						...(params.context ? { context: params.context } : {}),
						cwd: runnerCwd,
						model,
						thinking: resolveEffectiveThinking(model, effectiveThinking),
						modelCandidates,
						...(params.modelOverrideFromParent ? { skipPrimaryModelVerification: true } : {}),
						...(availableModels && availableModels.length > 0 ? { modelVerificationRegistry: availableModels } : {}),
						tools: agentConfig.tools,
						extensions: agentConfig.extensions,
						subagentOnlyExtensions: agentConfig.subagentOnlyExtensions,
						mcpDirectTools: agentConfig.mcpDirectTools,
						completionGuard: agentConfig.completionGuard,
						systemPrompt,
						systemPromptMode: agentConfig.systemPromptMode,
						inheritProjectContext: agentConfig.inheritProjectContext,
						inheritSkills: agentConfig.inheritSkills,
						skills: resolvedSkills.map((r) => r.name),
						outputPath,
						outputMode,
						...(!externalRunner && sessionFile ? { sessionFile } : {}),
						maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, agentConfig.maxSubagentDepth),
						waitToolEnabled: params.waitToolEnabled,
						...(params.agentContract ? { agentContract: params.agentContract } : {}),
						definitionDigest: agentDefinitionDigest(agentConfig),
						launchBindingTask: task,
						launchContractDigest,
						launchResolvedExtensions,
						effectiveAcceptance: resolvedAcceptance,
						...(structuredOutput ? { structuredOutput } : {}),
						...(params.structuredOutputSchema ? { structuredOutputSchema: params.structuredOutputSchema } : {}),
						...(resolvedToolBudget.budget ? { toolBudget: resolvedToolBudget.budget } : {}),
						...(params.worktree === true ? { worktree: true } : {}),
					},
				],
				resultPath: params.parentWorkflowRunId !== undefined && (params.revivalLease !== undefined || params.workflowAwaitAsync === true)
					? workflowAwaitedAsyncResultPath(asyncDir)
					: inheritedNestedRoute ? nestedResultsPath(inheritedNestedRoute.rootRunId, id) : resultFilePath(DIRS.results, id),
				cwd: runnerCwd,
				placeholder: "{previous}",
				maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				share: shareEnabled,
				sessionDir: resolvedSessionDir,
				asyncDir,
				sessionId: ctx.currentSessionId,
				completionOwnerId: ctx.completionOwnerId ?? currentCompletionOwnerId(),
				...(capabilityCeiling ? { capabilityCeiling } : {}),
				piPackageRoot,
				piArgv1: process.argv[1],
				worktreeSetupHook,
				worktreeSetupHookTimeoutMs,
				worktreeBaseDir,
				controlConfig,
				timeoutMs,
				deadlineAt,
				toolTimeoutMs,
				turnBudget: params.turnBudget,
				toolBudget: params.toolBudget,
				usageBudget: params.usageBudget,
				controlIntercomTarget,
				childIntercomTargets: childIntercomTarget ? [childIntercomTarget(agent, 0)] : undefined,
				resultMode: "single",
				launchContractDigest,
				launchResolvedExtensions,
				runFanoutBudget,
				...(params.parentWorkflowRunId ? { parentWorkflowRunId: params.parentWorkflowRunId } : {}),
				...(params.workflowKey ? { workflowKey: params.workflowKey } : {}),
				...(params.revivalLease ? { revivalLease: params.revivalLease } : {}),
				nestedRoute: nestedRoute ?? inheritedNestedRoute,
				nestedSelf: inheritedNestedRoute && nestedAddress ? {
					parentRunId: nestedAddress.parentRunId,
					parentStepIndex: nestedAddress.parentStepIndex,
					depth: nestedAddress.depth,
					path: nestedAddress.path,
				} : undefined,
			},
			id,
			runnerCwd,
			(proof) => ctx.pi.events.emit(SUBAGENT_PROCESS_TERMINAL_EVENT, proof),
		);
	} catch (error) {
		params.activeAsyncCapacity?.rollback();
		const message = error instanceof Error ? error.message : String(error);
		return formatAsyncStartError("single", `Failed to start async run '${id}': ${message}`);
	}

	if (spawnResult.error) {
		if (!spawnResult.pid || !spawnResult.runnerProcessInstanceId || (spawnResult.startupDidNotProceed && spawnResult.terminationObserved)) params.activeAsyncCapacity?.rollback();
		else params.activeAsyncCapacity?.markStarted(spawnResult.runnerProcessInstanceId);
		return formatAsyncStartError("single", `Failed to start async run '${id}': ${spawnResult.error}`);
	}
	if (!spawnResult.pid || !spawnResult.runnerProcessInstanceId) {
		params.activeAsyncCapacity?.rollback();
		return formatAsyncStartError("single", `Failed to start async run '${id}': runner identity unavailable`);
	}
	params.activeAsyncCapacity?.markStarted(spawnResult.runnerProcessInstanceId);

	if (spawnResult.pid) {
		if (inheritedNestedRoute && nestedAddress) {
			const now = Date.now();
			try {
				writeNestedEvent(inheritedNestedRoute, {
					type: "subagent.nested.started",
					ts: now,
					parentRunId: nestedAddress.parentRunId,
					parentStepIndex: nestedAddress.parentStepIndex,
					child: {
						id,
						parentRunId: nestedAddress.parentRunId,
						parentStepIndex: nestedAddress.parentStepIndex,
						depth: nestedAddress.depth,
						path: nestedAddress.path,
						asyncDir,
						pid: spawnResult.pid,
						ownerIntercomTarget: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
						leafIntercomTarget: childIntercomTarget?.(agent, 0),
						intercomTarget: childIntercomTarget?.(agent, 0),
						ownerState: "live",
						mode: "single",
						state: "running",
						agent,
						agents: [agent],
						chainStepCount: 1,
						...(timeoutMs !== undefined ? { timeoutMs, deadlineAt } : {}),
						...(initialTurnBudget ? { turnBudget: initialTurnBudget } : {}),
						startedAt: now,
						lastUpdate: now,
						...(capabilityCeiling ? { capabilityCeiling } : {}),
					},
				});
			} catch (error) {
				console.error("Failed to emit nested async start event:", error);
			}
		}
		ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			id,
			pid: spawnResult.pid,
			sessionId: ctx.currentSessionId,
			completionOwnerId: ctx.completionOwnerId ?? currentCompletionOwnerId(),
			mode: "single",
			agent,
			task: task?.trim() ? PROMPT_REDACTED : undefined,
			goal: (params.goal ?? task).trim() ? PROMPT_REDACTED : undefined,
			cwd: runnerCwd,
			asyncDir,
			...(sessionRoot ? { sessionRoot } : {}),
			launchContractDigest,
			launchResolvedExtensions,
			...(params.parentWorkflowRunId ? { parentWorkflowRunId: params.parentWorkflowRunId } : {}),
			...(params.workflowKey ? { workflowKey: params.workflowKey } : {}),
			...(timeoutMs !== undefined ? { timeoutMs, deadlineAt } : {}),
			...(initialTurnBudget ? { turnBudget: initialTurnBudget } : {}),
			...(initialUsageBudget ? { usageBudget: initialUsageBudget } : {}),
			...(capabilityCeiling ? { capabilityCeiling } : {}),
			nestedRoute,
		});
	}

	return {
		content: [{ type: "text", text: formatAsyncStartedMessage(`Async: ${agent} [${id}]`, ctx.interactive === true) }],
		details: { mode: "single", runId: id, results: [], asyncId: id, asyncDir, launchContractDigest, launchResolvedExtensions, ...(capabilityCeiling ? { capabilityCeiling } : {}), ...(params.context ? { context: params.context } : {}), ...(timeoutMs !== undefined ? { timeoutMs, deadlineAt } : {}), ...(params.turnBudget ? { turnBudget: params.turnBudget } : {}), ...(params.toolBudget ? { toolBudget: resolvedToolBudget.budget ?? params.toolBudget } : {}), ...(initialUsageBudget ? { usageBudget: initialUsageBudget } : {}) } as Details,
	};
}
