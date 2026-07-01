import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sumResultsCost } from "../../src/shared/utils.ts";
import type { SingleResult, Usage } from "../../src/shared/types.ts";

function resultWithUsage(usage: Usage): SingleResult {
	return {
		agent: "agent",
		task: "task",
		exitCode: 0,
		messages: [],
		usage,
	};
}

describe("sumResultsCost", () => {
	it("aggregates input tokens, output tokens, and cost", () => {
		const total = sumResultsCost([
			resultWithUsage({ input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.01, turns: 1 }),
			resultWithUsage({ input: 20, output: 7, cacheRead: 3, cacheWrite: 4, cost: 0.03, turns: 2 }),
		]);

		assert.deepEqual(total, { inputTokens: 30, outputTokens: 12, costUsd: 0.04 });
	});

	it("returns undefined when all aggregated fields are zero", () => {
		assert.equal(
			sumResultsCost([
				resultWithUsage({ input: 0, output: 0, cacheRead: 10, cacheWrite: 5, cost: 0, turns: 2 }),
			]),
			undefined,
		);
	});
});
