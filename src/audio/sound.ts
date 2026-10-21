/**
 * Tiny synthesized sound effects (Web Audio API, no audio files).
 *
 * The AudioContext is created lazily on the first user gesture (browsers block autoplay) and every
 * call is a no-op when Web Audio is unavailable. Settings (muted, volume) persist in localStorage.
 */
import type { EventTag } from '../sim/types';

export type SoundName =
  | 'coin'
  | 'coinSoft'
  | 'bell'
  | 'chord'
  | 'alarm'
  | 'arpeggio'
  | 'fanfare'
  | 'bigFanfare'
  | 'warning'
  | 'click'
  | 'uiClick';

export interface SoundSettings {
  muted: boolean;
  /** 0..1 */
  volume: number;
}

const STORAGE_KEY = 'motorworx-sound';
const DEFAULT_SETTINGS: SoundSettings = { muted: false, volume: 0.5 };

/** Which sound each event tag plays (untagged events are silent). */
export const TAG_SOUNDS: Record<EventTag, SoundName> = {
  paid: 'coin',
  sale: 'coinSoft',
  offer: 'bell',
  delivered: 'chord',
  breakdown: 'alarm',
  research: 'arpeggio',
  plant: 'arpeggio',
  milestone: 'fanfare',
  victory: 'bigFanfare',
  incident: 'warning',
  strike: 'warning',
  loan: 'click',
};

/** Minimum real-time gap (ms) between two plays of the same sound. */
const MIN_GAP_MS: Partial<Record<SoundName, number>> = {
  coinSoft: 1500,
  coin: 300,
  bell: 400,
  chord: 400,
  alarm: 800,
  arpeggio: 500,
  warning: 800,
  click: 200,
  uiClick: 40,
};

/** Louder sounds win when several events arrive in the same frame. */
const PRIORITY: Record<SoundName, number> = {
  bigFanfare: 10,
  fanfare: 9,
  alarm: 8,
  warning: 7,
  chord: 6,
  arpeggio: 5,
  coin: 4,
  bell: 3,
  click: 2,
  coinSoft: 1,
  uiClick: 0,
};

function readSettings(): SoundSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<SoundSettings>;
      return {
        muted: typeof p.muted === 'boolean' ? p.muted : DEFAULT_SETTINGS.muted,
        volume: typeof p.volume === 'number' && Number.isFinite(p.volume) ? Math.min(1, Math.max(0, p.volume)) : DEFAULT_SETTINGS.volume,
      };
    }
  } catch {
    /* storage blocked or corrupt: use defaults */
  }
  return { ...DEFAULT_SETTINGS };
}

type Ctor = typeof AudioContext;

function audioCtor(): Ctor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private failed = false;
  private settings: SoundSettings = readSettings();
  private lastPlayed = new Map<SoundName, number>();
  private listeners = new Set<() => void>();
  private unlockBound = false;

  get muted(): boolean {
    return this.settings.muted;
  }
  get volume(): number {
    return this.settings.volume;
  }
  get supported(): boolean {
    return audioCtor() !== null;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  setMuted(muted: boolean): void {
    this.settings = { ...this.settings, muted };
    this.persist();
    if (!muted) this.unlock();
  }

  setVolume(volume: number): void {
    const v = Math.min(1, Math.max(0, volume));
    // Dragging the slider to 0 mutes; any other value unmutes.
    this.settings = { volume: v, muted: v === 0 };
    this.persist();
    if (v > 0) this.unlock();
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.gainFor(v), this.ctx.currentTime, 0.02);
  }

  /** Install one-time gesture listeners that create/resume the AudioContext. */
  bindUnlock(): void {
    if (this.unlockBound || typeof window === 'undefined') return;
    this.unlockBound = true;
    const handler = () => this.unlock();
    for (const ev of ['pointerdown', 'keydown', 'touchend'] as const) {
      window.addEventListener(ev, handler, { capture: true, passive: true });
    }
    // Subtle tick for button presses.
    window.addEventListener(
      'click',
      (e) => {
        const el = e.target instanceof Element ? e.target.closest('button') : null;
        if (el && !el.disabled) this.play('uiClick');
      },
      { capture: true, passive: true },
    );
  }

  /** Create or resume the AudioContext. Call only from a user gesture. */
  unlock(): void {
    if (this.failed) return;
    try {
      if (!this.ctx) {
        const C = audioCtor();
        if (!C) {
          this.failed = true;
          return;
        }
        this.ctx = new C();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.gainFor(this.settings.volume);
        // A gentle compressor keeps stacked sounds from clipping.
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.ratio.value = 6;
        this.master.connect(comp);
        comp.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    } catch {
      this.failed = true;
      this.ctx = null;
      this.master = null;
    }
  }

  /** Play the most important of the given tags' sounds (at most one sound per call). */
  playTags(tags: Iterable<EventTag>): void {
    let best: SoundName | null = null;
    for (const t of tags) {
      const s = TAG_SOUNDS[t];
      if (!s || !this.ready(s)) continue;
      if (best === null || PRIORITY[s] > PRIORITY[best]) best = s;
    }
    if (best) this.play(best);
  }

  play(name: SoundName): void {
    if (this.settings.muted || this.settings.volume <= 0) return;
    const ctx = this.ctx;
    const out = this.master;
    if (!ctx || !out || ctx.state !== 'running') return;
    if (!this.ready(name)) return;
    this.lastPlayed.set(name, performance.now());
    try {
      RECIPES[name](ctx, out, ctx.currentTime + 0.01);
    } catch {
      /* never let audio break the game */
    }
  }

  private ready(name: SoundName): boolean {
    const gap = MIN_GAP_MS[name] ?? 0;
    const last = this.lastPlayed.get(name);
    return last === undefined || performance.now() - last >= gap;
  }

  /** Perceptual curve so the slider feels linear. */
  private gainFor(v: number): number {
    return v * v * 0.9;
  }

  private persist(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      /* storage unavailable: setting lasts for this session */
    }
    for (const l of Array.from(this.listeners)) l();
  }
}

// ─────────────── synthesis helpers ───────────────

interface ToneOpts {
  type?: OscillatorType;
  freq: number;
  /** Optional glide target frequency. */
  to?: number;
  start: number;
  dur: number;
  gain: number;
  attack?: number;
  /** Lowpass cutoff (Hz) to soften bright waveforms. */
  lp?: number;
}

function tone(ctx: AudioContext, out: AudioNode, o: ToneOpts): void {
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.freq, o.start);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, o.start + o.dur);
  const g = ctx.createGain();
  const attack = o.attack ?? 0.005;
  g.gain.setValueAtTime(0.0001, o.start);
  g.gain.exponentialRampToValueAtTime(o.gain, o.start + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, o.start + o.dur);
  let node: AudioNode = osc;
  if (o.lp) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = o.lp;
    osc.connect(f);
    node = f;
  }
  node.connect(g);
  g.connect(out);
  osc.start(o.start);
  osc.stop(o.start + o.dur + 0.05);
}

/** Short filtered noise burst (cash-drawer "chk", clicks). */
function noise(ctx: AudioContext, out: AudioNode, start: number, dur: number, gain: number, freq: number): void {
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = 1.2;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(f);
  f.connect(g);
  g.connect(out);
  src.start(start);
}

const N = (semitonesFromA4: number) => 440 * Math.pow(2, semitonesFromA4 / 12);
// Handy pitches.
const C5 = N(3);
const E5 = N(7);
const G5 = N(10);
const C6 = N(15);
const E6 = N(19);
const G4 = N(-2);
const C4 = N(-9);
const E4 = N(-5);

type Recipe = (ctx: AudioContext, out: AudioNode, t: number) => void;

const RECIPES: Record<SoundName, Recipe> = {
  // Cash register: drawer "chk" + two bright bell partials.
  coin: (ctx, out, t) => {
    noise(ctx, out, t, 0.05, 0.25, 2500);
    tone(ctx, out, { type: 'triangle', freq: N(26), start: t + 0.03, dur: 0.18, gain: 0.22 });
    tone(ctx, out, { type: 'triangle', freq: N(31), start: t + 0.1, dur: 0.45, gain: 0.2 });
    tone(ctx, out, { type: 'sine', freq: N(43), start: t + 0.1, dur: 0.25, gain: 0.05 });
  },
  // A small, quiet coin chime for market sales.
  coinSoft: (ctx, out, t) => {
    tone(ctx, out, { type: 'triangle', freq: N(26), start: t, dur: 0.1, gain: 0.07 });
    tone(ctx, out, { type: 'triangle', freq: N(31), start: t + 0.06, dur: 0.28, gain: 0.07 });
  },
  // Soft bell: sine with an inharmonic overtone.
  bell: (ctx, out, t) => {
    tone(ctx, out, { freq: E5, start: t, dur: 0.9, gain: 0.16, attack: 0.004 });
    tone(ctx, out, { freq: E5 * 2.76, start: t, dur: 0.35, gain: 0.04 });
  },
  // Positive major chord, lightly strummed.
  chord: (ctx, out, t) => {
    [C5, E5, G5, C6].forEach((f, i) =>
      tone(ctx, out, { type: 'triangle', freq: f, start: t + i * 0.035, dur: 0.75, gain: 0.09, attack: 0.01, lp: 3200 }),
    );
  },
  // Two-tone alarm buzz (short so it isn't grating).
  alarm: (ctx, out, t) => {
    for (let i = 0; i < 3; i++) {
      tone(ctx, out, { type: 'square', freq: i % 2 ? 392 : 523, start: t + i * 0.14, dur: 0.12, gain: 0.06, lp: 1600 });
    }
  },
  // Rising arpeggio.
  arpeggio: (ctx, out, t) => {
    [C5, E5, G5, C6].forEach((f, i) => tone(ctx, out, { type: 'triangle', freq: f, start: t + i * 0.075, dur: 0.3, gain: 0.11, lp: 4000 }));
  },
  // Short brass-ish fanfare: G4 C5 E5 then a held G5 chord.
  fanfare: (ctx, out, t) => {
    const notes: [number, number, number][] = [
      [G4, 0, 0.12],
      [C5, 0.12, 0.12],
      [E5, 0.24, 0.12],
      [G5, 0.36, 0.7],
    ];
    for (const [f, s, d] of notes) {
      tone(ctx, out, { type: 'sawtooth', freq: f, start: t + s, dur: d, gain: 0.07, attack: 0.015, lp: 2200 });
      tone(ctx, out, { type: 'triangle', freq: f / 2, start: t + s, dur: d, gain: 0.05, attack: 0.015 });
    }
    tone(ctx, out, { type: 'triangle', freq: E5, start: t + 0.36, dur: 0.7, gain: 0.05 });
  },
  // Bigger fanfare for victory: two phrases and a full final chord with a sparkle.
  bigFanfare: (ctx, out, t) => {
    const seq: [number, number, number][] = [
      [C5, 0, 0.14],
      [C5, 0.16, 0.1],
      [C5, 0.28, 0.1],
      [E5, 0.4, 0.3],
      [C5, 0.72, 0.14],
      [E5, 0.88, 0.14],
      [G5, 1.04, 1.2],
    ];
    for (const [f, s, d] of seq) {
      tone(ctx, out, { type: 'sawtooth', freq: f, start: t + s, dur: d, gain: 0.07, attack: 0.015, lp: 2400 });
    }
    for (const f of [C4, E4, G4, C5]) tone(ctx, out, { type: 'triangle', freq: f, start: t + 1.04, dur: 1.4, gain: 0.06, attack: 0.03 });
    [C6, E6, G5 * 2, C6 * 2].forEach((f, i) => tone(ctx, out, { freq: f, start: t + 1.1 + i * 0.06, dur: 0.4, gain: 0.03 }));
  },
  // Low warning tone: falling minor second.
  warning: (ctx, out, t) => {
    tone(ctx, out, { type: 'sawtooth', freq: 196, start: t, dur: 0.32, gain: 0.08, attack: 0.02, lp: 700 });
    tone(ctx, out, { type: 'sawtooth', freq: 185, to: 160, start: t + 0.3, dur: 0.45, gain: 0.08, attack: 0.02, lp: 600 });
  },
  // Neutral click (loan).
  click: (ctx, out, t) => {
    noise(ctx, out, t, 0.03, 0.18, 1800);
    tone(ctx, out, { freq: 660, start: t, dur: 0.07, gain: 0.07 });
  },
  // Very subtle UI tick.
  uiClick: (ctx, out, t) => {
    tone(ctx, out, { type: 'triangle', freq: 1400, to: 900, start: t, dur: 0.035, gain: 0.035 });
  },
};

export const sound = new SoundEngine();
