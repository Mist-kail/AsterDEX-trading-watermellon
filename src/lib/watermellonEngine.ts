import { EMA } from "./indicators/ema";
import { RSI } from "./indicators/rsi";
import { ADX } from "./indicators/adx";
import type {
  IndicatorSnapshot,
  StrategySignal,
  SyntheticBar,
  TrendSnapshot,
  WatermellonConfig,
} from "./types";

const DEFAULT_CONFIG: WatermellonConfig = {
  timeframeMs: 30_000,
  emaFastLen: 8,
  emaMidLen: 21,
  emaSlowLen: 48,
  rsiLength: 14,
  rsiMinLong: 42,
  rsiMaxShort: 58,
  adxLength: 14,
  adxThreshold: 25,
};

export class WatermellonEngine {
  private readonly config: WatermellonConfig;
  private readonly emaFast: EMA;
  private readonly emaMid: EMA;
  private readonly emaSlow: EMA;
  private readonly rsi: RSI;
  private readonly adx: ADX;
  private lastLongLook = false;
  private lastShortLook = false;

  constructor(config?: Partial<WatermellonConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.emaFast = new EMA(this.config.emaFastLen);
    this.emaMid = new EMA(this.config.emaMidLen);
    this.emaSlow = new EMA(this.config.emaSlowLen);
    this.rsi = new RSI(this.config.rsiLength);
    this.adx = new ADX(this.config.adxLength);
  }

  update(bar: SyntheticBar): StrategySignal | null {
    const emaFastValue = this.emaFast.update(bar.close);
    const emaMidValue = this.emaMid.update(bar.close);
    const emaSlowValue = this.emaSlow.update(bar.close);
    const rsiValue = this.rsi.update(bar.close);
    const adxValue = this.adx.update(bar.high, bar.low, bar.close);

    const indicators: IndicatorSnapshot = {
      emaFast: emaFastValue,
      emaMid: emaMidValue,
      emaSlow: emaSlowValue,
      rsi: rsiValue,
      adx: adxValue,
    };

    if (adxValue === null || adxValue < this.config.adxThreshold) {
      this.lastLongLook = false;
      this.lastShortLook = false;
      return null;
    }

    const bullStack = emaFastValue > emaMidValue && emaMidValue > emaSlowValue;
    const bearStack = emaFastValue < emaMidValue && emaMidValue < emaSlowValue;

    const longLook = bullStack && rsiValue > this.config.rsiMinLong && rsiValue > 55;
    const shortLook = bearStack && rsiValue < this.config.rsiMaxShort && rsiValue < 45;

    const longTrig = longLook && !this.lastLongLook;
    const shortTrig = shortLook && !this.lastShortLook;

    this.lastLongLook = longLook;
    this.lastShortLook = shortLook;

    const trend: TrendSnapshot = {
      bullStack,
      bearStack,
      longLook,
      shortLook,
      longTrig,
      shortTrig,
    };

    if (longTrig) {
      return { type: "long", reason: "long-trigger", indicators, trend };
    }

    if (shortTrig) {
      return { type: "short", reason: "short-trigger", indicators, trend };
    }

    return null;
  }

  get settings(): WatermellonConfig {
    return this.config;
  }

  getIndicatorValues(): {
    emaFast: number | null;
    emaMid: number | null;
    emaSlow: number | null;
    rsi: number | null;
    adx: number | null;
  } {
    return {
      emaFast: this.emaFast.value,
      emaMid: this.emaMid.value,
      emaSlow: this.emaSlow.value,
      rsi: this.rsi.value,
      adx: this.adx.value,
    };
  }
}

