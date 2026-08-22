import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import {
	CONTEXT_CEILING,
	CONTEXT_FLOOR_BY_KIND,
	bumpToFloor,
	exceedsCeiling,
} from "../../src/runs/shared/task-context-floor.ts";
import {
	KIND_DEFAULTS,
	TaskProfileSchema,
	TaskProfileListSchema,
	isTaskKind,
} from "../../src/runs/shared/task-profile.ts";
import { TASK_KINDS } from "../../src/shared/types.ts";

const goodProfile = {
	id: "auth-1",
	kind: "code-write",
	task: "Implement the auth middleware in src/auth.ts. It must export verifyToken(token) returning the decoded payload or throwing on invalid token.",
	dependsOn: [],
	acceptanceCriteria: ["src/auth.ts exists and exports verifyToken", "verifyToken throws on a malformed token"],
};

describe("TaskKind taxonomy", () => {
	it("has exactly the five planned kinds", () => {
		assert.deepEqual([...TASK_KINDS], ["code-write", "code-read", "transform", "summarize", "search"]);
	});

	it("isTaskKind narrows correctly", () => {
		assert.equal(isTaskKind("code-write"), true);
		assert.equal(isTaskKind("reasoning"), false);
		assert.equal(isTaskKind(42), false);
		assert.equal(isTaskKind(undefined), false);
	});
});

describe("KIND_DEFAULTS", () => {
	it("provides defaults for every kind", () => {
		for (const kind of TASK_KINDS) {
			const d = KIND_DEFAULTS[kind];
			assert.ok(d, `missing defaults for ${kind}`);
			assert.equal(d.contextFloor, CONTEXT_FLOOR_BY_KIND[kind]);
			assert.ok(d.tokenBudget >= 1);
			assert.ok(d.toolBudget.hard >= 1);
			assert.ok(Array.isArray(d.capabilities) && d.capabilities.length >= 1);
		}
	});

	it("code-read demands more context floor than code-write", () => {
		assert.ok(CONTEXT_FLOOR_BY_KIND["code-read"] > CONTEXT_FLOOR_BY_KIND["code-write"]);
	});
});

describe("context floor helpers", () => {
	it("bumps an estimate below the floor up to the floor", () => {
		assert.equal(bumpToFloor(0, "code-write"), CONTEXT_FLOOR_BY_KIND["code-write"]);
		assert.equal(bumpToFloor(1_000, "code-write"), CONTEXT_FLOOR_BY_KIND["code-write"]);
	});

	it("leaves an estimate at or above the floor unchanged", () => {
		const floor = CONTEXT_FLOOR_BY_KIND["transform"];
		assert.equal(bumpToFloor(floor, "transform"), floor);
		assert.equal(bumpToFloor(floor + 5_000, "transform"), floor + 5_000);
	});

	it("flags estimates that exceed the ceiling", () => {
		assert.equal(exceedsCeiling(CONTEXT_CEILING + 1), true);
		assert.equal(exceedsCeiling(CONTEXT_CEILING), false);
		assert.equal(exceedsCeiling(1_000), false);
	});
});

describe("TaskProfileSchema", () => {
	it("accepts a well-formed profile", () => {
		assert.equal(Value.Check(TaskProfileSchema, goodProfile), true);
	});

	it("accepts optional fields", () => {
		const withOpts = {
			...goodProfile,
			needsReasoning: true,
			stakes: "high",
			toolBudget: { hard: 50, block: "*" },
			tokenBudget: 12_000,
			contextFloor: 4_000,
			capabilities: ["write"],
			estimatedInputTokens: 3_000,
		};
		assert.equal(Value.Check(TaskProfileSchema, withOpts), true);
	});

	it("rejects a missing required field (acceptanceCriteria)", () => {
		const bad = { ...goodProfile, acceptanceCriteria: [] };
		assert.equal(Value.Check(TaskProfileSchema, bad), false);
	});

	it("rejects an unknown kind", () => {
		const bad = { ...goodProfile, kind: "reasoning" };
		assert.equal(Value.Check(TaskProfileSchema, bad), false);
	});

	it("rejects unknown properties (additionalProperties: false)", () => {
		const bad = { ...goodProfile, surprise: true };
		assert.equal(Value.Check(TaskProfileSchema, bad), false);
	});

	it("rejects a negative estimate", () => {
		const bad = { ...goodProfile, estimatedInputTokens: -1 };
		assert.equal(Value.Check(TaskProfileSchema, bad), false);
	});

	it("validates a list schema", () => {
		assert.equal(Value.Check(TaskProfileListSchema, [goodProfile, { ...goodProfile, id: "auth-2", kind: "code-read" }]), true);
	});
});
