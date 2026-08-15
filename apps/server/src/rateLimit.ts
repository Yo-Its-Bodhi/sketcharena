export class SlidingLimit {
  private readonly activity = new Map<string, number[]>();

  constructor(private readonly max: number, private readonly windowMs: number) {}

  take(key: string, now = Date.now()): boolean {
    const floor = now - this.windowMs;
    const recent = (this.activity.get(key) ?? []).filter((value) => value > floor);
    if (recent.length >= this.max) {
      this.activity.set(key, recent);
      return false;
    }
    recent.push(now);
    this.activity.set(key, recent);
    return true;
  }

  forget(key: string): void { this.activity.delete(key); }
}
