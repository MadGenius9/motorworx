/**
 * Event-driven "feel": plays a sound for each new tagged event and shows small, non-blocking
 * celebrations (cash flourishes, milestone banner, confetti). Renders nothing interactive.
 *
 * New events are found with a watermark on the highest event id seen. A new game / load replaces
 * the state object (or makes ids go backwards); then the watermark resets without replaying the log.
 */
import { useEffect, useRef, useState } from 'react';
import { sound } from '../audio/sound';
import type { EventLogEntry, EventTag, GameState } from '../sim/types';
import { useUi } from './useGame';

const BANNER_MS = 2600;
const FLOAT_MS = 1800;
/** Ignore huge batches (e.g. a save loaded into the same state object): treat them as a reset. */
const MAX_BATCH = 40;

interface Banner {
  id: number;
  kind: 'milestone' | 'victory';
  text: string;
}

interface Flourish {
  id: number;
  text: string;
  tone: 'invoice' | 'paid';
}

function maxEventId(state: GameState): number {
  let m = -Infinity;
  for (const e of state.events) if (e.id > m) m = e.id;
  return m;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** First money amount in an event text, e.g. "$12,345" (formatMoney output). */
function moneyIn(text: string, after?: string): string | null {
  const from = after ? text.indexOf(after) : -1;
  const hay = from >= 0 ? text.slice(from) : text;
  const m = /\$[\d,]+(?:\.\d+)?/.exec(hay);
  return m ? m[0] : null;
}

// ─────────────── confetti (one throwaway canvas per burst) ───────────────

const CONFETTI_COLORS = ['#f07c1e', '#ffb05e', '#3fb950', '#3b82f6', '#e6e8ea', '#e3a008', '#e5484d'];

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  w: number;
  h: number;
  color: string;
}

export function confettiBurst(count: number, durationMs: number): void {
  if (typeof document === 'undefined' || prefersReducedMotion()) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = window.innerWidth;
  const H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  document.body.appendChild(canvas);
  ctx.scale(dpr, dpr);

  const pieces: Piece[] = [];
  // Two cannons from the lower corners plus a sprinkle from the top centre.
  for (let i = 0; i < count; i++) {
    const side = i % 3;
    const speed = 7 + Math.random() * 7;
    let x: number, y: number, ang: number;
    if (side === 0) {
      x = 0;
      y = H * 0.75;
      ang = -Math.PI / 3 + (Math.random() - 0.5) * 0.6;
    } else if (side === 1) {
      x = W;
      y = H * 0.75;
      ang = (-2 * Math.PI) / 3 + (Math.random() - 0.5) * 0.6;
    } else {
      x = W / 2 + (Math.random() - 0.5) * W * 0.5;
      y = -10;
      ang = Math.PI / 2 + (Math.random() - 0.5) * 0.8;
    }
    const sp = side === 2 ? speed * 0.35 : speed;
    pieces.push({
      x,
      y,
      vx: Math.cos(ang) * sp * (W / 900 + 0.4),
      vy: Math.sin(ang) * sp * (H / 700 + 0.3),
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      w: 5 + Math.random() * 5,
      h: 8 + Math.random() * 6,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    });
  }

  const start = performance.now();
  let last = start;
  const frame = (now: number) => {
    const t = now - start;
    const dt = Math.min(2.5, (now - last) / 16.67);
    last = now;
    ctx.clearRect(0, 0, W, H);
    const fade = t > durationMs - 600 ? Math.max(0, (durationMs - t) / 600) : 1;
    ctx.globalAlpha = fade;
    for (const p of pieces) {
      p.vy += 0.22 * dt;
      p.vx *= Math.pow(0.985, dt);
      p.vy *= Math.pow(0.985, dt);
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.scale(1, Math.cos(p.rot * 2.3));
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (t < durationMs) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

// ─────────────── component ───────────────

export function Celebrations() {
  const { state, version } = useUi();
  const mark = useRef<{ state: GameState; maxId: number } | null>(null);
  const [banners, setBanners] = useState<Banner[]>([]);
  const [flourishes, setFlourishes] = useState<Flourish[]>([]);
  /** Where cash flourishes appear: just under the top bar's Cash figure. */
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const seq = useRef(0);
  const timers = useRef<number[]>([]);

  // Gesture listeners that unlock audio; harmless to call more than once.
  useEffect(() => {
    sound.bindUnlock();
    return () => {
      for (const t of timers.current) window.clearTimeout(t);
      timers.current = [];
    };
  }, []);

  useEffect(() => {
    const m = mark.current;
    const top = maxEventId(state);
    if (!m || m.state !== state || top < m.maxId) {
      // First run, new game or load: adopt the current log silently.
      mark.current = { state, maxId: top };
      return;
    }
    if (top <= m.maxId) return;
    const fresh: EventLogEntry[] = state.events.filter((e) => e.id > m.maxId);
    m.maxId = top;
    if (fresh.length === 0 || fresh.length > MAX_BATCH) return;

    const tags: EventTag[] = [];
    for (const e of fresh) if (e.tag) tags.push(e.tag);
    if (tags.length) sound.playTags(tags);

    const later = (fn: () => void, ms: number) => {
      const id = window.setTimeout(() => {
        timers.current = timers.current.filter((x) => x !== id);
        fn();
      }, ms);
      timers.current.push(id);
    };

    for (const e of fresh) {
      if (e.tag === 'delivered' || e.tag === 'paid') {
        const amt = e.tag === 'delivered' ? moneyIn(e.text, 'invoice') : moneyIn(e.text);
        if (!amt) continue;
        const cash = document.querySelector('.topbar .tb-stat .tb-value');
        if (cash) {
          const r = cash.getBoundingClientRect();
          setAnchor({ left: Math.max(8, r.left - 10), top: r.bottom + 4 });
        }
        const id = ++seq.current;
        const f: Flourish = { id, text: e.tag === 'delivered' ? `+${amt} invoiced` : `+${amt}`, tone: e.tag === 'delivered' ? 'invoice' : 'paid' };
        setFlourishes((fs) => [...fs, f].slice(-3));
        later(() => setFlourishes((fs) => fs.filter((x) => x.id !== id)), FLOAT_MS);
      } else if (e.tag === 'milestone' || e.tag === 'victory') {
        const id = ++seq.current;
        const kind = e.tag;
        setBanners((bs) => [...bs, { id, kind, text: e.text }].slice(-2));
        later(() => setBanners((bs) => bs.filter((x) => x.id !== id)), kind === 'victory' ? BANNER_MS + 1500 : BANNER_MS);
        if (kind === 'victory') confettiBurst(260, 4200);
        else confettiBurst(110, 2500);
      }
    }
    // `version` drives re-checks: the state object is mutated in place by the sim.
  }, [state, version]);

  if (banners.length === 0 && flourishes.length === 0) return null;
  return (
    <div className="celebrations" aria-live="polite">
      {banners.map((b) => (
        <div key={b.id} className={`celebrate-banner celebrate-${b.kind}`} role="status">
          <span className="celebrate-icon" aria-hidden="true">
            {b.kind === 'victory' ? '🏆' : '★'}
          </span>
          <span className="celebrate-text">
            <b>{b.kind === 'victory' ? 'Victory!' : 'Milestone reached'}</b>
            <span>{b.text}</span>
          </span>
        </div>
      ))}
      {flourishes.length > 0 && (
        <div className="flourishes" style={anchor ?? undefined}>
          {flourishes.map((f) => (
            <div key={f.id} className={`flourish flourish-${f.tone} num`}>
              {f.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
