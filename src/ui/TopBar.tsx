import { useEffect, useMemo, useRef, useState } from 'react';
import { BALANCE } from '../config/balance';
import type { SimSpeed } from '../game/types';
import { yardCapacity } from '../sim/selectors';
import type { GameState } from '../sim/types';
import { Bar, ConfirmDialog } from './common';
import { formatDuration, formatMoney, formatTime } from './format';
import { useUi } from './useGame';

const WIP_STAGES = new Set(['stamping', 'body', 'paint', 'final', 'inspection', 'rework']);

export function wipCount(state: GameState): number {
  let n = 0;
  for (const v of Object.values(state.vehicles)) if (WIP_STAGES.has(v.stage)) n++;
  return n;
}

export function Wordmark() {
  return (
    <div className="brand" aria-label="MotorWorx Tycoon">
      <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
        <path d="M4 24 L10 8 H15 L12 16 L19 8 H25 L18 24 H13 L16 16 L9 24 Z" fill="#f07c1e" />
        <rect x="21" y="20" width="8" height="4" rx="1" fill="#8a939c" />
      </svg>
      <span className="brand-text">
        Motor<b>Worx</b>
        <small>TYCOON</small>
      </span>
    </div>
  );
}

export function TopBar() {
  const { controller, state, dispatch } = useUi();
  const [confirmNew, setConfirmNew] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  const [pendingLoad, setPendingLoad] = useState<{ key: string; label: string } | null>(null);
  const [slotsTick, setSlotsTick] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  // Refresh slot info periodically (autosaves happen in the controller).
  useEffect(() => {
    const id = window.setInterval(() => setSlotsTick((t) => t + 1), 10_000);
    return () => window.clearInterval(id);
  }, []);
  const slots = useMemo(() => controller.listSaveSlots(), [controller, slotsTick, loadOpen]);
  const usable = slots.filter((s) => s.time !== null);

  useEffect(() => {
    if (!loadOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setLoadOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [loadOpen]);

  const cashNeg = state.cash < 0;
  const graceLeft =
    state.insolventSince !== null
      ? state.insolventSince + BALANCE.finance.insolvencyGraceMinutes - state.time
      : null;
  const yardCap = yardCapacity(state);
  const paused = controller.paused;

  return (
    <header className="topbar">
      <Wordmark />

      <div className="tb-stats">
        <div className={`tb-stat${cashNeg ? ' tb-bad' : ''}`}>
          <span className="tb-label">Cash</span>
          <span className="tb-value num">{formatMoney(state.cash)}</span>
          {graceLeft !== null && (
            <span className="tb-sub tone-bad num">Insolvent in {formatDuration(Math.max(0, graceLeft))}</span>
          )}
        </div>
        <div className="tb-stat">
          <span className="tb-label">Time</span>
          <span className="tb-value num">{formatTime(state.time)}</span>
        </div>
        <div className="tb-stat tb-rep">
          <span className="tb-label">Reputation</span>
          <span className="tb-value num">{Math.round(state.reputation)}</span>
          <Bar
            value={state.reputation}
            max={100}
            color={state.reputation < 30 ? 'var(--red)' : state.reputation < 55 ? 'var(--amber)' : 'var(--green)'}
            height={4}
          />
        </div>
        <div className="tb-stat">
          <span className="tb-label">Production</span>
          <span className="tb-value num tb-prod">
            <span title="Vehicles in progress">WIP {wipCount(state)}</span>
            <span title="Finished vehicles in yard / yard capacity" className={state.yard.length >= yardCap ? 'tone-warn' : ''}>
              Yard {state.yard.length}/{yardCap}
            </span>
            <span title="Vehicles completed today">Today {state.stats.builtToday}</span>
          </span>
        </div>
      </div>

      <div className="tb-controls">
        <div className={`sim-state${paused ? ' is-paused' : ''}`} aria-live="polite">
          {paused ? 'PAUSED' : 'RUNNING'}
        </div>
        <button
          type="button"
          className={`btn ${paused ? 'btn-primary' : 'btn-default'} btn-pause`}
          onClick={() => controller.togglePause()}
          title="Space"
          disabled={state.gameOver}
        >
          {paused ? '▶ Resume' : '❚❚ Pause'}
        </button>
        <div className="segmented" role="group" aria-label="Simulation speed">
          {BALANCE.time.speeds.map((s, i) => (
            <button
              key={s}
              type="button"
              className={controller.speed === s ? 'active' : ''}
              aria-pressed={controller.speed === s}
              title={`Speed ${s}× (key ${i + 1})`}
              onClick={() => controller.setSpeed(s as SimSpeed)}
            >
              {s}×
            </button>
          ))}
        </div>

        <span className="tb-sep" />

        {state.tutorial.dismissed && (
          <button
            type="button"
            className="btn btn-ghost icon-btn"
            title="Show tutorial"
            aria-label="Show tutorial"
            onClick={() => dispatch({ type: 'showTutorial' })}
          >
            ?
          </button>
        )}
        <button
          type="button"
          className="btn btn-default"
          onClick={() => {
            controller.saveManual(); // controller shows the result toast
            setSlotsTick((t) => t + 1);
          }}
        >
          Save
        </button>
        <div className="menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="btn btn-default"
            disabled={usable.length === 0}
            title={usable.length === 0 ? 'No saved games yet' : 'Load a saved game'}
            aria-expanded={loadOpen}
            onClick={() => setLoadOpen((o) => !o)}
          >
            Load ▾
          </button>
          {loadOpen && (
            <div className="menu" role="menu">
              {slots.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  disabled={s.time === null}
                  onClick={() => {
                    setLoadOpen(false);
                    setPendingLoad({ key: s.key, label: s.label });
                  }}
                >
                  <span>{s.label}</span>
                  <span className="muted num">
                    {s.time === null ? 'Empty' : formatTime(s.time)}
                    {s.savedAtIso && (
                      <small> · {new Date(s.savedAtIso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</small>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="btn btn-default" onClick={() => setConfirmNew(true)}>
          New Game
        </button>
      </div>

      {confirmNew && (
        <ConfirmDialog
          title="Start a new game?"
          message={<p>Your current factory will be replaced by a fresh start. Save first if you want to keep it.</p>}
          confirmLabel="Start new game"
          danger
          onCancel={() => setConfirmNew(false)}
          onConfirm={() => {
            setConfirmNew(false);
            controller.newGame();
          }}
        />
      )}
      {pendingLoad && (
        <ConfirmDialog
          title="Load saved game?"
          message={<p>Load “{pendingLoad.label}”? Unsaved progress in the current game will be lost.</p>}
          confirmLabel="Load"
          onCancel={() => setPendingLoad(null)}
          onConfirm={() => {
            controller.loadSlot(pendingLoad.key); // controller shows the result toast
            setPendingLoad(null);
          }}
        />
      )}
    </header>
  );
}
