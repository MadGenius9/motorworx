import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { sound } from '../audio/sound';
import { BALANCE } from '../config/balance';
import type { SimSpeed } from '../game/types';
import { yardCapacity } from '../sim/selectors';
import type { GameState } from '../sim/types';
import { Bar, ConfirmDialog } from './common';
import { formatDuration, formatMoney, formatTime } from './format';
import { NewGameDialog } from './NewGameDialog';
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

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <path d="M3 7.5h3l4-3.5v12l-4-3.5H3z" fill="currentColor" />
      {muted ? (
        <path d="M13 7.5l4.5 5M17.5 7.5l-4.5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      ) : (
        <>
          <path d="M12.8 7.2a4 4 0 0 1 0 5.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
          <path d="M15 5a7 7 0 0 1 0 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
        </>
      )}
    </svg>
  );
}

const subscribeSound = (fn: () => void) => sound.subscribe(fn);
const soundSnapshot = () => `${sound.muted}|${sound.volume}`;

/** Mute toggle + volume slider (slider hidden on narrow screens). Settings persist in localStorage. */
function SoundControl() {
  useSyncExternalStore(subscribeSound, soundSnapshot, soundSnapshot);
  if (!sound.supported) return null;
  const muted = sound.muted;
  return (
    <div className="tb-sound">
      <button
        type="button"
        className={`btn btn-ghost icon-btn tb-sound-btn${muted ? ' is-muted' : ''}`}
        aria-pressed={!muted}
        aria-label={muted ? 'Sound off — turn sound on' : 'Sound on — mute'}
        title={muted ? 'Sound off' : 'Sound on'}
        onClick={() => {
          sound.setMuted(!muted);
          if (muted) sound.play('uiClick');
        }}
      >
        <SpeakerIcon muted={muted} />
      </button>
      <input
        type="range"
        className="tb-volume"
        min={0}
        max={100}
        step={5}
        value={muted ? 0 : Math.round(sound.volume * 100)}
        aria-label="Sound volume"
        title="Volume"
        onChange={(e) => sound.setVolume(Number(e.target.value) / 100)}
        onPointerUp={() => sound.play('coinSoft')}
      />
    </div>
  );
}

export function TopBar() {
  const { controller, state, dispatch } = useUi();
  const [confirmNew, setConfirmNew] = useState(false);
  const [openMenu, setOpenMenu] = useState<'load' | 'more' | null>(null);
  const menuOpen = openMenu !== null;
  const [pendingLoad, setPendingLoad] = useState<{ key: string; label: string } | null>(null);
  const [slotsTick, setSlotsTick] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  // Refresh slot info periodically (autosaves happen in the controller).
  useEffect(() => {
    const id = window.setInterval(() => setSlotsTick((t) => t + 1), 10_000);
    return () => window.clearInterval(id);
  }, []);
  const slots = useMemo(() => controller.listSaveSlots(), [controller, slotsTick, menuOpen]);
  const usable = slots.filter((s) => s.time !== null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || moreRef.current?.contains(t)) return;
      setOpenMenu(null);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [menuOpen]);

  const cashNeg = state.cash < 0;
  const graceLeft =
    state.insolventSince !== null
      ? state.insolventSince + BALANCE.finance.insolvencyGraceMinutes - state.time
      : null;
  const yardCap = yardCapacity(state);
  const paused = controller.paused;

  const slotItems = (
    <>
      {slots.map((s) => (
        <button
          key={s.key}
          type="button"
          role="menuitem"
          className="menu-item"
          disabled={s.time === null}
          onClick={() => {
            setOpenMenu(null);
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
    </>
  );
  const doSave = () => {
    controller.saveManual(); // controller shows the result toast
    setSlotsTick((t) => t + 1);
  };

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
          aria-label={paused ? 'Resume' : 'Pause'}
          disabled={state.gameOver}
        >
          {paused ? '▶' : '❚❚'}
          <span className="btn-label"> {paused ? 'Resume' : 'Pause'}</span>
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
        <SoundControl />
        <span className="tb-sep tb-wide" />

        {state.tutorial.dismissed && (
          <button
            type="button"
            className="btn btn-ghost icon-btn tb-wide"
            title="Show tutorial"
            aria-label="Show tutorial"
            onClick={() => dispatch({ type: 'showTutorial' })}
          >
            ?
          </button>
        )}
        <button type="button" className="btn btn-default tb-wide" onClick={doSave}>
          Save
        </button>
        <div className="menu-wrap tb-wide" ref={menuRef}>
          <button
            type="button"
            className="btn btn-default"
            disabled={usable.length === 0}
            title={usable.length === 0 ? 'No saved games yet' : 'Load a saved game'}
            aria-expanded={openMenu === 'load'}
            onClick={() => setOpenMenu((m) => (m === 'load' ? null : 'load'))}
          >
            Load ▾
          </button>
          {openMenu === 'load' && (
            <div className="menu" role="menu">
              {slotItems}
            </div>
          )}
        </div>
        <button type="button" className="btn btn-default tb-wide" onClick={() => setConfirmNew(true)}>
          New Game
        </button>
        {/* Narrow screens: Save / Load / New Game / tutorial live in one overflow menu. */}
        <div className="menu-wrap tb-narrow" ref={moreRef}>
          <button
            type="button"
            className="btn btn-default icon-btn tb-more-btn"
            aria-label="Game menu"
            aria-haspopup="menu"
            aria-expanded={openMenu === 'more'}
            onClick={() => setOpenMenu((m) => (m === 'more' ? null : 'more'))}
          >
            ⋯
          </button>
          {openMenu === 'more' && (
            <div className="menu" role="menu">
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setOpenMenu(null);
                  doSave();
                }}
              >
                <span>Save game</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setOpenMenu(null);
                  setConfirmNew(true);
                }}
              >
                <span>New game…</span>
              </button>
              {state.tutorial.dismissed && (
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    setOpenMenu(null);
                    dispatch({ type: 'showTutorial' });
                  }}
                >
                  <span>Show tutorial</span>
                </button>
              )}
              <div className="menu-label">Load</div>
              {slotItems}
            </div>
          )}
        </div>
      </div>

      {confirmNew && (
        <NewGameDialog
          onCancel={() => setConfirmNew(false)}
          onStart={(scenario) => {
            setConfirmNew(false);
            controller.newGame(scenario);
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
