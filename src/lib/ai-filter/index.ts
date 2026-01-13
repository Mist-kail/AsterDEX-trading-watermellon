/**
 * AI Filter for Trade Signals
 *
 * Uses Grok for real-time X/Twitter sentiment + Claude for decision making
 * to filter trade signals before execution.
 *
 * Flow: Signal -> Grok (sentiment) -> Claude (decision) -> Approve/Veto
 */

import { LLMClient } from "@blockrun/llm";
import type { StrategySignal, SyntheticBar } from "../types";
import type { AIFilterConfig, FilterResult, TradeSignalContext } from "./types";
import { getSentiment } from "./grok";
import { getDecision } from "./claude";
import { logFilterDecision, getFilterStats } from "./logger";

// Estimated costs per call (approximate)
const GROK_COST_ESTIMATE = 0.001; // $0.001 minimum per call
const CLAUDE_COST_ESTIMATE = 0.003; // ~$0.003 per typical call

const DEFAULT_CONFIG: AIFilterConfig = {
  enabled: true,
  token: "ETH", // Default token, should be overridden
  sentimentModel: "xai/grok-3-mini",
  decisionModel: "anthropic/claude-sonnet-4",
  timeoutMs: 8000,
  fallbackOnError: "skip", // Conservative: skip trade if AI fails
};

let clientInstance: LLMClient | null = null;
let recentBarsBuffer: SyntheticBar[] = [];
const MAX_RECENT_BARS = 5;

/**
 * Initialize the AI filter
 * Call this once at bot startup
 */
export function initAIFilter(config?: Partial<AIFilterConfig>): AIFilterConfig {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  // Initialize the LLM client
  clientInstance = new LLMClient();

  console.log("[AIFilter] Initialized", {
    enabled: mergedConfig.enabled,
    token: mergedConfig.token,
    sentimentModel: mergedConfig.sentimentModel,
    decisionModel: mergedConfig.decisionModel,
    timeoutMs: mergedConfig.timeoutMs,
    fallbackOnError: mergedConfig.fallbackOnError,
  });

  return mergedConfig;
}

/**
 * Update the recent bars buffer
 * Call this on each bar close to maintain price context
 */
export function updateRecentBars(bar: SyntheticBar): void {
  recentBarsBuffer.push(bar);
  if (recentBarsBuffer.length > MAX_RECENT_BARS) {
    recentBarsBuffer.shift();
  }
}

/**
 * Evaluate a trade signal using AI
 *
 * @param signal - The strategy signal to evaluate
 * @param bar - The current bar data
 * @param token - The trading pair token (e.g., "ETH", "BTC")
 * @returns FilterResult with approval decision and reasoning
 */
export async function evaluateSignal(
  signal: NonNullable<StrategySignal>,
  bar: SyntheticBar,
  token: string
): Promise<FilterResult> {
  const startTime = Date.now();

  // Ensure client is initialized
  if (!clientInstance) {
    clientInstance = new LLMClient();
  }

  const context: TradeSignalContext = {
    signal,
    bar,
    token,
    recentBars: [...recentBarsBuffer],
  };

  try {
    // Step 1: Get sentiment from Grok
    const sentiment = await getSentiment(clientInstance, token);

    // Step 2: Get decision from Claude
    const decision = await getDecision(clientInstance, context, sentiment);

    const result: FilterResult = {
      approved: decision.approved,
      reasoning: decision.reasoning,
      sentiment,
      latencyMs: Date.now() - startTime,
      grokCostUsd: GROK_COST_ESTIMATE,
      claudeCostUsd: CLAUDE_COST_ESTIMATE,
    };

    // Log the decision
    logFilterDecision(signal, bar, token, result);

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    console.error("[AIFilter] Error evaluating signal:", errorMessage);

    const result: FilterResult = {
      approved: false, // Conservative fallback: don't trade on error
      reasoning: `AI filter unavailable: ${errorMessage}`,
      sentiment: null,
      latencyMs: Date.now() - startTime,
      grokCostUsd: 0,
      claudeCostUsd: 0,
      error: errorMessage,
    };

    // Log the error case too
    logFilterDecision(signal, bar, token, result);

    return result;
  }
}

/**
 * Evaluate signal with timeout
 * Use this wrapper to enforce maximum latency
 */
export async function evaluateSignalWithTimeout(
  signal: NonNullable<StrategySignal>,
  bar: SyntheticBar,
  token: string,
  timeoutMs: number = DEFAULT_CONFIG.timeoutMs
): Promise<FilterResult> {
  const timeoutPromise = new Promise<FilterResult>((_, reject) => {
    setTimeout(() => reject(new Error("AI filter timeout")), timeoutMs);
  });

  try {
    return await Promise.race([
      evaluateSignal(signal, bar, token),
      timeoutPromise,
    ]);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      approved: false, // Conservative fallback
      reasoning: `AI filter timeout after ${timeoutMs}ms`,
      sentiment: null,
      latencyMs: timeoutMs,
      grokCostUsd: 0,
      claudeCostUsd: 0,
      error: errorMessage,
    };
  }
}

/**
 * Get AI filter statistics
 */
export { getFilterStats };

/**
 * Re-export types for convenience
 */
export type { AIFilterConfig, FilterResult, FilterLogEntry } from "./types";
