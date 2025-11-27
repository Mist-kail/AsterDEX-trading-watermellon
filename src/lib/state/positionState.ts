export type LocalPositionState = {
  size: number;
  side: "long" | "short" | "flat";
  avgEntry: number;
  unrealizedPnl: number;
  lastUpdate: number;
  orderId?: string;
  pendingOrder?: {
    side: "long" | "short";
    size: number;
    timestamp: number;
  };
};

export class PositionStateManager {
  private state: LocalPositionState = {
    size: 0,
    side: "flat",
    avgEntry: 0,
    unrealizedPnl: 0,
    lastUpdate: Date.now(),
  };

  private reconciliationFailures = 0;
  private readonly maxReconciliationFailures = 2;

  updateLocalState(update: Partial<LocalPositionState>): void {
    this.state = {
      ...this.state,
      ...update,
      lastUpdate: Date.now(),
    };
  }

  updateFromRest(restState: {
    positionAmt: string;
    entryPrice: string;
    unrealizedProfit: string;
  }): boolean {
    const size = parseFloat(restState.positionAmt);
    const side: "long" | "short" | "flat" = size > 0 ? "long" : size < 0 ? "short" : "flat";
    const avgEntry = parseFloat(restState.entryPrice) || 0;
    const unrealizedPnl = parseFloat(restState.unrealizedProfit) || 0;

    const restStateNormalized = {
      size: Math.abs(size),
      side,
      avgEntry,
      unrealizedPnl,
    };

    const localStateNormalized = {
      size: this.state.size,
      side: this.state.side,
      avgEntry: this.state.avgEntry,
      unrealizedPnl: this.state.unrealizedPnl,
    };

    const reconciled = this.reconcile(restStateNormalized, localStateNormalized);

    if (reconciled) {
      this.reconciliationFailures = 0;
      this.state = {
        ...this.state,
        ...restStateNormalized,
        lastUpdate: Date.now(),
      };
      return true;
    }

    if (restStateNormalized.side === "flat" && localStateNormalized.side !== "flat") {
      console.log(`[PositionState] REST shows flat position, clearing local state (was ${localStateNormalized.side} ${localStateNormalized.size})`);
      this.reconciliationFailures = 0;
      this.state = {
        ...this.state,
        ...restStateNormalized,
        lastUpdate: Date.now(),
      };
      return true;
    }

    if (restStateNormalized.side !== "flat" && localStateNormalized.side === "flat") {
      console.log(`[PositionState] REST shows ${restStateNormalized.side} position (${restStateNormalized.size}), updating local state from flat`);
      this.reconciliationFailures = 0;
      this.state = {
        ...this.state,
        ...restStateNormalized,
        lastUpdate: Date.now(),
      };
      return true;
    }

    this.reconciliationFailures++;
    return false;
  }

  private reconcile(
    rest: { size: number; side: "long" | "short" | "flat"; avgEntry: number; unrealizedPnl: number },
    local: { size: number; side: "long" | "short" | "flat"; avgEntry: number; unrealizedPnl: number },
  ): boolean {
    const sizeMatch = Math.abs(rest.size - local.size) < 0.0001;
    const sideMatch = rest.side === local.side;
    
    if (rest.side === "flat" && local.side === "flat") {
      return sizeMatch && sideMatch;
    }
    
    const entryMatch = rest.avgEntry === 0 || Math.abs(rest.avgEntry - local.avgEntry) / rest.avgEntry < 0.01;

    return sizeMatch && sideMatch && entryMatch;
  }

  shouldFreezeTrading(): boolean {
    return this.reconciliationFailures >= this.maxReconciliationFailures;
  }

  resetReconciliationFailures(): void {
    this.reconciliationFailures = 0;
  }

  getState(): LocalPositionState {
    return { ...this.state };
  }

  clearPendingOrder(): void {
    this.state.pendingOrder = undefined;
  }

  setPendingOrder(order: { side: "long" | "short"; size: number; timestamp: number }): void {
    this.state.pendingOrder = order;
  }
}

