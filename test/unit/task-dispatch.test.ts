import assert from "node:assert/strict";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildAsyncRunnerSteps } from "../../src/runs/background/async-execution.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import type { ModelInfo } from "../../src/shared/model-info.ts";
import type { TaskProfile } from "../../src/shared/types.ts";
import { flattenSteps, type ParallelStepGroup, type RunnerSubagentStep } from "../../src/runs/shared/parallel-utils.ts";
import { clearExclusions, recordModelFailure } from "../../src/runs/shared/model-exclusions.ts";

const agent = (name: string): AgentConfig => ({
	name,
	description: `${name} agent`,
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	systemPrompt: "You are a test agent.",
	source: "project",
	filePath: `${name}.md`,
});

const ctx = {
	cwd: process.cwd(),
	currentSessionId: "session-1",
	currentModel: undefined,
	currentModelProvider: undefined,
	modelScope: undefined,
};

// Three models: two free (one reasoning-capable), one paid.
const availableModels: ModelInfo[] = [
	{ provider: "free", id: "flash", fullId: "free/flash", reasoning: false },
	{ provider: "free", id: "reason", fullId: "free/reason", reasoning: true },
	{ provider: "openai", id: "gpt-4", fullId: "openai/gpt-4", reasoning: true },
];

const profile = (id: string, kind: TaskProfile["kind"], task: string, acceptanceCriteria: string[] = ["output produced"]): TaskProfile => ({
	id,
	kind,
	task,
	dependsOn: [],
	acceptanceCriteria,
});

const asyncDir = path.join(process.cwd(), ".tmp-async-test");

beforeEach(() => clearExclusions());
afterEach(() => clearExclusions());

describe("task-management dispatch — work candidate selection", () => {
	it("selects a free work candidate for each step in a chain", () => {
		const result = buildAsyncRunnerSteps("run-chain", {
			chain: [
				{ agent: "worker", task: "read it" },
				{ agent: "worker", task: "write it" },
			],
			agents: [agent("worker")],
			ctx,
			availableModels,
			asyncDir,
			maxSubagentDepth: 2,
			profiles: [profile("t1", "code-read", "read it"), profile("t2", "code-write", "write it")],
		});

		assert.ok("steps" in result, "expected successful step build");
		const s0 = result.steps[0] as RunnerSubagentStep;
		const s1 = result.steps[1] as RunnerSubagentStep;
		assert.ok(s0.model?.startsWith("free/"), `expected free work candidate, got ${s0.model}`);
		assert.ok(s1.model?.startsWith("free/"), `expected free work candidate, got ${s1.model}`);
		// FEATURE builds a fallback list (not a single collapsed candidate): the selected
		// work candidate leads, followed by the rest of the qualified pool ordered free +
		// cheapest first. The parent (orchestrator) is appended last only when one is
		// configured; here ctx.currentModel is undefined so no parent is added.
		assert.equal(s0.modelCandidates?.[0], s0.model, "selected work candidate must lead the fallback list");
		assert.ok(s0.modelCandidates!.length >= 2, "fallback list carries the qualified pool");
		assert.equal(s1.modelCandidates?.[0], s1.model, "selected work candidate must lead the fallback list (step 2)");
		assert.ok(s1.modelCandidates!.length >= 2, "fallback list carries the qualified pool (step 2)");
	});

	it("assigns distinct free models across a parallel batch (batch-diversity)", () => {
		const result = buildAsyncRunnerSteps("run-par", {
			chain: [{ parallel: [{ agent: "worker", task: "a" }, { agent: "worker", task: "b" }] }],
			agents: [agent("worker")],
			ctx,
			availableModels,
			asyncDir,
			maxSubagentDepth: 2,
			profiles: [profile("t1", "code-read", "a"), profile("t2", "code-write", "b")],
		});

		assert.ok("steps" in result, "expected successful step build");
		const group = result.steps[0] as ParallelStepGroup;
		const m0 = group.parallel[0]!.model;
		const m1 = group.parallel[1]!.model;
		assert.ok(m0?.startsWith("free/") && m1?.startsWith("free/"), "both should be free work candidates");
		assert.notEqual(m0, m1, "batch-diversity should pick distinct models");
	});

	it("falls back to the legacy path when no profiles are given", () => {
		const result = buildAsyncRunnerSteps("run-legacy", {
			chain: [{ agent: "worker", task: "plain" }],
			agents: [agent("worker")],
			ctx,
			availableModels,
			asyncDir,
			maxSubagentDepth: 2,
		});

		assert.ok("steps" in result);
		const s0 = result.steps[0] as RunnerSubagentStep;
		// No profile → model left to the caller; candidates built from the fallback list.
		assert.ok(Array.isArray(s0.modelCandidates), "modelCandidates should still be built");
	});
});

describe("task-management dispatch — exclusions at the call site", () => {
	it("filters an excluded model out of the candidate list", () => {
		const params = {
			chain: [{ agent: "worker", task: "t", model: "free/flash" }] as { agent: string; task: string; model: string }[],
			agents: [{ ...agent("worker"), fallbackModels: ["openai/gpt-4"] }],
			ctx,
			availableModels,
			asyncDir,
			maxSubagentDepth: 2,
		};

		const before = buildAsyncRunnerSteps("run-excl-before", params);
		assert.ok("steps" in before);
		const candidatesBefore = (before.steps[0] as RunnerSubagentStep).modelCandidates ?? [];
		assert.ok(candidatesBefore.includes("free/flash"), "free/flash should be a candidate before exclusion");

		recordModelFailure({ modelId: "flash", provider: "free", reason: "429" });

		const after = buildAsyncRunnerSteps("run-excl-after", params);
		assert.ok("steps" in after);
		const candidatesAfter = (after.steps[0] as RunnerSubagentStep).modelCandidates ?? [];
		assert.ok(!candidatesAfter.includes("free/flash"), `excluded model should be filtered, got ${JSON.stringify(candidatesAfter)}`);
		assert.ok(candidatesAfter.includes("openai/gpt-4"), "unexcluded fallback should remain");
	});
});

describe("task-management dispatch — profile validation", () => {
	it("rejects the build when a profile fails validation", () => {
		const result = buildAsyncRunnerSteps("run-bad", {
			chain: [{ agent: "worker", task: "t" }],
			agents: [agent("worker")],
			ctx,
			availableModels,
			asyncDir,
			maxSubagentDepth: 2,
			// Empty task → rejected by validator 1.
			profiles: [{ id: "bad", kind: "code-write", task: "" }],
		});

		assert.ok(!("steps" in result), "expected an error result for an invalid profile");
		assert.match((result as { error: string }).error, /Invalid task profile/);
	});

	it("rejects the build when profile count does not match step count", () => {
		const result = buildAsyncRunnerSteps("run-mismatch", {
			chain: [{ agent: "worker", task: "t" }],
			agents: [agent("worker")],
			ctx,
			availableModels,
			asyncDir,
			maxSubagentDepth: 2,
			profiles: [profile("t1", "code-read", "a"), profile("t2", "code-read", "b")],
		});

		assert.ok(!("steps" in result), "expected an error result for profile/step mismatch");
		assert.match((result as { error: string }).error, /profiles length/);
	});
});

describe("task-management dispatch — real model metadata (Gap 2)", () => {
	// Rich mocks carrying the real pricing/context/modality data the host
	// registry exposes (toModelInfo used to discard it).
	const richModels: ModelInfo[] = [
		{ provider: "openai", id: "gpt-4", fullId: "openai/gpt-4", reasoning: true, cost: { input: 0, output: 0 }, contextWindow: 200_000, input: ["text"] },
		{ provider: "anthropic", id: "opus", fullId: "anthropic/opus", reasoning: true, cost: { input: 5, output: 15 }, contextWindow: 200_000, input: ["text"] },
	];

	it("treats cost.input===0 as free even without a :free id", () => {
		const result = buildAsyncRunnerSteps("run-costfree", {
			chain: [{ agent: "worker", task: "t" }],
			agents: [agent("worker")],
			ctx,
			availableModels: richModels,
			asyncDir,
			maxSubagentDepth: 2,
			profiles: [profile("t1", "code-read", "t")],
		});
		assert.ok("steps" in result, "expected successful step build");
		const s0 = result.steps[0] as RunnerSubagentStep;
		assert.equal(s0.model, "openai/gpt-4", `expected free (cost 0) work candidate, got ${s0.model}`);
	});

	it("respects the real contextWindow for qualification", () => {
		const models: ModelInfo[] = [
			{ provider: "small", id: "tiny", fullId: "small/tiny", reasoning: false, cost: { input: 0, output: 0 }, contextWindow: 32_000, input: ["text"] },
			{ provider: "big", id: "huge", fullId: "big/huge", reasoning: false, cost: { input: 0, output: 0 }, contextWindow: 200_000, input: ["text"] },
		];
		const result = buildAsyncRunnerSteps("run-ctx", {
			chain: [{ agent: "worker", task: "t" }],
			agents: [agent("worker")],
			ctx,
			availableModels: models,
			asyncDir,
			maxSubagentDepth: 2,
			// 40k estimate is under the 50k ceiling but exceeds the 32k model's real window.
			profiles: [{ id: "t1", kind: "code-read", task: "t", dependsOn: [], acceptanceCriteria: ["x"], estimatedInputTokens: 40_000 }],
		});
		assert.ok("steps" in result, "expected successful step build");
		const s0 = result.steps[0] as RunnerSubagentStep;
		assert.equal(s0.model, "big/huge", `expected model with sufficient context window, got ${s0.model}`);
	});

	it("matches a vision capability to models whose input includes image", () => {
		const models: ModelInfo[] = [
			{ provider: "noimg", id: "plain", fullId: "noimg/plain", reasoning: false, cost: { input: 0, output: 0 }, contextWindow: 200_000, input: ["text"] },
			{ provider: "img", id: "vision", fullId: "img/vision", reasoning: false, cost: { input: 0, output: 0 }, contextWindow: 200_000, input: ["image", "text"] },
		];
		const result = buildAsyncRunnerSteps("run-vision", {
			chain: [{ agent: "worker", task: "t" }],
			agents: [agent("worker")],
			ctx,
			availableModels: models,
			asyncDir,
			maxSubagentDepth: 2,
			profiles: [{ id: "t1", kind: "code-read", task: "t", dependsOn: [], acceptanceCriteria: ["x"], capabilities: ["vision"] }],
		});
		assert.ok("steps" in result, "expected successful step build");
		const s0 = result.steps[0] as RunnerSubagentStep;
		assert.equal(s0.model, "img/vision", `expected vision-capable model, got ${s0.model}`);
	});
});

describe("task-management dispatch — graph planning (Gap 1)", () => {
	it("rejects a cyclic dependsOn graph before dispatch", () => {
		const result = buildAsyncRunnerSteps("run-cycle", {
			chain: [{ agent: "worker", task: "a" }, { agent: "worker", task: "b" }],
			agents: [agent("worker")],
			ctx,
			availableModels,
			asyncDir,
			maxSubagentDepth: 2,
			// Mutual dependency: a cycle the per-profile validators cannot catch.
			profiles: [
				{ id: "t1", kind: "code-read", task: "a", dependsOn: ["t2"], acceptanceCriteria: ["x"] },
				{ id: "t2", kind: "code-read", task: "b", dependsOn: ["t1"], acceptanceCriteria: ["y"] },
			],
		});

		assert.ok(!("steps" in result), "expected an error result for a cyclic graph");
		assert.match((result as { error: string }).error, /cyclic dependency/);
	});
});

describe("task-management dispatch — capability enforcement (Gap 4)", () => {
	it("requires reasoning when needsReasoning is set, even if capabilities omits it", () => {
		const result = buildAsyncRunnerSteps("run-reason", {
			chain: [{ agent: "worker", task: "think" }],
			agents: [agent("worker")],
			ctx,
			availableModels,
			asyncDir,
			maxSubagentDepth: 2,
			// needsReasoning true but capabilities does NOT include "reasoning".
			profiles: [
				{ id: "t1", kind: "code-read", task: "think hard", dependsOn: [], acceptanceCriteria: ["done"], needsReasoning: true, capabilities: ["write"] },
			],
		});

		assert.ok("steps" in result, "expected successful step build");
		const s0 = result.steps[0] as RunnerSubagentStep;
		// Must pick a reasoning-capable model (free/reason), never the non-reasoning free/flash.
		assert.equal(s0.model, "free/reason", `expected reasoning work candidate, got ${s0.model}`);
	});

	it("treats non-advertised capabilities (e.g. write) as advisory, not exclusion filters", () => {
		const result = buildAsyncRunnerSteps("run-advisory", {
			chain: [{ agent: "worker", task: "io" }],
			agents: [agent("worker")],
			ctx,
			availableModels,
			asyncDir,
			maxSubagentDepth: 2,
			// code-write kind default requires "write", which no model advertises today.
			profiles: [profile("t1", "code-write", "write it")],
		});

		assert.ok("steps" in result, "expected successful step build");
		const s0 = result.steps[0] as RunnerSubagentStep;
		// Selection must NOT be disabled by an unmatchable capability requirement.
		assert.ok(s0.model?.startsWith("free/"), `expected a free work candidate, got ${s0.model}`);
	});
});

describe("task-management dispatch — runtime failure surface (Gap 1)", () => {
	it("annotates each leaf step with its profile id so the runner can surface blocked dependents", () => {
		const result = buildAsyncRunnerSteps("run-annotate", {
			chain: [{ agent: "worker", task: "a" }, { agent: "worker", task: "b" }],
			agents: [agent("worker")],
			ctx,
			availableModels,
			asyncDir,
			maxSubagentDepth: 2,
			profiles: [
				{ id: "t1", kind: "code-read", task: "a", dependsOn: [], acceptanceCriteria: ["x"] },
				{ id: "t2", kind: "code-read", task: "b", dependsOn: ["t1"], acceptanceCriteria: ["y"] },
			],
		});

		assert.ok("steps" in result, "expected successful step build");
		const leaves = flattenSteps((result as { steps: RunnerSubagentStep[] }).steps);
		assert.equal(leaves.length, 2, "expected two dispatched leaf steps");
		assert.deepEqual(leaves.map((s) => s.profileId).sort(), ["t1", "t2"], "every leaf must carry its profile id");
	});

	it("annotates each parallel-group leaf with its profile id (the runner reads group.parallel[i].profileId)", () => {
		// Regression guard: an earlier fix wired the dead dynamic-fanout path instead
		// of this live static-parallel path. The runner's mapConcurrent(group.parallel)
		// callback reads task.profileId directly off these mutated leaves.
		const result = buildAsyncRunnerSteps("run-annotate-par", {
			chain: [{ parallel: [{ agent: "worker", task: "a" }, { agent: "worker", task: "b" }] }],
			agents: [agent("worker")],
			ctx,
			availableModels,
			asyncDir,
			maxSubagentDepth: 2,
			profiles: [
				{ id: "t1", kind: "code-read", task: "a", dependsOn: [], acceptanceCriteria: ["x"] },
				{ id: "t2", kind: "code-read", task: "b", dependsOn: [], acceptanceCriteria: ["y"] },
			],
		});

		assert.ok("steps" in result, "expected successful step build");
		const group = (result as { steps: RunnerSubagentStep[] }).steps[0] as ParallelStepGroup;
		assert.ok(group && "parallel" in group, "expected a parallel step group");
		assert.equal(group.parallel.length, 2);
		assert.equal(group.parallel[0]!.profileId, "t1", "parallel leaf 0 must carry its profile id");
		assert.equal(group.parallel[1]!.profileId, "t2", "parallel leaf 1 must carry its profile id");
	});
});
