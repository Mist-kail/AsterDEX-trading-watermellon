import { describe, it, expect, vi } from "vitest";

// We need to test the internal parseSentimentResponse function
// Since it's not exported, we'll test getSentiment with a mocked LLMClient

describe("grok sentiment parsing", () => {
  describe("parseSentimentResponse (via getSentiment)", () => {
    it("should parse a well-formed bullish response", async () => {
      const mockClient = {
        chat: vi.fn().mockResolvedValue(`SENTIMENT: BULLISH
CONFIDENCE: HIGH
CONTEXT: Traders are excited about the breakout above resistance`),
      };

      const { getSentiment } = await import("../../src/lib/ai-filter/grok");
      const result = await getSentiment(mockClient as any, "ETH");

      expect(result.sentiment).toBe("BULLISH");
      expect(result.confidence).toBe("HIGH");
      expect(result.context).toBe("Traders are excited about the breakout above resistance");
      expect(result.raw).toContain("SENTIMENT: BULLISH");
    });

    it("should parse a bearish response with low confidence", async () => {
      const mockClient = {
        chat: vi.fn().mockResolvedValue(`SENTIMENT: BEARISH
CONFIDENCE: LOW
CONTEXT: Some concerns about market conditions but mixed opinions`),
      };

      const { getSentiment } = await import("../../src/lib/ai-filter/grok");
      const result = await getSentiment(mockClient as any, "BTC");

      expect(result.sentiment).toBe("BEARISH");
      expect(result.confidence).toBe("LOW");
      expect(result.context).toBe("Some concerns about market conditions but mixed opinions");
    });

    it("should parse neutral sentiment", async () => {
      const mockClient = {
        chat: vi.fn().mockResolvedValue(`SENTIMENT: NEUTRAL
CONFIDENCE: MEDIUM
CONTEXT: Market is ranging, no clear direction from traders`),
      };

      const { getSentiment } = await import("../../src/lib/ai-filter/grok");
      const result = await getSentiment(mockClient as any, "SOL");

      expect(result.sentiment).toBe("NEUTRAL");
      expect(result.confidence).toBe("MEDIUM");
    });

    it("should handle malformed response with defaults", async () => {
      const mockClient = {
        chat: vi.fn().mockResolvedValue(`Some random response that doesn't follow the format`),
      };

      const { getSentiment } = await import("../../src/lib/ai-filter/grok");
      const result = await getSentiment(mockClient as any, "ETH");

      expect(result.sentiment).toBe("NEUTRAL");
      expect(result.confidence).toBe("MEDIUM");
      expect(result.context).toBe("Unable to parse sentiment context");
    });

    it("should handle response with extra whitespace", async () => {
      const mockClient = {
        chat: vi.fn().mockResolvedValue(`
          SENTIMENT:   BULLISH
          CONFIDENCE:    HIGH
          CONTEXT:   Lots of positive tweets about ETH
        `),
      };

      const { getSentiment } = await import("../../src/lib/ai-filter/grok");
      const result = await getSentiment(mockClient as any, "ETH");

      expect(result.sentiment).toBe("BULLISH");
      expect(result.confidence).toBe("HIGH");
    });

    it("should handle case-insensitive sentiment values", async () => {
      const mockClient = {
        chat: vi.fn().mockResolvedValue(`SENTIMENT: bullish
CONFIDENCE: high
CONTEXT: Test`),
      };

      const { getSentiment } = await import("../../src/lib/ai-filter/grok");
      const result = await getSentiment(mockClient as any, "ETH");

      expect(result.sentiment).toBe("BULLISH");
      expect(result.confidence).toBe("HIGH");
    });

    it("should use correct model for API call", async () => {
      const mockClient = {
        chat: vi.fn().mockResolvedValue(`SENTIMENT: NEUTRAL
CONFIDENCE: MEDIUM
CONTEXT: Test`),
      };

      const { getSentiment } = await import("../../src/lib/ai-filter/grok");
      await getSentiment(mockClient as any, "ETH");

      expect(mockClient.chat).toHaveBeenCalledWith(
        "xai/grok-3-mini",
        expect.stringContaining("ETH")
      );
    });

    it("should replace $TOKEN placeholder with actual token", async () => {
      const mockClient = {
        chat: vi.fn().mockResolvedValue(`SENTIMENT: NEUTRAL
CONFIDENCE: MEDIUM
CONTEXT: Test`),
      };

      const { getSentiment } = await import("../../src/lib/ai-filter/grok");
      await getSentiment(mockClient as any, "DOGE");

      expect(mockClient.chat).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("DOGE")
      );
      expect(mockClient.chat).toHaveBeenCalledWith(
        expect.any(String),
        expect.not.stringContaining("$TOKEN")
      );
    });
  });

  describe("formatSentimentForDecision", () => {
    it("should format sentiment result correctly", async () => {
      const { formatSentimentForDecision } = await import("../../src/lib/ai-filter/grok");

      const sentiment = {
        sentiment: "BULLISH" as const,
        confidence: "HIGH" as const,
        context: "Very positive sentiment",
        raw: "raw response",
      };

      const formatted = formatSentimentForDecision(sentiment);

      expect(formatted).toContain("SENTIMENT: BULLISH");
      expect(formatted).toContain("CONFIDENCE: HIGH");
      expect(formatted).toContain("CONTEXT: Very positive sentiment");
    });
  });
});
