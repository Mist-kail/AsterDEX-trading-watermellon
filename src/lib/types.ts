export type Tick = {
  timestamp: number;
  price: number;
  size?: number;
};

export type SyntheticBar = {
  startTime: number;
  endTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type IndicatorSnapshot = {
  emaFast: number;
  emaMid: number;
  emaSlow: number;
  rsi: number;
  adx?: number | null;
};

export type TrendSnapshot = {
  bullStack: boolean;
  bearStack: boolean;
  longLook: boolean;
  shortLook: boolean;
  longTrig: boolean;
  shortTrig: boolean;
};

export type StrategySignal =
  | {
      type: "long";
      reason: "long-trigger" | "v1-long" | "v2-long";
      indicators: IndicatorSnapshot;
      trend: TrendSnapshot;
      system?: "v1" | "v2";
    }
  | {
      type: "short";
      reason: "short-trigger" | "v1-short" | "v2-short";
      indicators: IndicatorSnapshot;
      trend: TrendSnapshot;
      system?: "v1" | "v2";
    }
  | null;

export type ExitSignal = {
  reason: "rsi-flattening" | "volume-drop" | "opposite-signal" | "stop-loss" | "emergency-stop";
  details?: Record<string, unknown>;
};

export type WatermellonConfig = {
  timeframeMs: number;
  emaFastLen: number;
  emaMidLen: number;
  emaSlowLen: number;
  rsiLength: number;
  rsiMinLong: number;
  rsiMaxShort: number;
  adxLength: number;
  adxThreshold: number;
};

export type PeachV1Config = {
  emaFastLen: number;
  emaMidLen: number;
  emaSlowLen: number;
  emaMicroFastLen: number;
  emaMicroSlowLen: number;
  rsiLength: number;
  rsiMinLong: number;
  rsiMaxShort: number;
  minBarsBetween: number;
  minMovePercent: number;
};

export type PeachV2Config = {
  emaFastLen: number;
  emaMidLen: number;
  emaSlowLen: number;
  rsiMomentumThreshold: number;
  volumeLookback: number;
  volumeMultiplier: number;
  exitVolumeMultiplier: number;
};

export type PeachConfig = {
  timeframeMs: number;
  v1: PeachV1Config;
  v2: PeachV2Config;
};

export type RiskConfig = {
  maxPositionSize: number;
  maxLeverage: number;
  maxFlipsPerHour: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  useStopLoss?: boolean;
  emergencyStopLoss?: number;
  maxPositions?: number;
  requireTrendingMarket?: boolean;
  adxThreshold?: number;
};

export type Mode = "dry-run" | "live";

export type Credentials = {
  rpcUrl: string;
  wsUrl: string;
  apiKey: string;
  apiSecret: string;
  privateKey: string;
  pairSymbol: string;
};

export type AIStopLossConfig = {
  enabled: boolean;
  model?: string;
  timeoutMs?: number;
};

export type AppConfig = {
  mode: Mode;
  credentials: Credentials;
  strategy: WatermellonConfig | PeachConfig;
  risk: RiskConfig;
  strategyType?: "watermellon" | "peach-hybrid";
  aiStopLoss?: AIStopLossConfig;
};

export type PositionSide = "long" | "short" | "flat";

export type PositionState = {
  side: PositionSide;
  size: number;
  entryPrice?: number;
  openedAt?: number;
};

export type TradeInstruction = {
  side: Exclude<PositionSide, "flat">;
  size: number;
  leverage: number;
  price: number;
  signalReason: string;
  timestamp: number;
};

export type ExecutionAdapter = {
  enterLong(order: TradeInstruction): Promise<void>;
  enterShort(order: TradeInstruction): Promise<void>;
  closePosition(reason: string, meta?: Record<string, unknown>): Promise<void>;
};

