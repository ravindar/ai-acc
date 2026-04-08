export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface ModelInfo extends ModelPricing {
  contextWindow: number;
}

export interface ModelCapabilities {
  /** Max input context in tokens. */
  contextWindow: number;
  /** Max output tokens per request. */
  maxOutputTokens: number;
  /** Whether the model supports prompt caching (Anthropic cache_control). */
  supportsCache: boolean;
  /** Whether the model supports structured tool / function calling. */
  supportsTools: boolean;
  /** Whether the model accepts image inputs. */
  supportsVision: boolean;
}

const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  // Claude 4.x
  "claude-opus-4-6":           { contextWindow: 200_000, maxOutputTokens: 32_000, supportsCache: true, supportsTools: true, supportsVision: true },
  "claude-sonnet-4-6":         { contextWindow: 200_000, maxOutputTokens: 16_000, supportsCache: true, supportsTools: true, supportsVision: true },
  "claude-haiku-4-5-20251001": { contextWindow: 200_000, maxOutputTokens: 8_000,  supportsCache: true, supportsTools: true, supportsVision: true },
  "claude-haiku-4-5":          { contextWindow: 200_000, maxOutputTokens: 8_000,  supportsCache: true, supportsTools: true, supportsVision: true },
  // Claude 3.x
  "claude-opus-4":             { contextWindow: 200_000, maxOutputTokens: 32_000, supportsCache: true, supportsTools: true, supportsVision: true },
  "claude-sonnet-4":           { contextWindow: 200_000, maxOutputTokens: 16_000, supportsCache: true, supportsTools: true, supportsVision: true },
  "claude-3-7-sonnet-20250219":{ contextWindow: 200_000, maxOutputTokens: 16_000, supportsCache: true, supportsTools: true, supportsVision: true },
  "claude-3-5-sonnet-20241022":{ contextWindow: 200_000, maxOutputTokens: 8_192,  supportsCache: true, supportsTools: true, supportsVision: true },
  "claude-3-5-sonnet-20240620":{ contextWindow: 200_000, maxOutputTokens: 8_192,  supportsCache: true, supportsTools: true, supportsVision: true },
  "claude-3-5-haiku-20241022": { contextWindow: 200_000, maxOutputTokens: 8_192,  supportsCache: true, supportsTools: true, supportsVision: true },
  "claude-3-opus-20240229":    { contextWindow: 200_000, maxOutputTokens: 4_096,  supportsCache: true, supportsTools: true, supportsVision: true },
  "claude-3-sonnet-20240229":  { contextWindow: 200_000, maxOutputTokens: 4_096,  supportsCache: true, supportsTools: true, supportsVision: true },
  "claude-3-haiku-20240307":   { contextWindow: 200_000, maxOutputTokens: 4_096,  supportsCache: false, supportsTools: true, supportsVision: true },
  // GPT / OpenAI
  "gpt-4.1":       { contextWindow: 128_000, maxOutputTokens: 32_768, supportsCache: false, supportsTools: true, supportsVision: true },
  "gpt-4.1-mini":  { contextWindow: 128_000, maxOutputTokens: 16_384, supportsCache: false, supportsTools: true, supportsVision: true },
  "gpt-4o":        { contextWindow: 128_000, maxOutputTokens: 16_384, supportsCache: false, supportsTools: true, supportsVision: true },
  "gpt-4o-mini":   { contextWindow: 128_000, maxOutputTokens: 16_384, supportsCache: false, supportsTools: true, supportsVision: true },
  "gpt-4-turbo":   { contextWindow: 128_000, maxOutputTokens: 4_096,  supportsCache: false, supportsTools: true, supportsVision: true },
  "o1":            { contextWindow: 200_000, maxOutputTokens: 100_000, supportsCache: false, supportsTools: false, supportsVision: false },
  "o3-mini":       { contextWindow: 200_000, maxOutputTokens: 100_000, supportsCache: false, supportsTools: false, supportsVision: false },
  // Codex / OpenAI o-series
  "codex-mini-latest": { contextWindow: 200_000, maxOutputTokens: 100_000, supportsCache: false, supportsTools: true, supportsVision: false },
  "o4-mini":           { contextWindow: 200_000, maxOutputTokens: 100_000, supportsCache: false, supportsTools: true, supportsVision: false },
  "gpt-5-codex":       { contextWindow:  32_000, maxOutputTokens:   8_192, supportsCache: false, supportsTools: true, supportsVision: false },
  "gpt-5.2-codex":     { contextWindow:  32_000, maxOutputTokens:   8_192, supportsCache: false, supportsTools: true, supportsVision: false },
};

// Baseline hardcoded pricing — always available as fallback
const BASELINE: Record<string, ModelInfo> = {
  // Claude 4.x models
  "claude-opus-4-6": { inputPerMillion: 15, outputPerMillion: 75, contextWindow: 200_000 },
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15, contextWindow: 200_000 },
  "claude-haiku-4-5-20251001": { inputPerMillion: 1, outputPerMillion: 5, contextWindow: 200_000 },
  "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5, contextWindow: 200_000 },
  // Claude 3.x models
  "claude-opus-4": { inputPerMillion: 15, outputPerMillion: 75, contextWindow: 200_000 },
  "claude-sonnet-4": { inputPerMillion: 3, outputPerMillion: 15, contextWindow: 200_000 },
  "claude-3-7-sonnet-20250219": { inputPerMillion: 3, outputPerMillion: 15, contextWindow: 200_000 },
  "claude-3-5-sonnet-20241022": { inputPerMillion: 3, outputPerMillion: 15, contextWindow: 200_000 },
  "claude-3-5-sonnet-20240620": { inputPerMillion: 3, outputPerMillion: 15, contextWindow: 200_000 },
  "claude-3-5-haiku-20241022": { inputPerMillion: 0.8, outputPerMillion: 4, contextWindow: 200_000 },
  "claude-3-opus-20240229": { inputPerMillion: 15, outputPerMillion: 75, contextWindow: 200_000 },
  "claude-3-sonnet-20240229": { inputPerMillion: 3, outputPerMillion: 15, contextWindow: 200_000 },
  "claude-3-haiku-20240307": { inputPerMillion: 0.25, outputPerMillion: 1.25, contextWindow: 200_000 },
  // Codex / OpenAI models
  "gpt-5-codex": { inputPerMillion: 1.25, outputPerMillion: 10, contextWindow: 32_000 },
  "gpt-5.2-codex": { inputPerMillion: 1.75, outputPerMillion: 14, contextWindow: 32_000 },
  "gpt-4.1": { inputPerMillion: 2, outputPerMillion: 8, contextWindow: 128_000 },
  "gpt-4.1-mini": { inputPerMillion: 0.4, outputPerMillion: 1.6, contextWindow: 128_000 },
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10, contextWindow: 128_000 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6, contextWindow: 128_000 },
  "gpt-4-turbo": { inputPerMillion: 10, outputPerMillion: 30, contextWindow: 128_000 },
  "o1": { inputPerMillion: 15, outputPerMillion: 60, contextWindow: 200_000 },
  "o3-mini": { inputPerMillion: 1.1, outputPerMillion: 4.4, contextWindow: 200_000 },
};

// Family-based fallback: if exact+prefix match fails, match by model family keyword
const FAMILY_FALLBACK: Array<{ pattern: RegExp; key: string }> = [
  { pattern: /claude.*opus/i, key: "claude-opus-4-6" },
  { pattern: /claude.*sonnet/i, key: "claude-sonnet-4-6" },
  { pattern: /claude.*haiku/i, key: "claude-haiku-4-5" },
  { pattern: /gpt-4o-mini/i, key: "gpt-4o-mini" },
  { pattern: /gpt-4o/i, key: "gpt-4o" },
  { pattern: /gpt-4/i, key: "gpt-4-turbo" },
  { pattern: /gpt-4\.1-mini/i, key: "gpt-4.1-mini" },
  { pattern: /gpt-4\.1/i, key: "gpt-4.1" },
  { pattern: /o3-mini/i, key: "o3-mini" },
  { pattern: /\bo1\b/i, key: "o1" },
];

// In-memory cache populated by refreshPricingCache()
let cache: Record<string, ModelInfo> = { ...BASELINE };
let cacheUpdatedAt = 0;

/**
 * Fetch pricing from ACC_PRICING_URL (if set) and merge into cache.
 * Falls back to baseline silently on any error.
 * Call this once on control-plane startup.
 */
export async function refreshPricingCache(url?: string): Promise<void> {
  const target = url ?? process.env["ACC_PRICING_URL"];
  if (!target) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(target, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as Record<string, unknown>;
    const merged: Record<string, ModelInfo> = { ...BASELINE };
    for (const [model, data] of Object.entries(raw)) {
      if (
        data &&
        typeof data === "object" &&
        "inputPerMillion" in data &&
        "outputPerMillion" in data
      ) {
        const d = data as Record<string, unknown>;
        merged[model.toLowerCase()] = {
          inputPerMillion: Number(d["inputPerMillion"]),
          outputPerMillion: Number(d["outputPerMillion"]),
          contextWindow: typeof d["contextWindow"] === "number" ? d["contextWindow"] : 32_000,
        };
      }
    }
    cache = merged;
    cacheUpdatedAt = Date.now();
  } catch {
    // silent fallback — baseline remains in cache
  }
}

function lookupModel(model: string): ModelInfo | null {
  const key = model.trim().toLowerCase();

  // 1. Exact match
  if (cache[key]) return cache[key];

  // 2. Prefix match: cache key is a prefix of the model string (e.g. "gpt-4.1" matches "gpt-4.1-2025-04-14")
  for (const [k, v] of Object.entries(cache)) {
    if (key.startsWith(k)) return v;
  }

  // 3. Substring match: model string contains the full cache key
  for (const [k, v] of Object.entries(cache)) {
    if (key.includes(k)) return v;
  }

  // 4. Family keyword fallback (handles "claude-3-5-sonnet-*", "claude-3-7-sonnet-*", etc.)
  for (const { pattern, key: fallbackKey } of FAMILY_FALLBACK) {
    if (pattern.test(model)) {
      return cache[fallbackKey] ?? null;
    }
  }

  return null;
}

export function getPricing(model: string): ModelPricing | null {
  return lookupModel(model);
}

export function getContextWindow(model: string, fallback = 32_000): number {
  return lookupModel(model)?.contextWindow ?? fallback;
}

export function getModelCapabilities(model: string): ModelCapabilities | null {
  const key = model.trim().toLowerCase();

  // Exact match
  if (MODEL_CAPABILITIES[key]) return MODEL_CAPABILITIES[key];

  // Prefix match
  for (const [k, v] of Object.entries(MODEL_CAPABILITIES)) {
    if (key.startsWith(k)) return v;
  }

  // Substring match
  for (const [k, v] of Object.entries(MODEL_CAPABILITIES)) {
    if (key.includes(k)) return v;
  }

  // Family fallback using FAMILY_FALLBACK keys
  for (const { pattern, key: fallbackKey } of FAMILY_FALLBACK) {
    if (pattern.test(model)) {
      return MODEL_CAPABILITIES[fallbackKey] ?? null;
    }
  }

  return null;
}

export function getCacheAge(): { updatedAt: number; isBaseline: boolean } {
  return { updatedAt: cacheUpdatedAt, isBaseline: cacheUpdatedAt === 0 };
}
