/**
 * AI-Powered Stop-Loss Suggestion
 *
 * Uses BlockRun LLM SDK to suggest optimal stop-loss levels
 * based on market volatility and position direction.
 */

import { LLMClient } from "@blockrun/llm";

export interface StopLossSuggestion {
  stopLossPct: number;
  reasoning: string;
}

export interface AIStopLossConfig {
  enabled: boolean;
  model: string;
  timeoutMs: number;
}

const DEFAULT_CONFIG: AIStopLossConfig = {
  enabled: true,
  model: "anthropic/claude-sonnet-4",
  timeoutMs: 5000,
};

let clientInstance: LLMClient | null = null;
let config: AIStopLossConfig = DEFAULT_CONFIG;

/**
 * Initialize the AI stop-loss module
 */
export function initAIStopLoss(userConfig?: Partial<AIStopLossConfig>): AIStopLossConfig {
  config = { ...DEFAULT_CONFIG, ...userConfig };
  clientInstance = new LLMClient();
  console.log("[AIStopLoss] Initialized", { enabled: config.enabled, model: config.model });
  return config;
}

/**
 * Calculate price volatility from recent bars
 */
function calculateVolatility(recentPrices: number[]): number {
  if (recentPrices.length < 2) return 0;

  const returns: number[] = [];
  for (let i = 1; i < recentPrices.length; i++) {
    const pctChange = Math.abs((recentPrices[i] - recentPrices[i - 1]) / recentPrices[i - 1]) * 100;
    returns.push(pctChange);
  }

  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  return avgReturn;
}

/**
 * Get AI-suggested stop-loss percentage for a new position
 */
export async function getAIStopLossSuggestion(
  side: "long" | "short",
  entryPrice: number,
  recentPrices: number[],
  token: string
): Promise<StopLossSuggestion> {
  if (!clientInstance) {
    clientInstance = new LLMClient();
  }

  const volatility = calculateVolatility(recentPrices);
  const priceRange = recentPrices.length > 0
    ? ((Math.max(...recentPrices) - Math.min(...recentPrices)) / entryPrice * 100).toFixed(2)
    : "0";

  const prompt = `You are a trading risk assistant. Suggest an optimal stop-loss percentage for this trade:

Position: ${side.toUpperCase()} ${token}
Entry Price: $${entryPrice.toFixed(2)}
Recent Volatility: ${volatility.toFixed(2)}% avg move per bar
Price Range (last ${recentPrices.length} bars): ${priceRange}%

Rules:
- Stop-loss must be between 0.5% and 3.0%
- Higher volatility = wider stop-loss to avoid noise
- Lower volatility = tighter stop-loss for protection

Respond with ONLY valid JSON (no markdown):
{"stopLossPct": <number>, "reasoning": "<brief reason>"}`;

  try {
    const response = await Promise.race([
      clientInstance.chat(config.model, prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), config.timeoutMs)
      ),
    ]);

    const content = typeof response === "string" ? response : String(response);
    const jsonMatch = content.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const stopLossPct = Math.max(0.5, Math.min(3.0, Number(parsed.stopLossPct)));

      return {
        stopLossPct,
        reasoning: parsed.reasoning || "AI suggested based on market conditions",
      };
    }

    throw new Error("Invalid AI response format");
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("[AIStopLoss] Error:", errorMsg);

    // Fallback: use volatility-based calculation
    const fallbackPct = Math.max(0.5, Math.min(3.0, volatility * 1.5 + 0.5));
    return {
      stopLossPct: fallbackPct,
      reasoning: `Fallback calculation (${errorMsg})`,
    };
  }
}

/**
 * Check if AI stop-loss is enabled
 */
export function isEnabled(): boolean {
  return config.enabled;
}
