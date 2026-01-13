import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StrategySignal, SyntheticBar } from "../../src/lib/types";
import type { FilterResult, SentimentResult } from "../../src/lib/ai-filter/types";

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
  context: "Very positive",
  raw: "raw response",
};

const mockFilterResult: FilterResult = {
  approved: true,
  reasoning: "Sentiment aligns with signal",
  sentiment: mockSentiment,
  latencyMs: 500,
  grokCostUsd: 0.001,
  claudeCostUsd: 0.003,
};

describe("AI Filter Logger", () => {
  let mockFs: {
    existsSync: ReturnType<typeof vi.fn>;
    mkdirSync: ReturnType<typeof vi.fn>;
    readFileSync: ReturnType<typeof vi.fn>;
    writeFileSync: ReturnType<typeof vi.fn>;
  };
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();

    mockFs = {
      existsSync: vi.fn(),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
    };

    vi.doMock("fs", () => mockFs);

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("logFilterDecision", () => {
    it("should create directory if not exists", async () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.readFileSync.mockReturnValue("[]");

      const { logFilterDecision } = await import("../../src/lib/ai-filter/logger");
      logFilterDecision(mockSignal, mockBar, "ETH", mockFilterResult);

      expect(mockFs.mkdirSync).toHaveBeenCalled();
    });

    it("should write to log file", async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue("[]");

      const { logFilterDecision } = await import("../../src/lib/ai-filter/logger");
      logFilterDecision(mockSignal, mockBar, "ETH", mockFilterResult);

      expect(mockFs.writeFileSync).toHaveBeenCalled();

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData).toHaveLength(1);
      expect(writtenData[0].signal.direction).toBe("long");
      expect(writtenData[0].signal.token).toBe("ETH");
      expect(writtenData[0].decision.approved).toBe(true);
    });

    it("should append to existing logs", async () => {
      const existingLogs = [
        {
          timestamp: "2024-01-01T00:00:00.000Z",
          signal: { direction: "short", token: "BTC", entryPrice: 40000, reason: "test" },
          sentiment: null,
          decision: { approved: false, reasoning: "test" },
          performance: { latencyMs: 100, grokCostUsd: 0.001, claudeCostUsd: 0.003 },
        },
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingLogs));

      const { logFilterDecision } = await import("../../src/lib/ai-filter/logger");
      logFilterDecision(mockSignal, mockBar, "ETH", mockFilterResult);

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData).toHaveLength(2);
    });

    it("should limit logs to 1000 entries", async () => {
      const manyLogs = Array.from({ length: 1001 }, (_, i) => ({
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        signal: { direction: "long", token: "ETH", entryPrice: 2000, reason: "test" },
        sentiment: null,
        decision: { approved: true, reasoning: "test" },
        performance: { latencyMs: 100, grokCostUsd: 0.001, claudeCostUsd: 0.003 },
      }));

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(manyLogs));

      const { logFilterDecision } = await import("../../src/lib/ai-filter/logger");
      logFilterDecision(mockSignal, mockBar, "ETH", mockFilterResult);

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData).toHaveLength(1000);
    });

    it("should log to console", async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue("[]");

      const { logFilterDecision } = await import("../../src/lib/ai-filter/logger");
      logFilterDecision(mockSignal, mockBar, "ETH", mockFilterResult);

      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it("should handle write errors gracefully", async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue("[]");
      mockFs.writeFileSync.mockImplementation(() => {
        throw new Error("Write failed");
      });

      const { logFilterDecision } = await import("../../src/lib/ai-filter/logger");
      logFilterDecision(mockSignal, mockBar, "ETH", mockFilterResult);

      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it("should log error field when present", async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue("[]");

      const errorResult: FilterResult = {
        ...mockFilterResult,
        approved: false,
        error: "API timeout",
      };

      const { logFilterDecision } = await import("../../src/lib/ai-filter/logger");
      logFilterDecision(mockSignal, mockBar, "ETH", errorResult);

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData[0].error).toBe("API timeout");
    });
  });

  describe("getFilterStats", () => {
    it("should return zero stats when no log file exists", async () => {
      mockFs.existsSync.mockReturnValue(false);

      const { getFilterStats } = await import("../../src/lib/ai-filter/logger");
      const stats = getFilterStats();

      expect(stats.totalDecisions).toBe(0);
      expect(stats.approvals).toBe(0);
      expect(stats.vetoes).toBe(0);
      expect(stats.approvalRate).toBe(0);
      expect(stats.avgLatencyMs).toBe(0);
      expect(stats.totalCostUsd).toBe(0);
    });

    it("should calculate stats correctly", async () => {
      const logs = [
        {
          timestamp: "2024-01-01T00:00:00.000Z",
          signal: { direction: "long", token: "ETH", entryPrice: 2000, reason: "test" },
          sentiment: null,
          decision: { approved: true, reasoning: "test" },
          performance: { latencyMs: 500, grokCostUsd: 0.001, claudeCostUsd: 0.003 },
        },
        {
          timestamp: "2024-01-01T00:01:00.000Z",
          signal: { direction: "short", token: "BTC", entryPrice: 40000, reason: "test" },
          sentiment: null,
          decision: { approved: false, reasoning: "test" },
          performance: { latencyMs: 700, grokCostUsd: 0.001, claudeCostUsd: 0.003 },
        },
        {
          timestamp: "2024-01-01T00:02:00.000Z",
          signal: { direction: "long", token: "SOL", entryPrice: 100, reason: "test" },
          sentiment: null,
          decision: { approved: true, reasoning: "test" },
          performance: { latencyMs: 600, grokCostUsd: 0.001, claudeCostUsd: 0.003 },
        },
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(logs));

      const { getFilterStats } = await import("../../src/lib/ai-filter/logger");
      const stats = getFilterStats();

      expect(stats.totalDecisions).toBe(3);
      expect(stats.approvals).toBe(2);
      expect(stats.vetoes).toBe(1);
      expect(stats.approvalRate).toBeCloseTo(66.67, 1);
      expect(stats.avgLatencyMs).toBe(600);
      expect(stats.totalCostUsd).toBeCloseTo(0.012, 3);
    });

    it("should handle malformed log file", async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue("not valid json");

      const { getFilterStats } = await import("../../src/lib/ai-filter/logger");
      const stats = getFilterStats();

      expect(stats.totalDecisions).toBe(0);
    });
  });
});
