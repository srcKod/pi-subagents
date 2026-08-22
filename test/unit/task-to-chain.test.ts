import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskProfile } from "../../src/shared/types.ts";
import { taskProfilesToChain } from "../../src/runs/shared/task-to-chain.ts";

const profile = (id: string, kind: TaskProfile["kind"], task: string, dependsOn: string[] = []): TaskProfile => ({
	id,
	kind,
	task,
	dependsOn,
	acceptanceCriteria: ["output produced"],
});

describe("taskProfilesToChain", () => {
	it("converts a linear chain into sequential steps", () => {
		const profiles = [
			profile("t1", "code-write", "step 1"),
			profile("t2", "code-read", "step 2", ["t1"]),
			profile("t3", "summarize", "step 3", ["t2"]),
		];
		const steps = taskProfilesToChain(profiles);
		assert.equal(steps.length, 3);
		// Each batch has one task -> SequentialStep
		for (const step of steps) {
			assert.ok(!("parallel" in step), "expected SequentialStep");
			assert.ok("agent" in step && "task" in step);
		}
		assert.equal((steps[0] as any).task, "step 1");
		assert.equal((steps[1] as any).task, "step 2");
		assert.equal((steps[2] as any).task, "step 3");
	});

	it("converts independent tasks into a parallel group", () => {
		const profiles = [
			profile("t1", "code-write", "a"),
			profile("t2", "code-read", "b"),
			profile("t3", "transform", "c"),
		];
		const steps = taskProfilesToChain(profiles);
		assert.equal(steps.length, 1);
		const step = steps[0]!;
		assert.ok("parallel" in step && !("agent" in step), "expected ParallelStep");
		const par = step as { parallel: { agent: string; task: string }[] };
		assert.equal(par.parallel.length, 3);
		const tasks = par.parallel.map(p => p.task);
		assert.ok(tasks.includes("a") && tasks.includes("b") && tasks.includes("c"));
	});

	it("splits into separate groups when dependencies form a diamond", () => {
		// A and B are independent -> batch 1
		// C depends on A and B -> batch 2
		const profiles = [
			profile("A", "code-write", "setup"),
			profile("B", "code-read", "read"),
			profile("C", "summarize", "merge", ["A", "B"]),
		];
		const steps = taskProfilesToChain(profiles);
		assert.equal(steps.length, 2);
		// Batch 1: parallel group with A, B
		const s0 = steps[0]!;
		assert.ok("parallel" in s0);
		// Batch 2: single sequential step C
		const s1 = steps[1]!;
		assert.ok(!("parallel" in s1));
		assert.equal((s1 as any).task, "merge");
	});

	it("applies the custom agent mapping", () => {
		const profiles = [
			profile("t1", "code-write", "analysis"),
			profile("t2", "code-read", "review"),
		];
		const steps = taskProfilesToChain(profiles, { t1: "analyst", t2: "reviewer" });
		// Both independent -> single parallel group
		assert.ok("parallel" in steps[0]!);
		const par = steps[0] as { parallel: { agent: string; task: string }[] };
		const agentsByTask = new Map(par.parallel.map(p => [p.task, p.agent]));
		assert.equal(agentsByTask.get("analysis"), "analyst");
		assert.equal(agentsByTask.get("review"), "reviewer");
	});

	it("defaults to 'worker' when no mapping is provided", () => {
		const profiles = [profile("t1", "code-write", "do work")];
		const steps = taskProfilesToChain(profiles);
		assert.equal((steps[0] as any).agent, "worker");
	});

	it("rejects cyclic dependencies", () => {
		const profiles = [
			profile("a", "code-write", "x", ["b"]),
			profile("b", "code-read", "y", ["a"]),
		];
		assert.throws(() => taskProfilesToChain(profiles), /Cyclic|cycle/);
	});
});
