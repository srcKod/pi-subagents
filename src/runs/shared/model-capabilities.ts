/**
 * Shared model→SelectableModel mapping + capability predicates.
 *
 * Centralized here so both the work-candidate selection layer
 * (work-candidate-selection.ts) and the fallback-candidate builder
 * (model-fallback.ts) use ONE definition of "what capabilities does this model
 * advertise" and "does it qualify for a task". Keeping it single-sourced
 * prevents the fallback pool from diverging from the selected work candidate.
 */

import type { ModelInfo as AvailableModelInfo } from "../../shared/model-info.ts";
import type { SelectableModel } from "../../shared/types.ts";

/**
 * Known context windows for well-known model families that may appear without a
 * reported `contextWindow` in the host registry (e.g. gateway models like
 * Cloudflare Workers AI). These are real, documented window sizes — using them
 * prevents a small model (e.g. gemma-2b, 8K) from being wrongly assigned the
 * default 128K and selected for a 16K-floor task where it would overflow.
 *
 * Patterns are matched against the lower-cased `fullId + id`. Order matters:
 * more specific patterns must appear before more general ones.
 */
const KNOWN_CONTEXT_WINDOWS: Array<{ pattern: RegExp; contextWindow: number }> = [
	// Small parameter-count models with known small windows
	{ pattern: /gemma-2b/i, contextWindow: 8_192 },
	{ pattern: /phi-?2/i, contextWindow: 2_048 },
	{ pattern: /(?:^|[\/-])l(?:lama)?-?2.*7b/i, contextWindow: 4_096 },
	{ pattern: /(?:^|[\/-])l(?:lama)?-?2.*13b/i, contextWindow: 4_096 },
	{ pattern: /(?:^|[\/-])l(?:lama)?-?2.*70b/i, contextWindow: 4_096 },
	{ pattern: /mistral-7b/i, contextWindow: 8_192 },
	{ pattern: /mixtral.*8[_-]?x/i, contextWindow: 32_768 },
	{ pattern: /qwen1?\.5?[-. ]?7b/i, contextWindow: 8_192 },
	{ pattern: /qwen2?\.?5?[-. ]?14b/i, contextWindow: 131_072 },
	{ pattern: /qwen2?\.?5?[-. ]?7b/i, contextWindow: 8_192 },
	{ pattern: /deepseek-v?2[-. ]?16b/i, contextWindow: 16_384 },
	{ pattern: /granite[-. ]?(?:3b|8b|13b)/i, contextWindow: 4_096 },

	// Mid-range / large models — handle both 'llama-3.1' and shorthand 'l3.1' (sao10k style)
	{ pattern: /(?:^|[\/-])l(?:lama)?-?3\.?1.*70b/i, contextWindow: 131_072 },
	{ pattern: /(?:^|[\/-])l(?:lama)?-?3.*(?:70b|73b)/i, contextWindow: 32_768 },
	{ pattern: /(?:^|[\/-])l(?:lama)?-?3.*8b/i, contextWindow: 8_192 },

	// Parameter-count heuristics (last resort by size tier)
	{ pattern: /\b2b\b/i, contextWindow: 8_192 },
	{ pattern: /\b3b\b/i, contextWindow: 4_096 },
	{ pattern: /\b7b\b/i, contextWindow: 4_096 },
	{ pattern: /\b8b\b/i, contextWindow: 8_192 },
	{ pattern: /\b14b\b/i, contextWindow: 16_384 },
	{ pattern: /\b32b\b/i, contextWindow: 32_768 },
	{ pattern: /\b70b\b/i, contextWindow: 32_768 },
	{ pattern: /\b72b\b/i, contextWindow: 32_768 },
	{ pattern: /\b110b\b/i, contextWindow: 32_768 },
];

/** Default context window for models whose window is unknown and not inferable from name. */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Infer a model's context window from its id/name when the registry doesn't
 * report one. Returns `undefined` for models with no recognisable pattern,
 * in which case {@link DEFAULT_CONTEXT_WINDOW} is used.
 */
export function inferContextWindowFromName(fullId: string, id: string): number | undefined {
	const name = `${fullId} ${id}`.toLowerCase();
	for (const { pattern, contextWindow } of KNOWN_CONTEXT_WINDOWS) {
		if (pattern.test(name)) return contextWindow;
	}
	return undefined;
}

/**
 * Map a registry `ModelInfo` to the minimal `SelectableModel` shape used by
 * selection + fallback. Returns `null` for models that are clearly NOT
 * chat-capable (TTS, embedding, rerank, etc.) so they can never be selected or
 * used as fallbacks.
 *
 *  - `isFree`: true when both input/output cost are 0, else inferred from the
 *    id/fullId (name-based fallback for registries lacking price data).
 *  - `contextWindow`: the real window from the registry; when absent, inferred
 *    from the model name for well-known families (e.g. gemma-2b → 8K so it is
 *    correctly filtered for 16K-floor tasks), and finally defaulted to
 *    {@link DEFAULT_CONTEXT_WINDOW} (128K — the modern standard) so unknown
 *    models are not wrongly excluded.
 *  - `capabilities`: `reasoning` (from `ModelInfo.reasoning`) and `vision` (when
 *    the model's `input` modalities include `"image"`). Other task capabilities
 *    (e.g. "write"/"read") are not advertised by models, so they stay advisory.
 */
export function toSelectableModel(m: AvailableModelInfo): SelectableModel | null {
	const isFree =
		typeof m.cost?.input === "number" && typeof m.cost?.output === "number"
			? m.cost.input === 0 && m.cost.output === 0
			: /\bfree\b/i.test(m.fullId) || /\bfree\b/i.test(m.id);
	const contextWindow =
		(typeof m.contextWindow === "number" && m.contextWindow > 0
			? m.contextWindow
			: inferContextWindowFromName(m.fullId ?? "", m.id ?? "")) ?? DEFAULT_CONTEXT_WINDOW;

	// Infer capabilities from model info.
	const capabilities: string[] = [];
	if (m.reasoning) capabilities.push("reasoning");
	if (Array.isArray(m.input) && m.input.includes("image")) capabilities.push("vision");
	if (Array.isArray(m.input) && m.input.includes("text")) capabilities.push("text");

	// Exclude models that are clearly NOT chat-capable (TTS, embedding, rerank, etc.).
	// The registry exposes all upstream models from gateways with no type/capability
	// data, so we use name-based heuristics and the absence of any chat signal.
	const name = (m.fullId + " " + m.id).toLowerCase();
	const isKnownNonChat = /tts|embed|embedding|rerank|guard|clip|omni|robotics|lyria|computer[\._]?use|deep[\._]?research|nano[\._]?banana|lyria-3|speech|asr|transcription|ocr|moderation|vector|safety|classify|sentiment|image-gen|recap|summary/.test(name);
	if (isKnownNonChat) return null;

	// If the model has input modalities declared and "text" is absent, it's not chat-capable.
	if (Array.isArray(m.input) && m.input.length > 0 && !m.input.includes("text")) return null;

	return {
		fullId: m.fullId,
		provider: m.provider,
		id: m.id,
		isFree,
		contextWindow,
		capabilities,
	};
}

/** True when `model` advertises every capability in `required` (empty = unconstrained). */
export function hasCapabilities(model: SelectableModel, required: string[]): boolean {
	if (required.length === 0) return true;
	const have = new Set(model.capabilities);
	return required.every((c) => have.has(c));
}

/**
 * Compaction headroom reserved when qualifying a model for a task.
 *
 * pi auto-compacts a session once its context exceeds `contextWindow - reserve`
 * (default `reserveTokens` = 16K). If a model's window only just meets the task's
 * required context, there is zero room for that compaction to fire before the
 * request overflows — the child hits a 413 instead of compacting. Making the
 * reserve part of the qualification contract means a child always has room to
 * compact proactively rather than overflowing late. See model-capabilities.md.
 */
export const COMPACTION_RESERVE = 16_384;

/**
 * Check whether a `SelectableModel` (possibly null from `toSelectableModel`)
 * qualifies for a task's capability and context requirements.
 *
 * This is the single source of truth for the qualification predicate used by
 * the work-candidate selector, the async fallback-pool filter, and the dynamic
 * fallback-pool filter. Keeping it in one place prevents the three call sites
 * from diverging.
 */
export function modelQualifies(
	model: SelectableModel | null,
	requiredCapabilities: string[],
	requiredContext: number,
): boolean {
	return (
		model !== null &&
		hasCapabilities(model, requiredCapabilities) &&
		// Enforce the compaction headroom contract: the model's window must leave
		// at least COMPACTION_RESERVE of room above the task's required context so
		// the dispatched child can auto-compact proactively instead of overflowing.
		model.contextWindow >= requiredContext + COMPACTION_RESERVE
	);
}