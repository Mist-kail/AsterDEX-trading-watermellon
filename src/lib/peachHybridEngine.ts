import { EMA } from "./indicators/ema";
import { RSI } from "./indicators/rsi";
import { ADX } from "./indicators/adx";
import { ATR } from "./indicators/atr";
import type { PeachConfig, StrategySignal, SyntheticBar } from "./types";

export class PeachHybridEngine {
  private readonly config: PeachConfig;
  
  private readonly v1EmaFast: EMA;
  private readonly v1EmaMid: EMA;
  private readonly v1EmaSlow: EMA;
  private readonly v1EmaMicroFast: EMA;
  private readonly v1EmaMicroSlow: EMA;
  private readonly v1Rsi: RSI;
  private v1LastLongLook = false;
  private v1LastShortLook = false;
  private v1LastLongPrice = 0;
  private v1LastShortPrice = 0;
  private v1BarsSinceLastSignal = 0;
  
  private readonly v2EmaFast: EMA;
  private readonly v2EmaMid: EMA;
  private readonly v2EmaSlow: EMA;
  private readonly v2Rsi: RSI;
  private v2RsiHistory: number[] = [];
  private volumeHistory: number[] = [];
  private readonly adx: ADX;
  private readonly atr: ATR;
  
  private recentHighs: number[] = [];
  private recentLows: number[] = [];
  private readonly lookbackPeriod = 20;
  
  private position: { side: "long" | "short" | "flat" } | null = null;
  
  constructor(config: PeachConfig) {
    this.config = config;
    
    this.v1EmaFast = new EMA(config.v1.emaFastLen);
    this.v1EmaMid = new EMA(config.v1.emaMidLen);
    this.v1EmaSlow = new EMA(config.v1.emaSlowLen);
    this.v1EmaMicroFast = new EMA(config.v1.emaMicroFastLen);
    this.v1EmaMicroSlow = new EMA(config.v1.emaMicroSlowLen);
    this.v1Rsi = new RSI(config.v1.rsiLength);
    
    this.v2EmaFast = new EMA(config.v2.emaFastLen);
    this.v2EmaMid = new EMA(config.v2.emaMidLen);
    this.v2EmaSlow = new EMA(config.v2.emaSlowLen);
    this.v2Rsi = new RSI(14);
    this.adx = new ADX(14);
    this.atr = new ATR(14);
  }
  
  update(bar: SyntheticBar): StrategySignal | null {
    const closePrice = bar.close;
    const volume = bar.volume;
    
    const v1EmaFast = this.v1EmaFast.update(closePrice);
    const v1EmaMid = this.v1EmaMid.update(closePrice);
    const v1EmaSlow = this.v1EmaSlow.update(closePrice);
    const v1EmaMicroFast = this.v1EmaMicroFast.update(closePrice);
    const v1EmaMicroSlow = this.v1EmaMicroSlow.update(closePrice);
    const v1Rsi = this.v1Rsi.update(closePrice);
    
    const v2EmaFast = this.v2EmaFast.update(closePrice);
    const v2EmaMid = this.v2EmaMid.update(closePrice);
    const v2EmaSlow = this.v2EmaSlow.update(closePrice);
    const v2Rsi = this.v2Rsi.update(closePrice);

    this.adx.update(bar.high, bar.low, closePrice);
    
    this.atr.update(bar.high, bar.low, closePrice);
    
    this.recentHighs.push(bar.high);
    this.recentLows.push(bar.low);
    if (this.recentHighs.length > this.lookbackPeriod) {
      this.recentHighs.shift();
      this.recentLows.shift();
    }
    
    if (v2Rsi !== null) {
      this.v2RsiHistory.push(v2Rsi);
      // Keep at least 3 values for proper momentum calculation (current vs 2 bars ago)
      if (this.v2RsiHistory.length > 3) {
        this.v2RsiHistory.shift();
      }
    }
    
    this.volumeHistory.push(volume);
    const maxVolumeHistory = Math.max(this.config.v2.volumeLookback, 10);
    if (this.volumeHistory.length > maxVolumeHistory) {
      this.volumeHistory.shift();
    }
    
    this.v1BarsSinceLastSignal++;
    
    const v1Signal = this.checkV1System(closePrice, v1EmaFast, v1EmaMid, v1EmaSlow, v1EmaMicroFast, v1EmaMicroSlow, v1Rsi);
    if (v1Signal) {
      return v1Signal;
    }
    
    const v2Signal = this.checkV2System(closePrice, v2EmaFast, v2EmaMid, v2EmaSlow, v2Rsi, volume, bar.open, bar.close);
    if (v2Signal) {
      return v2Signal;
    }
    
    return null;
  }
  
  private checkV1System(
    price: number,
    emaFast: number,
    emaMid: number,
    emaSlow: number,
    emaMicroFast: number,
    emaMicroSlow: number,
    rsi: number | null
  ): StrategySignal | null {
    if (rsi === null) return null;
    
    const bullStack = emaFast > emaMid && emaMid > emaSlow;
    const bearStack = emaFast < emaMid && emaMid < emaSlow;
    const microBullStack = emaMicroFast > emaMicroSlow;
    const microBearStack = emaMicroFast < emaMicroSlow;
    
    const longLook = bullStack && microBullStack && rsi > this.config.v1.rsiMinLong;
    const shortLook = bearStack && microBearStack && rsi < this.config.v1.rsiMaxShort;
    
    if (this.v1BarsSinceLastSignal < this.config.v1.minBarsBetween) {
      return null;
    }
    
    let priceMoveMet = true;
    if (this.v1LastLongPrice > 0) {
      const movePercent = Math.abs((price - this.v1LastLongPrice) / this.v1LastLongPrice) * 100;
      priceMoveMet = movePercent >= this.config.v1.minMovePercent;
    }
    if (this.v1LastShortPrice > 0) {
      const movePercent = Math.abs((price - this.v1LastShortPrice) / this.v1LastShortPrice) * 100;
      priceMoveMet = priceMoveMet && movePercent >= this.config.v1.minMovePercent;
    }
    
    if (!priceMoveMet) {
      return null;
    }
    
    const longTrig = longLook && !this.v1LastLongLook;
    const shortTrig = shortLook && !this.v1LastShortLook;
    
    this.v1LastLongLook = longLook;
    this.v1LastShortLook = shortLook;
    
    if (longTrig) {
      this.v1LastLongPrice = price;
      this.v1BarsSinceLastSignal = 0;
      return {
        type: "long",
        reason: "v1-long",
        system: "v1",
        indicators: {
          emaFast,
          emaMid,
          emaSlow,
          rsi,
        },
        trend: {
          bullStack,
          bearStack,
          longLook,
          shortLook,
          longTrig,
          shortTrig,
        },
      };
    }
    
    if (shortTrig) {
      this.v1LastShortPrice = price;
      this.v1BarsSinceLastSignal = 0;
      return {
        type: "short",
        reason: "v1-short",
        system: "v1",
        indicators: {
          emaFast,
          emaMid,
          emaSlow,
          rsi,
        },
        trend: {
          bullStack,
          bearStack,
          longLook,
          shortLook,
          longTrig,
          shortTrig,
        },
      };
    }
    
    return null;
  }
  
  private checkV2System(
    price: number,
    emaFast: number,
    emaMid: number,
    emaSlow: number,
    rsi: number | null,
    volume: number,
    barOpen: number,
    barClose: number
  ): StrategySignal | null {
    if (rsi === null || this.v2RsiHistory.length < 3) return null;
    
    // Fixed: Compare current RSI to RSI from 2 bars ago (matches Manual Cherry)
    const rsiMomentum = this.v2RsiHistory[this.v2RsiHistory.length - 1] - this.v2RsiHistory[this.v2RsiHistory.length - 3];
    const rsiSurge = Math.abs(rsiMomentum) >= this.config.v2.rsiMomentumThreshold;
    
    if (this.volumeHistory.length === 0) {
      return null;
    }
    const avgVolume = this.volumeHistory.reduce((sum, v) => sum + v, 0) / this.volumeHistory.length;
    const volumeSpike = volume >= avgVolume * this.config.v2.volumeMultiplier;
    
    const volumeColor = barClose > barOpen;
    
    const emaBullish = emaFast > emaMid && emaMid > emaSlow;
    const emaBearish = emaFast < emaMid && emaMid < emaSlow;
    
    if (rsiSurge && rsiMomentum > 0 && volumeSpike && volumeColor && emaBullish) {
      return {
        type: "long",
        reason: "v2-long",
        system: "v2",
        indicators: {
          emaFast,
          emaMid,
          emaSlow,
          rsi,
        },
        trend: {
          bullStack: emaBullish,
          bearStack: emaBearish,
          longLook: true,
          shortLook: false,
          longTrig: true,
          shortTrig: false,
        },
      };
    }
    
    if (rsiSurge && rsiMomentum < 0 && volumeSpike && !volumeColor && emaBearish) {
      return {
        type: "short",
        reason: "v2-short",
        system: "v2",
        indicators: {
          emaFast,
          emaMid,
          emaSlow,
          rsi,
        },
        trend: {
          bullStack: emaBullish,
          bearStack: emaBearish,
          longLook: false,
          shortLook: true,
          longTrig: false,
          shortTrig: true,
        },
      };
    }
    
    return null;
  }
  
  setPosition(side: "long" | "short" | "flat"): void {
    this.position = { side };
  }
  
  checkExitConditions(bar: SyntheticBar): {
    shouldExit: boolean;
    reason: string;
    details?: Record<string, unknown>;
  } {
    if (!this.position || this.position.side === "flat") {
      return { shouldExit: false, reason: "" };
    }

    const volume = bar.volume;
    const avgVolume = this.volumeHistory.length > 0 ? this.volumeHistory.reduce((sum, v) => sum + v, 0) / this.volumeHistory.length : volume;
    
    if (this.v2RsiHistory.length >= 3) {
      const recentRSI = this.v2RsiHistory.slice(-3);
      const rsiMomentum = Math.abs(recentRSI[recentRSI.length - 1] - recentRSI[0]);
      const volumeMultiplier = avgVolume > 0 ? volume / avgVolume : 1;

      const rsiFlattening = rsiMomentum < 2.0;
      const volumeDrop = volumeMultiplier < this.config.v2.exitVolumeMultiplier;
      
      let adverseRSI = false;
      if (this.position.side === "long" && recentRSI[recentRSI.length - 1] < recentRSI[0]) {
        adverseRSI = true;
      } else if (this.position.side === "short" && recentRSI[recentRSI.length - 1] > recentRSI[0]) {
        adverseRSI = true;
      }

      if ((rsiFlattening && volumeDrop) || adverseRSI) {
        return {
          shouldExit: true,
          reason: adverseRSI ? "rsi-reversal" : "rsi-flattening-volume-drop",
          details: {
            rsiMomentum,
            volume,
            avgVolume,
            volumeMultiplier,
            recentRSI,
            adverseRSI,
            position: this.position.side,
          },
        };
      }
    }
    
    return { shouldExit: false, reason: "" };
  }
  
  get settings(): PeachConfig {
    return this.config;
  }
  
  getIndicatorValues(): {
    v1: { emaFast: number | null; emaMid: number | null; emaSlow: number | null; rsi: number | null };
    v2: { emaFast: number | null; emaMid: number | null; emaSlow: number | null; rsi: number | null };
    adx: number | null;
    atr: number | null;
    recentHigh: number | null;
    recentLow: number | null;
  } {
    return {
      v1: {
        emaFast: this.v1EmaFast.isReady ? this.v1EmaFast.value : null,
        emaMid: this.v1EmaMid.isReady ? this.v1EmaMid.value : null,
        emaSlow: this.v1EmaSlow.isReady ? this.v1EmaSlow.value : null,
        rsi: this.v1Rsi.isReady ? this.v1Rsi.value : null,
      },
      v2: {
        emaFast: this.v2EmaFast.isReady ? this.v2EmaFast.value : null,
        emaMid: this.v2EmaMid.isReady ? this.v2EmaMid.value : null,
        emaSlow: this.v2EmaSlow.isReady ? this.v2EmaSlow.value : null,
        rsi: this.v2Rsi.isReady ? this.v2Rsi.value : null,
      },
      adx: this.adx.value,
      atr: this.atr.value,
      recentHigh: this.recentHighs.length > 0 ? Math.max(...this.recentHighs) : null,
      recentLow: this.recentLows.length > 0 ? Math.min(...this.recentLows) : null,
    };
  }

  shouldAllowTrading(adxThreshold: number = 25): boolean {
    return !this.adx.isReady || this.adx.isTrending(adxThreshold);
  }

  getAdxWarmupProgress(): number {
    return this.adx.warmupProgress;
  }
}

