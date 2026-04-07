export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface ModelInfo extends ModelPricing {
  contextWindow: number;
}

// Baseline hardcoded pricing — always available as fallback
const BASELINE: Record<string, ModelInfo> = {
  // Claude models
  "claude-opus-4-6": { inputPerMillion: 15, outputPerMillion: 75, contextWindow: 200_000 },
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15, contextWindow: 200_000 },
  "claude-haiku-4-5-20251001": { inputPerMillion: 1, outputPerMillion: 5, contextWindow: 200_000 },
  "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5, contextWindow: 200_000 },
  // Codex models
  "gpt-5-codex": { inputPerMillion: 1.25, outputPerMillion: 10, contextWindow: 32_000 },
  "gpt-5.2-codex": { inputPerMillion: 1.75, outputPerMillion: 14, contextWindow: 32_000 },
  "gpt-4.1": { inputPerMillion: 2, outputPerMillion: 8, contextWindow: 128_000 },
  "gpt-4.1-mini": { inputPerMillion: 0.4, outputPerMillion: 1.6, contextWindow: 128_000 },
};

// In-memory cache populated by refreshPricingCache()
let cache: Record<string, ModelInfo> = { ...BASELINE };
let cacheUpdatedAt = 0;
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000; // 24 hours

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
  if (cache[key]) return cache[key];
  // fuzzy match: find a key that the model string contains or starts with
  for (const [k, v] of Object.entries(cache)) {
    if (key.includes(k) || key.startsWith(k.split("-").slice(0, 3).join("-"))) return v;
  }
  return null;
}

export function getPricing(model: string): ModelPricing | null {
  return lookupModel(model);
}

export function getContextWindow(model: string, fallback = 32_000): number {
  return lookupModel(model)?.contextWindow ?? fallback;
}

export function getCacheAge(): { updatedAt: number; isBaseline: boolean } {
  return { updatedAt: cacheUpdatedAt, isBaseline: cacheUpdatedAt === 0 };
}
