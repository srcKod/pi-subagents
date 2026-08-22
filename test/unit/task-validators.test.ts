import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyFloor,
	checkCeiling,
	checkEmpty,
	checkKindConsistency,
	checkStandalone,
	checkUndeclaredDep,
	checkVagueCriteria,
	validateTaskGraph,
	validateTaskProfile,
} from "../../src/runs/shared/task-validators.ts";
import type { TaskProfile } from "../../src/shared/types.ts";

function makeProfile(overrides: Partial<TaskProfile> = {}): TaskProfile {
	return {
		id: "t1",
		kind: "code-write",
		task: "Implement the auth middleware in src/auth.ts. It must export verifyToken(token) returning the decoded payload or throwing on invalid token.",
		dependsOn: [],
		acceptanceCriteria: ["src/auth.ts exports verifyToken", "verifyToken throws on malformed token"],
		...overrides,
	};
}

describe("checkEmpty (validator 1)", () => {
	it("accepts a populated profile", () => {
		assert.equal(checkEmpty(makeProfile()), null);
	});
	it("rejects an empty task", () => {
		assert.equal(checkEmpty(makeProfile({ task: "   " }))?.severity, "reject");
	});
	it("rejects missing acceptance criteria", () => {
		assert.equal(checkEmpty(makeProfile({ acceptanceCriteria: [] }))?.severity, "reject");
	});
	it("rejects a blank criterion", () => {
		assert.equal(checkEmpty(makeProfile({ acceptanceCriteria: [""] }))?.severity, "reject");
	});
});

describe("applyFloor (validator 2)", () => {
	it("fills a missing estimate silently (no correction flag)", () => {
		const r = applyFloor(makeProfile());
		assert.equal(r.corrected, false);
		assert.equal(r.hadEstimate, false);
		assert.ok(r.profile.estimatedInputTokens! >= 1);
	});
	it("bumps a too-low provided estimate", () => {
		const r = applyFloor(makeProfile({ estimatedInputTokens: 1 }));
		assert.equal(r.corrected, true);
		assert.ok(r.profile.estimatedInputTokens! > 1);
	});
	it("leaves an adequate estimate unchanged", () => {
		const r = applyFloor(makeProfile({ estimatedInputTokens: 50_000 }));
		assert.equal(r.corrected, false);
	});
});

describe("checkStandalone (validator 3 — post-mortem failure mode)", () => {
	it("accepts a self-contained task", () => {
		assert.equal(checkStandalone(makeProfile()), null);
	});
	it("rejects 'the above'", () => {
		assert.equal(checkStandalone(makeProfile({ task: "Apply the change to the above module." }))?.severity, "reject");
	});
	it("rejects 'its output'", () => {
		assert.equal(checkStandalone(makeProfile({ task: "Wire up the handler using its output." }))?.severity, "reject");
	});
	it("rejects 'as mentioned'", () => {
		assert.equal(checkStandalone(makeProfile({ task: "Fix the bug as mentioned earlier." }))?.severity, "reject");
	});
});

describe("checkUndeclaredDep (validator 4)", () => {
	it("accepts an explicit dependency declaration", () => {
		const p = makeProfile({ task: "Use the schema from read-schema and apply it.", dependsOn: ["read-schema"] });
		assert.equal(checkUndeclaredDep(p, new Set(["read-schema", "t1"])), null);
	});
	it("rejects a referenced id not in dependsOn", () => {
		const p = makeProfile({ task: "Use the schema from read-schema and apply it.", dependsOn: [] });
		const issue = checkUndeclaredDep(p, new Set(["read-schema", "t1"]));
		assert.equal(issue?.severity, "reject");
		assert.match(issue!.message, /read-schema/);
	});
	it("ignores references to ids that are not known tasks", () => {
		// 'src/auth.ts' is not a task id; no false positive.
		const p = makeProfile({ task: "Edit src/auth.ts to add verifyToken." });
		assert.equal(checkUndeclaredDep(p, new Set(["t1"])), null);
	});
});

describe("checkCeiling (validator 5)", () => {
	it("accepts an estimate under the ceiling", () => {
		assert.equal(checkCeiling(makeProfile({ estimatedInputTokens: 10_000 })), null);
	});
	it("rejects an estimate over the ceiling", () => {
		assert.equal(checkCeiling(makeProfile({ estimatedInputTokens: 60_000 }))?.severity, "reject");
	});
});

describe("checkVagueCriteria (validator 6 — warn only)", () => {
	it("accepts a concrete criterion", () => {
		assert.equal(checkVagueCriteria(makeProfile()), null);
	});
	it("warns on 'works correctly'", () => {
		assert.equal(checkVagueCriteria(makeProfile({ acceptanceCriteria: ["the feature works correctly"] }))?.severity, "warn");
	});
});

describe("checkKindConsistency (validator 7 — override + warn)", () => {
	it("accepts a consistent declaration", () => {
		const r = checkKindConsistency(makeProfile({ kind: "code-write", task: "Implement the handler." }));
		assert.equal(r.issue, null);
		assert.equal(r.corrected.kind, "code-write");
	});
	it("overrides declared 'summarize' when text says 'implement'", () => {
		const r = checkKindConsistency(makeProfile({ kind: "summarize", task: "Implement the new endpoint and add tests." }));
		assert.equal(r.issue?.severity, "warn");
		assert.equal(r.corrected.kind, "code-write");
	});
	it("does not override when the declared kind also has a signal", () => {
		// declared summarize, but text says "summarize the read output" — has its own signal.
		const r = checkKindConsistency(makeProfile({ kind: "summarize", task: "Read the log and summarize it." }));
		assert.equal(r.issue, null);
		assert.equal(r.corrected.kind, "summarize");
	});
});

describe("validateTaskProfile", () => {
	it("passes a well-formed profile", () => {
		const r = validateTaskProfile(makeProfile());
		assert.equal(r.ok, true);
		assert.equal(r.rejected, false);
	});
	it("reports a rejected profile with the specific reason", () => {
		const r = validateTaskProfile(makeProfile({ task: "Apply the change to the above module." }));
		assert.equal(r.ok, false);
		assert.equal(r.rejected, true);
		assert.ok(r.issues.some((i) => i.validator === 3));
	});
	it("collects multiple reject reasons at once", () => {
		// Not standalone AND references an undeclared task id.
		const p = makeProfile({ task: "Apply the above using read-schema output.", dependsOn: [] });
		const r = validateTaskProfile(p, new Set(["read-schema", "t1"]));
		assert.equal(r.rejected, true);
		assert.ok(r.issues.some((i) => i.validator === 3));
		assert.ok(r.issues.some((i) => i.validator === 4));
	});
	it("applies the floor bump and surfaces it as a warn", () => {
		const r = validateTaskProfile(makeProfile({ estimatedInputTokens: 1 }));
		assert.equal(r.ok, true);
		assert.ok(r.profile.estimatedInputTokens! > 1);
		assert.ok(r.issues.some((i) => i.validator === 2 && i.severity === "warn"));
	});
	it("does not reject on a warn-only issue (vague criteria)", () => {
		const r = validateTaskProfile(makeProfile({ acceptanceCriteria: ["it works correctly"] }));
		assert.equal(r.ok, true);
		assert.ok(r.issues.some((i) => i.validator === 6 && i.severity === "warn"));
	});
});

describe("validateTaskGraph", () => {
	it("validates every task and keys results by id", () => {
		const graph: TaskProfile[] = [
			makeProfile({ id: "a", task: "Implement feature A." }),
			makeProfile({ id: "b", task: "Implement feature B using a output.", dependsOn: [] }),
		];
		const results = validateTaskGraph(graph);
		assert.equal(results.size, 2);
		assert.equal(results.get("a")!.ok, true);
		// 'b' references 'a' but doesn't declare it.
		assert.equal(results.get("b")!.rejected, true);
	});
});
