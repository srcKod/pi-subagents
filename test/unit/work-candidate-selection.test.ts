import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assignBatchWorkCandidates,
	hasCapabilities,
	selectWorkCandidate,
} from "../../src/runs/shared/work-candidate-selection.ts";
import { toSelectableModel, inferContextWindowFromName } from "../../src/runs/shared/model-capabilities.ts";
import type { ModelInfo } from "../../shared/model-info.ts";
import type { SelectableModel } from "../../shared/types.ts";

const FREE_SMALL = {
	fullId: "free/small",
	provider: "free",
	id: "small",
	isFree: true,
	// Sized to stay the smallest free fixture while still qualifying tasks at the
	// common 4K floor under the compaction-reserve contract (4_000 + 16_384 =
	// 20_384). A truly tight 8K fixture is now (by design) unusable for any task,
	// which is asserted separately by the gemma inference tests below.
	contextWindow: 24_000,
	capabilities: ["write"],
} satisfies SelectableModel;

const FREE_LARGE = {
	fullId: "free/large",
	provider: "free",
	id: "large",
	isFree: true,
	contextWindow: 128_000,
	capabilities: ["write", "reasoning"],
} satisfies SelectableModel;

const PAID_LARGE = {
	fullId: "openai/gpt-4",
	provider: "openai",
	id: "gpt-4",
	isFree: false,
	contextWindow: 128_000,
	capabilities: ["write", "reasoning"],
} satisfies SelectableModel;

const PAID_SMALL = {
	fullId: "openai/gpt-4o-mini",
	provider: "openai",
	id: "gpt-4o-mini",
	isFree: false,
	contextWindow: 128_000,
	capabilities: ["write"],
} satisfies SelectableModel;

const POOL: SelectableModel[] = [FREE_SMALL, FREE_LARGE, PAID_LARGE, PAID_SMALL];

describe("inferContextWindowFromName", () => {
	it("infers 8K for gemma-2b models", () => {
		assert.equal(
			inferContextWindowFromName(
				"my-cloudflare-ai-gateway/workers-ai/@cf/google/gemma-2b-it-lora",
				"workers-ai/@cf/google/gemma-2b-it-lora",
			),
			8_192,
		);
	});
	it("infers 4K for llama-2-7b models", () => {
		assert.equal(
			inferContextWindowFromName(
				"my-cloudflare-ai-gateway/workers-ai/@cf/meta-llama/llama-2-7b-chat-hf-lora",
				"workers-ai/@cf/meta-llama/llama-2-7b-chat-hf-lora",
			),
			4_096,
		);
	});
	it("infers 8K for mistral-7b models", () => {
		assert.equal(
			inferContextWindowFromName(
				"my-cloudflare-ai-gateway/workers-ai/@cf/mistral/mistral-7b-instruct-v0.2-lora",
				"workers-ai/@cf/mistral/mistral-7b-instruct-v0.2-lora",
			),
			8_192,
		);
	});
	it("infers 128K for sao10k/l3.1-70b-hanami-x1", () => {
		assert.equal(
			inferContextWindowFromName("infron-ai/sao10k/l3.1-70b-hanami-x1", "sao10k/l3.1-70b-hanami-x1"),
			131_072,
		);
	});
	it("returns undefined for unrecognised model names", () => {
		assert.equal(inferContextWindowFromName("somecompany/mystery-model", "mystery-model"), undefined);
	});
});

describe("toSelectableModel", () => {
	it("uses the real contextWindow when the registry reports it", () => {
		const info: ModelInfo = { provider: "p", id: "m", fullId: "p/m", contextWindow: 16_384, input: ["text"] };
		const sel = toSelectableModel(info);
		assert.ok(sel);
		assert.equal(sel!.contextWindow, 16_384);
	});
	it("infers contextWindow from name for well-known small models", () => {
		const info: ModelInfo = {
			provider: "my-cloudflare-ai-gateway",
			id: "workers-ai/@cf/google/gemma-2b-it-lora",
			fullId: "my-cloudflare-ai-gateway/workers-ai/@cf/google/gemma-2b-it-lora",
			input: ["text"],
		};
		const sel = toSelectableModel(info);
		assert.ok(sel);
		assert.equal(sel!.contextWindow, 8_192);
	});
	it("infers contextWindow from name for well-known large models", () => {
		const info: ModelInfo = {
			provider: "infron-ai",
			id: "sao10k/l3.1-70b-hanami-x1",
			fullId: "infron-ai/sao10k/l3.1-70b-hanami-x1",
			input: ["text"],
		};
		const sel = toSelectableModel(info);
		assert.ok(sel);
		assert.equal(sel!.contextWindow, 131_072);
	});
	it("defaults to 128K for truly unknown models", () => {
		const info: ModelInfo = { provider: "custom", id: "mystery-model", fullId: "custom/mystery-model", input: ["text"] };
		const sel = toSelectableModel(info);
		assert.ok(sel);
		assert.equal(sel!.contextWindow, 128_000);
	});
	it("returns null for non-chat models", () => {
		const info: ModelInfo = { provider: "p", id: "text-embedding-3-small", fullId: "p/text-embedding-3-small", input: ["text"] };
		const sel = toSelectableModel(info);
		assert.equal(sel, null);
	});
});

describe("hasCapabilities", () => {
	it("passes when no capabilities are required", () => {
		assert.equal(hasCapabilities(FREE_SMALL, []), true);
	});
	it("passes when the model has all required capabilities", () => {
		assert.equal(hasCapabilities(FREE_LARGE as SelectableModel, ["write", "reasoning"]), true);
	});
	it("fails when a required capability is missing", () => {
		assert.equal(hasCapabilities(FREE_SMALL, ["reasoning"]), false);
	});
});

describe("selectWorkCandidate", () => {
	it("prefers a free model over a paid one when both qualify", () => {
		const chosen = selectWorkCandidate({ id: "t", requiredContext: 4_000, capabilities: ["write"] }, POOL);
		assert.equal(chosen, "free/small");
	});

	it("falls back to paid when no free model qualifies", () => {
		const chosen = selectWorkCandidate({ id: "t", requiredContext: 4_000, capabilities: ["reasoning"] }, POOL, new Set(["free/large"]));
		// free/large is excluded and free/small lacks reasoning -> only paid qualifies
		assert.equal(chosen, "openai/gpt-4");
	});

	it("skips excluded models", () => {
		// Exclude both free models and one paid, leaving only openai/gpt-4o-mini.
		const chosen = selectWorkCandidate({ id: "t", requiredContext: 4_000, capabilities: ["write"] }, POOL, new Set(["free/small", "free/large", "openai/gpt-4"]));
		assert.equal(chosen, "openai/gpt-4o-mini");
	});

	it("returns undefined when no model has the required capability", () => {
		const chosen = selectWorkCandidate({ id: "t", requiredContext: 4_000, capabilities: ["search"] }, POOL);
		assert.equal(chosen, undefined);
	});

	it("returns undefined when no model has enough context", () => {
		const chosen = selectWorkCandidate({ id: "t", requiredContext: 200_000, capabilities: ["write"] }, POOL);
		assert.equal(chosen, undefined);
	});

	it("picks the smallest-context free model when several free qualify", () => {
		const chosen = selectWorkCandidate({ id: "t", requiredContext: 4_000, capabilities: ["write", "reasoning"] }, POOL);
		assert.equal(chosen, "free/large"); // free/small lacks reasoning; free/large is the free qualifier
	});
});

describe("assignBatchWorkCandidates", () => {
	it("assigns distinct models to a batch when enough qualify", () => {
		const tasks = [
			{ id: "a", requiredContext: 4_000, capabilities: ["write"] },
			{ id: "b", requiredContext: 4_000, capabilities: ["write"] },
			{ id: "c", requiredContext: 4_000, capabilities: ["write"] },
		];
		// Give 3 distinct free write models so diversity is possible.
		const pool: SelectableModel[] = [
			FREE_SMALL,
			{ ...FREE_SMALL, fullId: "free/small2", id: "small2" },
			{ ...FREE_SMALL, fullId: "free/small3", id: "small3" },
		];
		const { assignments } = assignBatchWorkCandidates(tasks, pool);
		assert.equal(assignments.get("a"), "free/small");
		assert.equal(assignments.get("b"), "free/small2");
		assert.equal(assignments.get("c"), "free/small3");
	});

	it("reuses models as a last resort when fewer qualify than tasks", () => {
		const tasks = [
			{ id: "a", requiredContext: 4_000, capabilities: ["write"] },
			{ id: "b", requiredContext: 4_000, capabilities: ["write"] },
			{ id: "c", requiredContext: 4_000, capabilities: ["write"] },
			{ id: "d", requiredContext: 4_000, capabilities: ["write"] },
			{ id: "e", requiredContext: 4_000, capabilities: ["write"] },
		];
		// Only 2 distinct free write models available.
		const pool: SelectableModel[] = [FREE_SMALL, { ...FREE_SMALL, fullId: "free/small2", id: "small2" }];
		const { assignments, reused } = assignBatchWorkCandidates(tasks, pool);
		assert.equal(assignments.size, 5);
		// 3 tasks had to reuse; 2 distinct models were used.
		const usedModels = new Set(assignments.values());
		assert.equal(usedModels.size, 2);
		assert.ok(reused.length >= 1);
	});

	it("respects per-task capability requirements", () => {
		const tasks = [
			{ id: "a", requiredContext: 4_000, capabilities: ["write"] },
			{ id: "b", requiredContext: 4_000, capabilities: ["reasoning"] },
		];
		const { assignments } = assignBatchWorkCandidates(tasks, POOL);
		assert.equal(assignments.get("a"), "free/small");
		assert.equal(assignments.get("b"), "free/large");
	});

	it("omits tasks with no qualifying model", () => {
		const tasks = [{ id: "a", requiredContext: 4_000, capabilities: ["search"] }];
		const { assignments } = assignBatchWorkCandidates(tasks, POOL);
		assert.equal(assignments.size, 0);
	});
});

describe("context window qualification with inference", () => {
	it("filters out small models (gemma-2b, 8K) for 16K-floor code-read tasks", () => {
		// Models WITHOUT registry-reported contextWindow — simulates the host
		// passing minimal { provider, id, reasoning } without contextWindow.
		const smallModel: ModelInfo = {
			provider: "my-cloudflare-ai-gateway",
			id: "workers-ai/@cf/google/gemma-2b-it-lora",
			fullId: "my-cloudflare-ai-gateway/workers-ai/@cf/google/gemma-2b-it-lora",
			reasoning: false,
			input: ["text"],
		};
		const bigModel: ModelInfo = {
			provider: "agnes-ai",
			id: "agnes-2.0-flash",
			fullId: "agnes-ai/agnes-2.0-flash",
			reasoning: false,
			input: ["text"],
		};
		const pool: SelectableModel[] = [smallModel, bigModel].map(toSelectableModel).filter((m): m is SelectableModel => m !== null);
		// 4 tasks at code-read floor (16K) — gemma-2b (8K inferred) should be excluded.
		const tasks = [
			{ id: "a", requiredContext: 16_000, capabilities: [] },
			{ id: "b", requiredContext: 16_000, capabilities: [] },
			{ id: "c", requiredContext: 16_000, capabilities: [] },
			{ id: "d", requiredContext: 16_000, capabilities: [] },
		];
		const { assignments, reused } = assignBatchWorkCandidates(tasks, pool);
		// Only agnes-2.0-flash (128K default) qualifies; gemma-2b is filtered out.
		const usedModels = new Set(assignments.values());
		assert.equal(usedModels.size, 1, `expected only agnes-2.0-flash, got: ${[...usedModels].join(", ")}`);
		assert.ok(usedModels.has("agnes-ai/agnes-2.0-flash"));
		// With 4 tasks and 1 model, reused should have 3 entries.
		assert.equal(reused.length, 3);
	});

	it("excludes tight-fit small models (gemma-2b, 8K) for code-write floor (8K) under the compaction reserve", () => {
		const smallModel: ModelInfo = {
			provider: "my-cloudflare-ai-gateway",
			id: "workers-ai/@cf/google/gemma-2b-it-lora",
			fullId: "my-cloudflare-ai-gateway/workers-ai/@cf/google/gemma-2b-it-lora",
			reasoning: false,
			input: ["text"],
		};
		const pool: SelectableModel[] = [smallModel].map(toSelectableModel).filter((m): m is SelectableModel => m !== null);
		// 8K floor — gemma-2b is 8,192. Old contract accepted it (8,192 >= 8,000),
		// but the compaction reserve requires 8,000 + 16,384 = 24,384, which an 8K
		// window cannot meet. A tight-fit model must now be excluded because pi
		// auto-compacts a child only after crossing window - reserve; with zero
		// headroom the child would overflow instead of compact.
		const chosen = selectWorkCandidate({ id: "t", requiredContext: 8_000, capabilities: [] }, pool);
		assert.equal(chosen, undefined);
	});

	it("filters small model for code-read floor (16K) when contextWindow is inferred", () => {
		const smallModel: ModelInfo = {
			provider: "my-cloudflare-ai-gateway",
			id: "workers-ai/@cf/google/gemma-2b-it-lora",
			fullId: "my-cloudflare-ai-gateway/workers-ai/@cf/google/gemma-2b-it-lora",
			reasoning: false,
			input: ["text"],
		};
		const pool: SelectableModel[] = [smallModel].map(toSelectableModel).filter((m): m is SelectableModel => m !== null);
		// 16K floor — gemma-2b (8K inferred) is filtered out on window alone
		// (8,192 < 16,000), and even more so under the compaction reserve
		// (16,000 + 16,384 = 32,384).
		const chosen = selectWorkCandidate({ id: "t", requiredContext: 16_000, capabilities: [] }, pool);
		assert.equal(chosen, undefined);
	});
});
