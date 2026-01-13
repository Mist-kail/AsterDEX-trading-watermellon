/**
 * Grok Sentiment Fetcher
 * Uses Grok's real-time X/Twitter access to get current market sentiment
 */

import { LLMClient } from "@blockrun/llm";
import type { SentimentResult } from "./types";

const SENTIMENT_MODEL = "xai/grok-3-mini";

const SENTIMENT_PROMPT_TEMPLATE = `What's the current sentiment on $TOKEN futures on crypto Twitter right now?

Analyze recent posts, discussions, and trader sentiment about $TOKEN.

Respond in this EXACT format (no extra text):
SENTIMENT: [BULLISH/BEARISH/NEUTRAL]
CONFIDENCE: [HIGH/MEDIUM/LOW]
CONTEXT: [One sentence summarizing what traders are saying]`;

export async function getSentiment(
  client: LLMClient,
  token: string
): Promise<SentimentResult> {
  const prompt = SENTIMENT_PROMPT_TEMPLATE.replace(/\$TOKEN/g, token);

  const response = await client.chat(SENTIMENT_MODEL, prompt);

  return parseSentimentResponse(response);
}

function parseSentimentResponse(response: string): SentimentResult {
  const lines = response.trim().split("\n");

  let sentiment: SentimentResult["sentiment"] = "NEUTRAL";
  let confidence: SentimentResult["confidence"] = "MEDIUM";
  let context = "Unable to parse sentiment context";

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("SENTIMENT:")) {
      const value = trimmed.replace("SENTIMENT:", "").trim().toUpperCase();
      if (value === "BULLISH" || value === "BEARISH" || value === "NEUTRAL") {
        sentiment = value;
      }
    } else if (trimmed.startsWith("CONFIDENCE:")) {
      const value = trimmed.replace("CONFIDENCE:", "").trim().toUpperCase();
      if (value === "HIGH" || value === "MEDIUM" || value === "LOW") {
        confidence = value;
      }
    } else if (trimmed.startsWith("CONTEXT:")) {
      context = trimmed.replace("CONTEXT:", "").trim();
    }
  }

  return {
    sentiment,
    confidence,
    context,
    raw: response,
  };
}

export function formatSentimentForDecision(sentiment: SentimentResult): string {
  return `SENTIMENT: ${sentiment.sentiment}
CONFIDENCE: ${sentiment.confidence}
CONTEXT: ${sentiment.context}`;
}
