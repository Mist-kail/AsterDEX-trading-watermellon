import { describe, it, expect, vi } from "vitest";
import type { SentimentResult, TradeSignalContext } from "../../src/lib/ai-filter/types";
import type { StrategySignal, SyntheticBar } from "../../src/lib/types";

const mockBar: SyntheticBar = {
  startTime: 1700000000000,
  endTime: 1700000030000,
  open: 2000.0,
  high: 2010.0,
  low: 1995.0,
  close: 2005.0,
  volume: 1000,
};

const mockSignal: NonNullable<StrategySignal> = {
  type: "long",
  reason: "long-trigger",
  indicators: {
    emaFast: 2005,
    emaMid: 2000,
    emaSlow: 1990,
    rsi: 55,
    adx: 30,
  },
  trend: {
    bullStack: true,
    bearStack: false,
    longLook: true,
    shortLook: false,
    longTrig: true,
    shortTrig: false,
  },
};

const mockSentiment: SentimentResult = {
  sentiment: "BULLISH",
  confidence: "HIGH",
  context: "Traders are bullish on ETH",
  raw: "SENTIMENT: BULLISH\nCONFIDENCE: HIGH\nCONTEXT: Traders are bullish on ETH",
};

describe("claude decision engine", () => {
  describe("parseDecisionResponse (via getDecision)", () => {
    it("should parse an APPROVE decision", async () => {
      const mockClient = {
        chat: vi.fn().mockResolvedValue(`DECISION: APPROVE
REASONING: Sentiment aligns with technical signal, bullish momentum confirmed.`),
      };

      const { getDecision } = await import("../../src/lib/ai-filter/claude");
      const context: TradeSignalContext = {
        signal: mockSignal,
        bar: mockBar,
        token: "ETH",
        recentBars: [mockBar],
      };

      const result = await getDecision(mockClient as any, context, mockSentiment);

      expect(result.approved).toBe(true);
      expect(result.reasoning).toBe("Sentiment aligns with technical signal, bullish momentum confirmed.");
    });

    it("should parse a VETO decision", async () => {
      const mockClient = {
        chat: vi.fn().mockResolvedValue(`DECISION: VETO
REASONING: Bearish sentiment conflicts with long signal. Market appears uncertain.`),
      };

      const { getDecision } = await import("../../src/lib/ai-filter/claude");
      const context: TradeSignalContext = {
        signal: mockSignal,
        bar: mockBar,
        token: "ETH",
        recentBars: [],
      };

      const bearishSentiment: SentimentResult = {
        ...mockSentiment,
        sentiment: "BEARISH",
      };

      const result = await getDecision(mockClient as any, context, bearishSentiment);

      expect(result.approved).toBe(false);
      expect(result.reasoning).toContain("Bearish sentiment");
    });

    it("should handle malformed response and default to VETO", async () => {
      const mockClient = {
        chat: vi.fn().mockResolvedValue(`I think this is a good trade because...`),
      };

      const { getDecision } = await import("../../src/lib/ai-filter/claude");
      const context: TradeSignalContext = {
        signal: mockSignal,
        bar: mockBar,
        token: "ETH",
        recentBars: [],
      };

      const result = await getDecision(mockClient as any, context, mockSentiment);

      expect(result.approved).toBe(false);
      expect(result.reasoning).toBe("Unable to parse decision reasoning");
    });

    it("should use correct model for API call", async () => {
      const mockClient = {
        chat: vi.fn().mockResolvedValue(`DECISION: APPROVE
REASONING: Test`),
      };

      const { getDecision } = await import("../../src/lib/ai-filter/claude");
      const context: TradeSignalContext = {
        signal: mockSignal,
        bar: mockBar,
        token: "BTC",
        recentBars: [],
      };

      await getDecision(mockClient as any, context, mockSentiment);

      expect(mockClient.chat).toHaveBeenCalledWith(
        "anthropic/claude-sonnet-4",
        expect.any(String)
      );
    });

    it("should include signal direction in prompt", async () => {
      const mockClient = {
        chat: vi.fn().mockResolvedValue(`DECISION: APPROVE
REASONING: Test`),
      };

      const { getDecision } = await import("../../src/lib/ai-filter/claude");
      const context: TradeSignalContext = {
        signal: mockSignal,
        bar: mockBar,
        token: "ETH",
        recentBars: [],
      };

      await getDecision(mockClient as any, context, mockSentiment);

      expect(mockClient.chat).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("LONG")
      );
    });

    it("should include token in prompt", async () => {
      const mockClient = {
        chat: vi.fn().mockResolvedValue(`DECISION: APPROVE
REASONING: Test`),
      };

      const { getDecision } = await import("../../src/lib/ai-filter/claude");
      const context: TradeSignalContext = {
        signal: mockSignal,
        bar: mockBar,
        token: "SOL",
        recentBars: [],
      };

      await getDecision(mockClient as any, context, mockSentiment);

      expect(mockClient.chat).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("SOL")
      );
    });

    it("should include entry price in prompt", async () => {
      const mockClient = {
        chat: vi.fn().mockResolvedValue(`DECISION: APPROVE
REASONING: Test`),
      };

      const { getDecision } = await import("../../src/lib/ai-filter/claude");
      const context: TradeSignalContext = {
        signal: mockSignal,
        bar: mockBar,
        token: "ETH",
        recentBars: [],
      };

      await getDecision(mockClient as any, context, mockSentiment);

      expect(mockClient.chat).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("2005.0000")
      );
    });

    it("should handle short signal", async () => {
      const mockClient = {
        chat: vi.fn().mockResolvedValue(`DECISION: APPROVE
REASONING: Test`),
      };

      const shortSignal: NonNullable<StrategySignal> = {
        type: "short",
        reason: "short-trigger",
        indicators: mockSignal.indicators,
        trend: mockSignal.trend,
      };

      const { getDecision } = await import("../../src/lib/ai-filter/claude");
      const context: TradeSignalContext = {
        signal: shortSignal,
        bar: mockBar,
        token: "ETH",
        recentBars: [],
      };

      await getDecision(mockClient as any, context, mockSentiment);

      expect(mockClient.chat).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("SHORT")
      );
    });
  });

  describe("formatRecentBars", () => {
    it("should format multiple bars correctly", async () => {
      const mockClient = {
        chat: vi.fn().mockResolvedValue(`DECISION: APPROVE
REASONING: Test`),
      };

      const bars: SyntheticBar[] = [
        {
          startTime: 1700000000000,
          endTime: 1700000030000,
          open: 2000,
          high: 2010,
          low: 1995,
          close: 2005,
          volume: 100,
        },
        {
          startTime: 1700000030000,
          endTime: 1700000060000,
          open: 2005,
          high: 2015,
          low: 2000,
          close: 2010,
          volume: 150,
        },
      ];

      const { getDecision } = await import("../../src/lib/ai-filter/claude");
      const context: TradeSignalContext = {
        signal: mockSignal,
        bar: mockBar,
        token: "ETH",
        recentBars: bars,
      };

      await getDecision(mockClient as any, context, mockSentiment);

      // Check that prompt contains bar data
      expect(mockClient.chat).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("[1]")
      );
      expect(mockClient.chat).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("[2]")
      );
    });

    it("should handle empty bars array", async () => {
      const mockClient = {
        chat: vi.fn().mockResolvedValue(`DECISION: APPROVE
REASONING: Test`),
      };

      const { getDecision } = await import("../../src/lib/ai-filter/claude");
      const context: TradeSignalContext = {
        signal: mockSignal,
        bar: mockBar,
        token: "ETH",
        recentBars: [],
      };

      await getDecision(mockClient as any, context, mockSentiment);

      expect(mockClient.chat).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("No recent bar data available")
      );
    });

    it("should show percentage change with correct sign", async () => {
      const mockClient = {
        chat: vi.fn().mockResolvedValue(`DECISION: APPROVE
REASONING: Test`),
      };

      const bullishBar: SyntheticBar = {
        startTime: 1700000000000,
        endTime: 1700000030000,
        open: 2000,
        high: 2020,
        low: 1995,
        close: 2020, // +1%
        volume: 100,
      };

      const { getDecision } = await import("../../src/lib/ai-filter/claude");
      const context: TradeSignalContext = {
        signal: mockSignal,
        bar: mockBar,
        token: "ETH",
        recentBars: [bullishBar],
      };

      await getDecision(mockClient as any, context, mockSentiment);

      expect(mockClient.chat).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("+")
      );
    });
  });
});
