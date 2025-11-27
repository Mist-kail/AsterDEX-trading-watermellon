export class ATR {
  private readonly length: number;
  private trValues: number[] = [];
  private prevHigh: number | null = null;
  private prevLow: number | null = null;
  private prevClose: number | null = null;
  private atrValue: number | null = null;
  private updateCount = 0;

  constructor(length: number = 14) {
    if (length < 2) {
      throw new Error("ATR length must be at least 2");
    }
    this.length = length;
  }

  update(high: number, low: number, close: number): number | null {
    if (this.prevHigh === null || this.prevLow === null || this.prevClose === null) {
      this.prevHigh = high;
      this.prevLow = low;
      this.prevClose = close;
      return null;
    }

    this.updateCount++;

    const tr = Math.max(
      high - low,
      Math.abs(high - this.prevClose),
      Math.abs(low - this.prevClose)
    );

    this.trValues.push(tr);
    if (this.trValues.length > this.length) {
      this.trValues.shift();
    }

    if (this.updateCount < this.length) {
      this.prevHigh = high;
      this.prevLow = low;
      this.prevClose = close;
      return null;
    }

    if (this.updateCount === this.length) {
      this.atrValue = this.trValues.reduce((sum, val) => sum + val, 0) / this.trValues.length;
    } else {
      const alpha = 1 / this.length;
      this.atrValue = this.atrValue! * (1 - alpha) + tr * alpha;
    }

    this.prevHigh = high;
    this.prevLow = low;
    this.prevClose = close;

    return this.atrValue;
  }

  get value(): number | null {
    return this.atrValue;
  }

  get isReady(): boolean {
    return this.atrValue !== null;
  }
}

