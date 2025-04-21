export class RateLimiter {
  private calls: number[] = [];
  private readonly maxCalls: number;
  private readonly timeWindow: number;

  constructor(maxCalls: number = 30, timeWindow: number = 60000) {
    this.maxCalls = maxCalls;
    this.timeWindow = timeWindow;
  }

  async waitForSlot(): Promise<void> {
    const now = Date.now();

    // Remove calls outside the time window
    this.calls = this.calls.filter((time) => now - time < this.timeWindow);

    // If we're at the limit, wait until the oldest call expires
    if (this.calls.length >= this.maxCalls) {
      const oldestCall = this.calls[0];
      const waitTime = this.timeWindow - (now - oldestCall);
      if (waitTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
      // Remove the oldest call after waiting
      this.calls.shift();
    }

    // Add the current call
    this.calls.push(now);
  }
}

// Jupiter API rate limiter: 60 calls per minute
export const jupiterRateLimiter = new RateLimiter(60, 60000);
