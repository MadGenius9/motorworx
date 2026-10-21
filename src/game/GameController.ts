/**
 * GameController — owns the GameState, runs the fixed-timestep simulation loop,
 * handles saving/loading and notifies React subscribers.
 *
 * The simulation itself is pure (src/sim); this class only decides *when* to step it.
 */
import { BALANCE } from '../config/balance';
import { applyCommand } from '../sim/commands';
import type { Command, CommandResult } from '../sim/commandTypes';
import { step } from '../sim/engine';
import { createInitialState } from '../sim/initialState';
import type { ScenarioId } from '../config/balance';
import { deserialize, serialize } from '../sim/save';
import type { GameState } from '../sim/types';
import type { IGameController, SaveSlotInfo, SimSpeed } from './types';

/** Minimal subset of the Web Storage API the controller needs (lets tests inject a fake). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface GameControllerOptions {
  /** Storage to use; defaults to window.localStorage when available. `null` disables persistence. */
  storage?: StorageLike | null;
  /** Load the autosave on construction (default true). */
  autoLoad?: boolean;
  /** Seed for fresh games (default: createInitialState's default seed). */
  seed?: number;
}

/** What we write to storage. `state` is the string produced by sim/save.serialize. */
interface SaveWrapper {
  format: 'motorworx-save';
  savedAtIso: string;
  time: number;
  state: string;
}

const MAX_FRAME_SECONDS = 0.25;
const NOTIFY_INTERVAL_SECONDS = 0.125; // ~8 Hz while ticking
const TOAST_SECONDS = 3;

function defaultStorage(): StorageLike | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    // Access to localStorage can throw (privacy mode, sandboxed iframes).
  }
  return null;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export class GameController implements IGameController {
  private _state: GameState;
  private _paused = false;
  private _speed: SimSpeed = 1;
  private _tickFraction = 0;
  private _version = 0;
  private _toast: { id: number; text: string; ok: boolean } | null = null;

  private readonly listeners = new Set<() => void>();
  private readonly storage: StorageLike | null;
  private readonly seed: number | undefined;

  private accumulator = 0;
  private sinceNotify = 0;
  private sinceAutosave = 0;
  private dirtyForNotify = false;
  private toastSeq = 0;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  private rafId: number | null = null;
  private lastFrameTs: number | null = null;
  private running = false;

  /** Total simulation ticks executed by this controller (diagnostics/tests). */
  ticksRun = 0;

  constructor(options: GameControllerOptions = {}) {
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.seed = options.seed;
    let loaded: GameState | null = null;
    if (options.autoLoad !== false) {
      const raw = this.readStorage(BALANCE.save.autosaveKey);
      if (raw) {
        try {
          loaded = this.parseSave(raw);
        } catch (err) {
          loaded = null;
          this.showToast(`Autosave could not be loaded (${errorText(err)}). Started a new game.`, false);
        }
      }
    }
    this._state = loaded ?? createInitialState(this.seed);
  }

  // ---------------------------------------------------------------- getters

  get state(): GameState {
    return this._state;
  }
  get paused(): boolean {
    return this._paused;
  }
  get speed(): SimSpeed {
    return this._speed;
  }
  get tickFraction(): number {
    return this._tickFraction;
  }
  get version(): number {
    return this._version;
  }
  get toast(): { id: number; text: string; ok: boolean } | null {
    return this._toast;
  }

  // ---------------------------------------------------------------- subscriptions

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    this._version++;
    this.sinceNotify = 0;
    this.dirtyForNotify = false;
    for (const l of Array.from(this.listeners)) {
      try {
        l();
      } catch (err) {
        // A broken listener must not stop the game loop.
        console.error('GameController listener failed', err);
      }
    }
  }

  // ---------------------------------------------------------------- commands

  dispatch(cmd: Command): CommandResult {
    let result: CommandResult;
    try {
      result = applyCommand(this._state, cmd);
    } catch (err) {
      result = { ok: false, message: `Command failed: ${errorText(err)}` };
    }
    if (!result.ok) this.showToast(result.message ?? 'That action is not possible right now.', false);
    this.notify();
    return result;
  }

  setPaused(paused: boolean): void {
    if (this._paused === paused) return;
    this._paused = paused;
    this.notify();
  }

  togglePause(): void {
    this.setPaused(!this._paused);
  }

  setSpeed(speed: SimSpeed): void {
    if (!(BALANCE.time.speeds as readonly number[]).includes(speed)) return;
    if (this._speed === speed) return;
    this._speed = speed;
    this.notify();
  }

  // ---------------------------------------------------------------- loop

  advanceRealTime(dtSeconds: number): void {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
    const dt = Math.min(dtSeconds, MAX_FRAME_SECONDS);
    if (this._paused || this._state.gameOver) return;

    this.accumulator += dt * this._speed * BALANCE.time.ticksPerSecondAt1x;
    let ticks = Math.floor(this.accumulator);
    if (ticks > BALANCE.time.maxTicksPerFrame) {
      ticks = BALANCE.time.maxTicksPerFrame;
      this.accumulator = this.accumulator - Math.floor(this.accumulator); // drop the backlog
    } else {
      this.accumulator -= ticks;
    }

    let becameGameOver = false;
    for (let i = 0; i < ticks; i++) {
      step(this._state);
      this.ticksRun++;
      this.dirtyForNotify = true;
      if (this._state.gameOver) {
        becameGameOver = true;
        this.accumulator = 0;
        break;
      }
    }
    this._tickFraction = this._state.gameOver ? 0 : Math.min(Math.max(this.accumulator, 0), 0.999999);

    // Autosave on real time while running.
    this.sinceAutosave += dt;
    if (this.sinceAutosave >= BALANCE.save.autosaveRealSeconds) {
      this.sinceAutosave = 0;
      this.autosave();
    }

    this.sinceNotify += dt;
    if (becameGameOver) {
      this.autosave();
      this.notify();
    } else if (this.dirtyForNotify && this.sinceNotify >= NOTIFY_INTERVAL_SECONDS) {
      this.notify();
    }
  }

  start(): void {
    if (this.running) return;
    if (typeof requestAnimationFrame === 'undefined') return;
    this.running = true;
    this.lastFrameTs = null;
    const frame = (ts: number) => {
      if (!this.running) return;
      if (this.lastFrameTs !== null) this.advanceRealTime((ts - this.lastFrameTs) / 1000);
      this.lastFrameTs = ts;
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('beforeunload', this.onBeforeUnload);
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.lastFrameTs = null;
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('beforeunload', this.onBeforeUnload);
    }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  private readonly onBeforeUnload = (): void => {
    this.autosave();
  };

  private readonly onVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      this.autosave();
    }
    // Do not count time spent hidden as a frame.
    this.lastFrameTs = null;
  };

  // ---------------------------------------------------------------- saves

  private readStorage(key: string): string | null {
    if (!this.storage) return null;
    try {
      return this.storage.getItem(key);
    } catch {
      return null;
    }
  }

  /** Returns an error message on failure, null on success. */
  private writeSave(key: string): string | null {
    if (!this.storage) return 'Saving is unavailable (browser storage is disabled).';
    let payload: string;
    try {
      const wrapper: SaveWrapper = {
        format: 'motorworx-save',
        savedAtIso: new Date().toISOString(),
        time: this._state.time,
        state: serialize(this._state),
      };
      payload = JSON.stringify(wrapper);
    } catch (err) {
      return `Could not serialize the game: ${errorText(err)}`;
    }
    try {
      this.storage.setItem(key, payload);
    } catch (err) {
      return `Browser storage refused the save (${errorText(err)}). Storage may be full or disabled.`;
    }
    return null;
  }

  /** Parses a stored save (wrapper or bare serialized state). Throws a readable Error. */
  private parseSave(raw: string): GameState {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Save data is corrupted (not valid JSON).');
    }
    if (parsed && typeof parsed === 'object' && (parsed as SaveWrapper).format === 'motorworx-save') {
      const w = parsed as SaveWrapper;
      if (typeof w.state !== 'string') throw new Error('Save data is corrupted (missing game state).');
      return deserialize(w.state);
    }
    // Bare serialized state (no wrapper).
    return deserialize(raw);
  }

  private autosave(): void {
    const err = this.writeSave(BALANCE.save.autosaveKey);
    if (err) this.showToast(`Autosave failed: ${err}`, false);
  }

  saveManual(): CommandResult {
    const err = this.writeSave(BALANCE.save.manualKey);
    const result: CommandResult = err ? { ok: false, message: `Save failed: ${err}` } : { ok: true, message: 'Game saved.' };
    this.showToast(result.message!, result.ok);
    this.notify();
    return result;
  }

  loadSlot(key: string): CommandResult {
    let result: CommandResult;
    const raw = this.readStorage(key);
    if (!raw) {
      result = { ok: false, message: 'There is no save in that slot.' };
    } else {
      try {
        const state = this.parseSave(raw);
        this.replaceState(state);
        result = { ok: true, message: 'Game loaded.' };
      } catch (err) {
        result = { ok: false, message: `Could not load save: ${errorText(err)}` };
      }
    }
    this.showToast(result.message!, result.ok);
    this.notify();
    return result;
  }

  listSaveSlots(): SaveSlotInfo[] {
    const slots: { key: string; label: string }[] = [
      { key: BALANCE.save.autosaveKey, label: 'Autosave' },
      { key: BALANCE.save.manualKey, label: 'Manual save' },
    ];
    return slots.map(({ key, label }) => {
      const info: SaveSlotInfo = { key, label, time: null, savedAtIso: null };
      const raw = this.readStorage(key);
      if (!raw) return info;
      try {
        const parsed = JSON.parse(raw) as Partial<SaveWrapper> & { time?: unknown };
        if (parsed && parsed.format === 'motorworx-save') {
          info.savedAtIso = typeof parsed.savedAtIso === 'string' ? parsed.savedAtIso : null;
          if (typeof parsed.time === 'number') info.time = parsed.time;
          else if (typeof parsed.state === 'string') {
            const s = JSON.parse(parsed.state) as { time?: unknown };
            if (typeof s.time === 'number') info.time = s.time;
          }
        } else if (parsed && typeof parsed.time === 'number') {
          info.time = parsed.time;
        }
      } catch {
        // Unreadable slot: report as empty; loadSlot will explain the error.
      }
      return info;
    });
  }

  newGame(scenario: ScenarioId = 'standard'): void {
    this.replaceState(createInitialState(this.seed, scenario));
    this._paused = false;
    const err = this.writeSave(BALANCE.save.autosaveKey);
    this.showToast(err ? `New game started, but autosave failed: ${err}` : 'New game started.', !err);
    this.notify();
  }

  private replaceState(state: GameState): void {
    this._state = state;
    this.accumulator = 0;
    this._tickFraction = 0;
    this.sinceAutosave = 0;
  }

  // ---------------------------------------------------------------- toast

  private showToast(text: string, ok: boolean): void {
    const id = ++this.toastSeq;
    this._toast = { id, text, ok };
    if (this.toastTimer !== null && typeof clearTimeout !== 'undefined') clearTimeout(this.toastTimer);
    this.toastTimer = null;
    if (typeof setTimeout !== 'undefined') {
      this.toastTimer = setTimeout(() => {
        this.toastTimer = null;
        if (this._toast && this._toast.id === id) {
          this._toast = null;
          this.notify();
        }
      }, TOAST_SECONDS * 1000);
      // Do not keep Node test processes alive for a toast.
      const t = this.toastTimer as unknown as { unref?: () => void };
      if (t && typeof t.unref === 'function') t.unref();
    }
  }
}
