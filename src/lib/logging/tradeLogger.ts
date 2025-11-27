import * as fs from "fs";
import * as path from "path";

type IndicatorValues = {
  v1?: {
    emaFast: number | null;
    emaMid: number | null;
    emaSlow: number | null;
    rsi: number | null;
  };
  v2?: {
    emaFast: number | null;
    emaMid: number | null;
    emaSlow: number | null;
    rsi: number | null;
  };
  adx?: number | null;
  atr?: number | null;
  recentHigh?: number | null;
  recentLow?: number | null;
  emaFast?: number | null;
  emaMid?: number | null;
  emaSlow?: number | null;
  rsi?: number | null;
};

type TradeEntryLog = {
  timestamp: string;
  event: "ENTRY";
  side: "long" | "short";
  entryPrice: number;
  size: number;
  leverage: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  riskRewardRatio?: number;
  riskDistance?: number;
  rewardDistance?: number;
  bar: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    timestamp: number;
  };
  indicators: IndicatorValues;
  marketConditions: {
    adx?: number | null;
    adxReady?: boolean;
    marketRegime?: "trending" | "ranging" | "warming up";
    atr?: number | null;
  };
  signalReason: string;
  balance: number;
  riskParams: {
    maxPositionSize: number;
    maxLeverage: number;
    stopLossPct: number;
    takeProfitPct: number;
  };
};

type TradeExitLog = {
  timestamp: string;
  event: "EXIT";
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  size: number;
  leverage: number;
  pnl: number;
  pnlPercent: number;
  duration: number; // milliseconds
  exitReason: string;
  bar: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    timestamp: number;
  };
  indicators: IndicatorValues;
  marketConditions: {
    adx?: number | null;
    atr?: number | null;
  };
  balance: number;
  tradeId?: string;
};

type SignalLog = {
  timestamp: string;
  event: "SIGNAL";
  signalType: "long" | "short";
  signalReason: string;
  bar: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    timestamp: number;
  };
  indicators: IndicatorValues;
  marketConditions: {
    adx?: number | null;
    adxReady?: boolean;
    marketRegime?: "trending" | "ranging" | "warming up";
  };
  action: "TAKEN" | "SKIPPED";
  skipReason?: string;
  riskRewardRatio?: number;
};

type TradeLog = TradeEntryLog | TradeExitLog | SignalLog;

export class TradeLogger {
  private readonly logDir: string;
  private readonly csvFile: string;
  private readonly jsonFile: string;
  private readonly signalsFile: string;
  private readonly dailyDir: string;

  constructor(logDir: string = "data/trades") {
    this.logDir = logDir;
    this.dailyDir = path.join(logDir, "daily");
    
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    if (!fs.existsSync(this.dailyDir)) {
      fs.mkdirSync(this.dailyDir, { recursive: true });
    }

    const dateStr = new Date().toISOString().split("T")[0];
    this.csvFile = path.join(this.dailyDir, `trades-${dateStr}.csv`);
    this.jsonFile = path.join(this.dailyDir, `trades-${dateStr}.json`);
    this.signalsFile = path.join(this.dailyDir, `signals-${dateStr}.json`);

    this.initializeCsv();
  }

  private initializeCsv(): void {
    if (!fs.existsSync(this.csvFile)) {
      const header = [
        "Timestamp",
        "Event",
        "Side",
        "Entry Price",
        "Exit Price",
        "Size",
        "Leverage",
        "PnL",
        "PnL %",
        "Duration (ms)",
        "Reason",
        "Entry RSI V1",
        "Entry RSI V2",
        "Entry ADX",
        "Entry ATR",
        "Exit RSI V1",
        "Exit RSI V2",
        "Exit ADX",
        "Exit ATR",
        "Risk/Reward",
        "Bar Close",
        "Volume",
      ].join(",");
      fs.writeFileSync(this.csvFile, header + "\n");
    }
  }

  logEntry(data: Omit<TradeEntryLog, "timestamp" | "event">): void {
    const log: TradeEntryLog = {
      ...data,
      timestamp: new Date().toISOString(),
      event: "ENTRY",
    };

    this.writeToCsv(log);
    this.appendToJson(this.jsonFile, log);
  }

  logExit(data: Omit<TradeExitLog, "timestamp" | "event">): void {
    const log: TradeExitLog = {
      ...data,
      timestamp: new Date().toISOString(),
      event: "EXIT",
    };

    this.writeToCsv(log);
    this.appendToJson(this.jsonFile, log);
  }

  logSignal(data: Omit<SignalLog, "timestamp" | "event">): void {
    const log: SignalLog = {
      ...data,
      timestamp: new Date().toISOString(),
      event: "SIGNAL",
    };

    this.appendToJson(this.signalsFile, log);
  }

  private writeToCsv(log: TradeLog): void {
    if (log.event === "SIGNAL") {
      return; // Signals go to separate file
    }

    let row: string[] = [];

    if (log.event === "ENTRY") {
      row = [
        log.timestamp,
        log.event,
        log.side,
        log.entryPrice.toFixed(4),
        "",
        log.size.toFixed(4),
        log.leverage.toString(),
        "",
        "",
        "",
        log.signalReason,
        log.indicators.v1?.rsi?.toFixed(2) || "",
        log.indicators.v2?.rsi?.toFixed(2) || "",
        log.indicators.adx?.toFixed(2) || "",
        log.indicators.atr?.toFixed(4) || "",
        "",
        "",
        "",
        "",
        log.riskRewardRatio?.toFixed(2) || "",
        log.bar.close.toFixed(4),
        log.bar.volume.toFixed(2),
      ];
    } else if (log.event === "EXIT") {
      const duration = log.duration || 0;
      const durationHours = (duration / (1000 * 60 * 60)).toFixed(2);
      
      row = [
        log.timestamp,
        log.event,
        log.side,
        log.entryPrice.toFixed(4),
        log.exitPrice.toFixed(4),
        log.size.toFixed(4),
        log.leverage.toString(),
        log.pnl.toFixed(4),
        log.pnlPercent.toFixed(2),
        durationHours,
        log.exitReason,
        "",
        "",
        "",
        "",
        log.indicators.v2?.rsi?.toFixed(2) || "",
        log.indicators.v2?.rsi?.toFixed(2) || "",
        log.indicators.adx?.toFixed(2) || "",
        log.indicators.atr?.toFixed(4) || "",
        "",
        log.bar.close.toFixed(4),
        log.bar.volume.toFixed(2),
      ];
    }

    const csvRow = row.map((cell) => `"${cell}"`).join(",");
    fs.appendFileSync(this.csvFile, csvRow + "\n");
  }

  private appendToJson(filePath: string, log: TradeLog): void {
    let logs: TradeLog[] = [];
    
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        logs = JSON.parse(content);
      } catch {
        logs = [];
      }
    }

    logs.push(log);
    fs.writeFileSync(filePath, JSON.stringify(logs, null, 2));
  }

  getTrades(date?: string): TradeLog[] {
    const targetDate = date || new Date().toISOString().split("T")[0];
    const filePath = path.join(this.dailyDir, `trades-${targetDate}.json`);
    
    if (!fs.existsSync(filePath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(content);
    } catch {
      return [];
    }
  }

  getSignals(date?: string): SignalLog[] {
    const targetDate = date || new Date().toISOString().split("T")[0];
    const filePath = path.join(this.dailyDir, `signals-${targetDate}.json`);
    
    if (!fs.existsSync(filePath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(content);
    } catch {
      return [];
    }
  }
}


