/**
 * AI Filter Logger
 * Logs all AI filter decisions for analysis and debugging
 */

import * as fs from "fs";
import * as path from "path";
import type { FilterLogEntry, FilterResult, SentimentResult } from "./types";
import type { StrategySignal, SyntheticBar } from "../types";

const LOG_DIR = "data";
const LOG_FILE = "ai-filter-decisions.json";

export function logFilterDecision(
  signal: NonNullable<StrategySignal>,
  bar: SyntheticBar,
  token: string,
  result: FilterResult
): void {
  const entry: FilterLogEntry = {
    timestamp: new Date().toISOString(),
    signal: {
      direction: signal.type,
      token,
      entryPrice: bar.close,
      reason: signal.reason,
    },
    sentiment: result.sentiment,
    decision: {
      approved: result.approved,
      reasoning: result.reasoning,
    },
    performance: {
      latencyMs: result.latencyMs,
      grokCostUsd: result.grokCostUsd,
      claudeCostUsd: result.claudeCostUsd,
    },
    error: result.error,
  };

  appendToLog(entry);
  logToConsole(entry);
}

function appendToLog(entry: FilterLogEntry): void {
  try {
    const logPath = path.join(process.cwd(), LOG_DIR, LOG_FILE);
    const logDir = path.dirname(logPath);

    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    let logs: FilterLogEntry[] = [];
    if (fs.existsSync(logPath)) {
      try {
        const content = fs.readFileSync(logPath, "utf-8");
        logs = JSON.parse(content);
      } catch {
        logs = [];
      }
    }

    logs.push(entry);

    // Keep last 1000 entries to prevent unbounded growth
    if (logs.length > 1000) {
      logs = logs.slice(-1000);
    }

    fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
  } catch (error) {
    console.error("[AIFilter] Failed to write log:", error);
  }
}

function logToConsole(entry: FilterLogEntry): void {
  const emoji = entry.decision.approved ? "\u2705" : "\u274C";
  const sentimentEmoji = getSentimentEmoji(entry.sentiment?.sentiment);

  console.log(
    `[AIFilter] ${emoji} ${entry.signal.direction.toUpperCase()} ${entry.signal.token} @ ${entry.signal.entryPrice.toFixed(4)}`
  );
  console.log(
    `  ${sentimentEmoji} Sentiment: ${entry.sentiment?.sentiment || "N/A"} (${entry.sentiment?.confidence || "N/A"})`
  );
  console.log(`  Decision: ${entry.decision.reasoning}`);
  console.log(
    `  Latency: ${entry.performance.latencyMs}ms | Cost: $${(entry.performance.grokCostUsd + entry.performance.claudeCostUsd).toFixed(4)}`
  );

  if (entry.error) {
    console.log(`  Error: ${entry.error}`);
  }
}

function getSentimentEmoji(sentiment?: string): string {
  switch (sentiment) {
    case "BULLISH":
      return "\uD83D\uDCC8";
    case "BEARISH":
      return "\uD83D\uDCC9";
    default:
      return "\u2796";
  }
}

export function getFilterStats(): {
  totalDecisions: number;
  approvals: number;
  vetoes: number;
  approvalRate: number;
  avgLatencyMs: number;
  totalCostUsd: number;
} {
  try {
    const logPath = path.join(process.cwd(), LOG_DIR, LOG_FILE);

    if (!fs.existsSync(logPath)) {
      return {
        totalDecisions: 0,
        approvals: 0,
        vetoes: 0,
        approvalRate: 0,
        avgLatencyMs: 0,
        totalCostUsd: 0,
      };
    }

    const content = fs.readFileSync(logPath, "utf-8");
    const logs: FilterLogEntry[] = JSON.parse(content);

    const approvals = logs.filter((l) => l.decision.approved).length;
    const totalLatency = logs.reduce((sum, l) => sum + l.performance.latencyMs, 0);
    const totalCost = logs.reduce(
      (sum, l) => sum + l.performance.grokCostUsd + l.performance.claudeCostUsd,
      0
    );

    return {
      totalDecisions: logs.length,
      approvals,
      vetoes: logs.length - approvals,
      approvalRate: logs.length > 0 ? (approvals / logs.length) * 100 : 0,
      avgLatencyMs: logs.length > 0 ? totalLatency / logs.length : 0,
      totalCostUsd: totalCost,
    };
  } catch {
    return {
      totalDecisions: 0,
      approvals: 0,
      vetoes: 0,
      approvalRate: 0,
      avgLatencyMs: 0,
      totalCostUsd: 0,
    };
  }
}
