export interface HealthSnapshot {
  ok: boolean;
  status: 'starting' | 'ready' | 'draining';
  uptimeSeconds: number;
  rooms: number;
  connections: number;
  now: number;
}

export class OperationalState {
  private ready = false;
  private draining = false;

  constructor(private readonly startedAt = Date.now()) {}

  markReady(): void { if (!this.draining) this.ready = true; }
  beginShutdown(): boolean {
    if (this.draining) return false;
    this.draining = true; this.ready = false; return true;
  }
  isReady(): boolean { return this.ready && !this.draining; }
  isDraining(): boolean { return this.draining; }
  snapshot(rooms: number, connections: number, now = Date.now()): HealthSnapshot {
    return { ok: this.isReady(), status: this.draining ? 'draining' : this.ready ? 'ready' : 'starting', uptimeSeconds: Math.max(0, Math.floor((now - this.startedAt) / 1_000)), rooms, connections, now };
  }
}
