export type GameSound = 'join' | 'start' | 'turn' | 'chat' | 'close' | 'correct' | 'tick' | 'round-end' | 'victory' | 'mint-success' | 'ui';

class GameAudio {
  private context: AudioContext | null = null;
  private muted = localStorage.getItem('arena-muted') === 'true';
  private volume = Number(localStorage.getItem('arena-volume') ?? .45);

  isMuted(): boolean { return this.muted; }
  getVolume(): number { return Number.isFinite(this.volume) ? Math.max(0, Math.min(1, this.volume)) : .45; }
  setMuted(value: boolean): void { this.muted = value; localStorage.setItem('arena-muted', String(value)); }
  setVolume(value: number): void { this.volume = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : .45; localStorage.setItem('arena-volume', String(this.volume)); }

  async unlock(): Promise<void> {
    this.context ??= new AudioContext();
    if (this.context.state === 'suspended') await this.context.resume();
  }

  play(event: GameSound): void {
    if (this.muted) return;
    void this.unlock().then(() => {
      const context = this.context;
      if (!context) return;
      const patterns: Record<GameSound, Array<[number, number, number]>> = {
        join: [[420, .05, 0], [630, .08, .06]], start: [[220, .08, 0], [440, .09, .09], [760, .14, .19]],
        turn: [[520, .07, 0], [690, .11, .08]], chat: [[360, .035, 0]], close: [[520, .05, 0], [570, .06, .05]],
        correct: [[440, .06, 0], [660, .07, .06], [880, .14, .13]], tick: [[250, .035, 0]],
        'round-end': [[520, .08, 0], [390, .13, .09]], victory: [[392, .1, 0], [523, .1, .11], [659, .12, .22], [784, .2, .35]],
        'mint-success': [[330, .08, 0], [494, .1, .08], [659, .12, .18], [988, .24, .31]], ui: [[480, .035, 0]],
      };
      for (const [frequency, duration, delay] of patterns[event]) this.tone(context, frequency, duration, delay, event === 'tick' ? 'square' : 'sine');
    }).catch(() => undefined);
  }

  private tone(context: AudioContext, frequency: number, duration: number, delay: number, type: OscillatorType): void {
    const oscillator = context.createOscillator(); const gain = context.createGain(); const start = context.currentTime + delay;
    oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(this.getVolume() * .12, start + .008); gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
    oscillator.connect(gain).connect(context.destination); oscillator.start(start); oscillator.stop(start + duration + .02);
  }
}

export const gameAudio = new GameAudio();
