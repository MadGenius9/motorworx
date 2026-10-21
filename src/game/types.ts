import type { ScenarioId } from '../config/balance';
import type { Command, CommandResult } from '../sim/commandTypes';
import type { GameState } from '../sim/types';

export type SimSpeed = 1 | 2 | 4;

export interface SaveSlotInfo {
  key: string;
  label: string;
  /** Game time of the save, or null if the slot is empty. */
  time: number | null;
  savedAtIso: string | null;
}

/**
 * Owns the GameState, runs the fixed-timestep loop, and notifies React.
 * Implemented in src/game/GameController.ts.
 */
export interface IGameController {
  /** Current state object. Replaced (new identity) on load/new game; otherwise mutated in place by ticks. */
  readonly state: GameState;
  readonly paused: boolean;
  readonly speed: SimSpeed;
  /** Fraction (0..1) of the next tick already accumulated; renderer uses it for smooth animation. */
  readonly tickFraction: number;
  /** Increments whenever state changes in a way the UI should reflect (throttled to ~8 Hz while running). */
  readonly version: number;
  subscribe(listener: () => void): () => void;
  dispatch(cmd: Command): CommandResult;
  setPaused(paused: boolean): void;
  togglePause(): void;
  setSpeed(speed: SimSpeed): void;
  /** Advance by real elapsed seconds (called by the rAF loop; also usable in tests). */
  advanceRealTime(dtSeconds: number): void;
  start(): void;
  stop(): void;
  saveManual(): CommandResult;
  loadSlot(key: string): CommandResult;
  listSaveSlots(): SaveSlotInfo[];
  /** Resets to a fresh game in a scenario (default 'standard'; UI must confirm before calling). */
  newGame(scenario?: ScenarioId): void;
  /** Short-lived message for the UI (e.g. result of a command or save). */
  readonly toast: { id: number; text: string; ok: boolean } | null;
}
