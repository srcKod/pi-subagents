import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blockedDependentsOnFailure, dependentsOf, planBatches } from "../../src/runs/shared/task-planner.ts";
import type { TaskProfile } from "../../src/shared/types.ts";

function t(id: string, dependsOn: string[] = []): TaskProfile {
	return {
		id,
		kind: "code-write",
		task: `Task ${id}`,
		dependsOn,
		acceptanceCriteria: [`${id} done`],
	};
}

function batchIds(batches: TaskProfile[][]): string[][] {
	return batches.map((b) => b.map((p) => p.id).sort());
}

describe("planBatches", () => {
	it("puts independent tasks in a single batch", () => {
		const r = planBatches([t("a"), t("b"), t("c")]);
		assert.equal(r.ok, true);
		assert.equal(r.batches.length, 1);
		assert.deepEqual(batchIds(r.batches)[0], ["a", "b", "c"]);
	});

	it("splits a linear chain into one-batch-per-step (in order)", () => {
		const r = planBatches([t("a"), t("b", ["a"]), t("c", ["b"])]);
		assert.equal(r.ok, true);
		assert.equal(r.batches.length, 3);
		assert.deepEqual(batchIds(r.batches), [["a"], ["b"], ["c"]]);
	});

	it("batches a diamond (A -> {B,C} -> D) correctly", () => {
		const r = planBatches([t("a"), t("b", ["a"]), t("c", ["a"]), t("d", ["b", "c"])]);
		assert.equal(r.ok, true);
		assert.equal(r.batches.length, 3);
		assert.deepEqual(batchIds(r.batches)[0], ["a"]);
		assert.deepEqual(batchIds(r.batches)[1].sort(), ["b", "c"]);
		assert.deepEqual(batchIds(r.batches)[2], ["d"]);
	});

	it("a task depends only on a later-listed task (order independence)", () => {
		const r = planBatches([t("c", ["b"]), t("b", ["a"]), t("a")]);
		assert.equal(r.ok, true);
		assert.deepEqual(batchIds(r.batches), [["a"], ["b"], ["c"]]);
	});

	it("rejects a cycle with the cycle path", () => {
		const r = planBatches([t("a", ["b"]), t("b", ["a"])]); // A<->B
		assert.equal(r.ok, false);
		assert.ok(r.cycle);
		// cycle is reported as a path, e.g. ["a","b","a"] or ["b","a","b"]
		assert.equal(r.cycle!.length, 3);
		assert.equal(r.cycle![0], r.cycle![2]);
	});

	it("rejects a 3-node cycle", () => {
		const r = planBatches([t("a", ["c"]), t("b", ["a"]), t("c", ["b"])]);
		assert.equal(r.ok, false);
		assert.ok(r.cycle);
		assert.equal(r.cycle![0], r.cycle![r.cycle!.length - 1]);
	});

	it("ignores dependencies on unknown task ids (does not create cycles)", () => {
		// 'ghost' is not a known task; should be ignored, not cause a cycle.
		const r = planBatches([t("a", ["ghost"]), t("b")]);
		assert.equal(r.ok, true);
		assert.equal(r.batches.length, 1);
	});
});

describe("dependentsOf", () => {
	it("returns direct dependents", () => {
		const profiles = [t("a"), t("b", ["a"])];
		assert.deepEqual(dependentsOf("a", profiles), ["b"]);
	});

	it("returns transitive dependents in BFS order", () => {
		// A -> B -> C, plus A -> D
		const profiles = [t("a"), t("b", ["a"]), t("c", ["b"]), t("d", ["a"])];
		const deps = dependentsOf("a", profiles).sort();
		assert.deepEqual(deps, ["b", "c", "d"]);
	});

	it("returns empty when nothing depends on the failed task", () => {
		const profiles = [t("a"), t("b")];
		assert.deepEqual(dependentsOf("a", profiles), []);
	});
});

describe("blockedDependentsOnFailure", () => {
	it("is the runtime dependency-failure surface (alias of dependentsOf)", () => {
		// A -> B -> C, plus A -> D
		const profiles = [t("a"), t("b", ["a"]), t("c", ["b"]), t("d", ["a"])];
		assert.deepEqual(blockedDependentsOnFailure("a", profiles).sort(), ["b", "c", "d"]);
	});

	it("returns empty when nothing depends on the failed task", () => {
		const profiles = [t("a"), t("b")];
		assert.deepEqual(blockedDependentsOnFailure("a", profiles), []);
	});
});
