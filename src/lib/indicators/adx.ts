export class ADX {
  private readonly length: number;
  private trValues: number[] = [];
  private plusDMValues: number[] = [];
  private minusDMValues: number[] = [];
  private dxValues: number[] = [];
  private prevHigh: number | null = null;
  private prevLow: number | null = null;
  private prevClose: number | null = null;
  private prevATR: number | null = null;
  private prevPlusDI: number | null = null;
  private prevMinusDI: number | null = null;
  private adxValue: number | null = null;
  private updateCount = 0;

  constructor(length: number = 14) {
    if (length < 2) {
      throw new Error("ADX length must be at least 2");
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

    const plusDM = (high > this.prevHigh && low > this.prevLow)
      ? Math.max(high - this.prevHigh, 0)
      : 0;

    const minusDM = (this.prevHigh > high && this.prevLow > low)
      ? Math.max(this.prevLow - low, 0)
      : 0;

    this.trValues.push(tr);
    this.plusDMValues.push(plusDM);
    this.minusDMValues.push(minusDM);

    if (this.trValues.length > this.length) {
      this.trValues.shift();
      this.plusDMValues.shift();
      this.minusDMValues.shift();
    }

    if (this.updateCount < this.length + 1) {
      this.prevHigh = high;
      this.prevLow = low;
      this.prevClose = close;
      return null;
    }

    let atr: number;
    let plusDI: number;
    let minusDI: number;

    if (this.updateCount === this.length + 1) {
      atr = this.trValues.reduce((sum, val) => sum + val, 0) / this.length;
      const avgPlusDM = this.plusDMValues.reduce((sum, val) => sum + val, 0) / this.length;
      const avgMinusDM = this.minusDMValues.reduce((sum, val) => sum + val, 0) / this.length;

      plusDI = avgPlusDM / atr * 100;
      minusDI = avgMinusDM / atr * 100;
    } else {
      const alpha = 1 / this.length;
      atr = this.prevATR! * (1 - alpha) + tr * alpha;
      const plusDM_smooth = this.prevPlusDI! / 100 * this.prevATR! * (1 - alpha) + plusDM * alpha;
      const minusDM_smooth = this.prevMinusDI! / 100 * this.prevATR! * (1 - alpha) + minusDM * alpha;

      plusDI = plusDM_smooth / atr * 100;
      minusDI = minusDM_smooth / atr * 100;
    }

    const diSum = plusDI + minusDI;
    if (diSum === 0) {
      this.prevHigh = high;
      this.prevLow = low;
      this.prevClose = close;
      return this.adxValue;
    }
    const dx = Math.abs(plusDI - minusDI) / diSum * 100;

    if (this.updateCount === this.length + 1) {
      this.dxValues.push(dx);
    } else if (this.updateCount > this.length + 1) {
      if (this.adxValue === null) {
        this.dxValues.push(dx);
        if (this.dxValues.length >= this.length) {
          this.adxValue = this.dxValues.reduce((sum, val) => sum + val, 0) / this.dxValues.length;
        }
      } else {
        const alpha = 1 / this.length;
        this.adxValue = this.adxValue * (1 - alpha) + dx * alpha;
      }
    }

    this.prevATR = atr;
    this.prevPlusDI = plusDI;
    this.prevMinusDI = minusDI;

    this.prevHigh = high;
    this.prevLow = low;
    this.prevClose = close;

    return this.adxValue;
  }

  get value(): number | null {
    return this.adxValue;
  }

  get isReady(): boolean {
    return this.adxValue !== null;
  }

  get warmupProgress(): number {
    if (this.adxValue !== null) return 1.0;
    const totalNeeded = 2 * this.length + 2;
    const current = this.updateCount;
    return Math.min(current / totalNeeded, 0.99);
  }

  isTrending(threshold: number = 25): boolean {
    return this.adxValue !== null && this.adxValue > threshold;
  }
}
