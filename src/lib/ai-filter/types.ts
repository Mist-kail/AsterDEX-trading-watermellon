/**
 * AI Filter Types
 * Type definitions for the AI-powered trade signal filter
 */

import type { StrategySignal, SyntheticBar } from "../types";

export interface TradeSignalContext {
  signal: NonNullable<StrategySignal>;
  bar: SyntheticBar;
  token: string;
  recentBars: SyntheticBar[];
}

export interface SentimentResult {
  sentiment: "BULLISH" | "BEARISH" | "NEUTRAL";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  context: string;
  raw: string;
}

export interface FilterDecision {
  approved: boolean;
  reasoning: string;
}

export interface FilterResult {
  approved: boolean;
  reasoning: string;
  sentiment: SentimentResult | null;
  latencyMs: number;
  grokCostUsd: number;
  claudeCostUsd: number;
  error?: string;
}

export interface AIFilterConfig {
  enabled: boolean;
  token: string;
  sentimentModel: string;
  decisionModel: string;
  timeoutMs: number;
  fallbackOnError: "skip" | "approve";
}

export interface FilterLogEntry {
  timestamp: string;
  signal: {
    direction: "long" | "short";
    token: string;
    entryPrice: number;
    reason: string;
  };
  sentiment: SentimentResult | null;
  decision: {
    approved: boolean;
    reasoning: string;
  };
  performance: {
    latencyMs: number;
    grokCostUsd: number;
    claudeCostUsd: number;
  };
  error?: string;
}
