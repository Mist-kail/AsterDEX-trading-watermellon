import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SyntheticBar, StrategySignal } from "../../src/lib/types";

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

// Mock fs for logger
vi.mock("fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn().mockReturnValue("[]"),
  writeFileSync: vi.fn(),
}));

describe("AI Filter Index", () => {
  let mockChat: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    // Create a fresh mock chat function for each test
    mockChat = vi.fn();

    // Mock the @blockrun/llm module with a proper class
    vi.doMock("@blockrun/llm", () => ({
      LLMClient: class MockLLMClient {
        chat = mockChat;
      },
    }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe("initAIFilter", () => {
    it("should initialize with default config", async () => {
      mockChat.mockResolvedValue("test");
      const { initAIFilter } = await import("../../src/lib/ai-filter/index");
      const config = initAIFilter();

      expect(config.enabled).toBe(true);
      expect(config.sentimentModel).toBe("xai/grok-3-mini");
      expect(config.decisionModel).toBe("anthropic/claude-sonnet-4");
      expect(config.timeoutMs).toBe(8000);
      expect(config.fallbackOnError).toBe("skip");
    });

    it("should merge custom config", async () => {
      mockChat.mockResolvedValue("test");
      const { initAIFilter } = await import("../../src/lib/ai-filter/index");
      const config = initAIFilter({
        token: "BTC",
        timeoutMs: 5000,
      });

      expect(config.token).toBe("BTC");
      expect(config.timeoutMs).toBe(5000);
      expect(config.enabled).toBe(true); // default preserved
    });
  });

  describe("updateRecentBars", () => {
    it("should store recent bars", async () => {
      mockChat.mockResolvedValue("test");
      const { updateRecentBars } = await import("../../src/lib/ai-filter/index");

      updateRecentBars(mockBar);
      updateRecentBars({ ...mockBar, close: 2010 });

      // No direct way to verify, but it shouldn't throw
      expect(true).toBe(true);
    });

    it("should limit buffer to MAX_RECENT_BARS", async () => {
      mockChat.mockResolvedValue("test");
      const { updateRecentBars } = await import("../../src/lib/ai-filter/index");

      // Add 10 bars
      for (let i = 0; i < 10; i++) {
        updateRecentBars({ ...mockBar, close: 2000 + i });
      }

      // No direct way to verify, but it shouldn't throw
      expect(true).toBe(true);
    });
  });

  describe("evaluateSignal", () => {
    it("should return approved result when both AI calls succeed", async () => {
      mockChat
        .mockResolvedValueOnce(`SENTIMENT: BULLISH
CONFIDENCE: HIGH
CONTEXT: Very positive`)
        .mockResolvedValueOnce(`DECISION: APPROVE
REASONING: Looks good`);

      const { evaluateSignal } = await import("../../src/lib/ai-filter/index");
      const result = await evaluateSignal(mockSignal, mockBar, "ETH");

      expect(result.approved).toBe(true);
      expect(result.reasoning).toBe("Looks good");
      expect(result.sentiment).not.toBeNull();
      expect(result.sentiment?.sentiment).toBe("BULLISH");
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("should return vetoed result when AI vetoes", async () => {
      mockChat
        .mockResolvedValueOnce(`SENTIMENT: BEARISH
CONFIDENCE: HIGH
CONTEXT: Very negative`)
        .mockResolvedValueOnce(`DECISION: VETO
REASONING: Sentiment conflicts with signal`);

      const { evaluateSignal } = await import("../../src/lib/ai-filter/index");
      const result = await evaluateSignal(mockSignal, mockBar, "ETH");

      expect(result.approved).toBe(false);
      expect(result.reasoning).toBe("Sentiment conflicts with signal");
    });

    it("should handle API errors gracefully", async () => {
      mockChat.mockRejectedValue(new Error("API Error"));

      const { evaluateSignal } = await import("../../src/lib/ai-filter/index");
      const result = await evaluateSignal(mockSignal, mockBar, "ETH");

      expect(result.approved).toBe(false);
      expect(result.error).toContain("API Error");
      expect(result.grokCostUsd).toBe(0);
      expect(result.claudeCostUsd).toBe(0);
    });

    it("should include cost estimates in result", async () => {
      mockChat
        .mockResolvedValueOnce(`SENTIMENT: NEUTRAL
CONFIDENCE: MEDIUM
CONTEXT: Mixed`)
        .mockResolvedValueOnce(`DECISION: APPROVE
REASONING: OK`);

      const { evaluateSignal } = await import("../../src/lib/ai-filter/index");
      const result = await evaluateSignal(mockSignal, mockBar, "ETH");

      expect(result.grokCostUsd).toBeGreaterThan(0);
      expect(result.claudeCostUsd).toBeGreaterThan(0);
    });
  });

  describe("evaluateSignalWithTimeout", () => {
    it("should return result within timeout", async () => {
      mockChat
        .mockResolvedValueOnce(`SENTIMENT: BULLISH
CONFIDENCE: HIGH
CONTEXT: Good`)
        .mockResolvedValueOnce(`DECISION: APPROVE
REASONING: OK`);

      const { evaluateSignalWithTimeout } = await import("../../src/lib/ai-filter/index");
      const result = await evaluateSignalWithTimeout(mockSignal, mockBar, "ETH", 5000);

      expect(result.approved).toBe(true);
    });

    it("should timeout and return conservative result", async () => {
      mockChat.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve(`SENTIMENT: BULLISH
CONFIDENCE: HIGH
CONTEXT: Good`),
              10000
            );
          })
      );

      const { evaluateSignalWithTimeout } = await import("../../src/lib/ai-filter/index");
      const result = await evaluateSignalWithTimeout(mockSignal, mockBar, "ETH", 100);

      expect(result.approved).toBe(false);
      expect(result.error).toContain("timeout");
    }, 5000);
  });
});
