import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { StationId } from '../config/balance';
import type { IGameController } from '../game/types';
import type { PanelTab } from '../sim/selectors';
import { Factory3DRenderer } from '../render3d/Factory3DRenderer';
import { FactoryRenderer } from './FactoryRenderer';

type ViewMode = '3d' | '2d';

/** What both renderers offer the canvas component. */
interface FactoryView {
  start(): void;
  destroy(): void;
  resize(w: number, h: number): void;
  setSelected(id: StationId | null): void;
  setPlant(plant: number): void;
  zoomBy(f: number): void;
  resetView(): void;
}

const VIEW_KEY = 'motorworx-view-mode';

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

function initialMode(): ViewMode {
  if (!webglAvailable()) return '2d';
  try {
    return localStorage.getItem(VIEW_KEY) === '2d' ? '2d' : '3d';
  } catch {
    return '3d';
  }
}

export interface FactoryCanvasProps {
  controller: IGameController;
  selectedStation: StationId | null;
  /** Plant to show (default 0). */
  plant?: number;
  onSelectStation(id: StationId | null): void;
  onOpenTab(tab: PanelTab): void;
}

const containerStyle: CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  minHeight: 0,
  overflow: 'hidden',
  background: '#1b1d20',
};

const canvasStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  display: 'block',
  touchAction: 'none',
  userSelect: 'none',
};

const controlsStyle: CSSProperties = {
  position: 'absolute',
  right: 10,
  bottom: 10,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  zIndex: 2,
};

const btnStyle: CSSProperties = {
  width: 30,
  height: 30,
  border: '1px solid #3a3f45',
  borderRadius: 6,
  background: 'rgba(36,39,43,0.92)',
  color: '#e6e8ea',
  font: '600 16px system-ui, -apple-system, "Segoe UI", sans-serif',
  lineHeight: '28px',
  padding: 0,
  cursor: 'pointer',
};

const hintStyle: CSSProperties = {
  position: 'absolute',
  left: 10,
  bottom: 10,
  font: '500 11px system-ui, -apple-system, "Segoe UI", sans-serif',
  color: 'rgba(230,232,234,0.55)',
  pointerEvents: 'none',
  zIndex: 1,
};

/** Full-size factory view. Fills its parent; the parent must have a definite height. */
export function FactoryCanvas(props: FactoryCanvasProps) {
  const { controller, selectedStation } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<FactoryView | null>(null);
  const [mode, setMode] = useState<ViewMode>(initialMode);
  const [canWebgl] = useState(webglAvailable);
  const [coarse] = useState(() => {
    try {
      return window.matchMedia('(pointer: coarse)').matches;
    } catch {
      return false;
    }
  });
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const callbacks = {
      onSelectStation: (id: StationId | null) => propsRef.current.onSelectStation(id),
      onOpenTab: (tab: PanelTab) => propsRef.current.onOpenTab(tab),
    };
    let renderer: FactoryView;
    try {
      renderer = mode === '3d' ? new Factory3DRenderer(canvas, controller, callbacks) : new FactoryRenderer(canvas, controller, callbacks);
    } catch (err) {
      // WebGL context creation can still fail (blocked GPU, lost context): fall back to the 2D view.
      console.warn('3D view unavailable, using 2D:', err);
      if (mode === '3d') setMode('2d');
      return;
    }
    rendererRef.current = renderer;
    renderer.setSelected(propsRef.current.selectedStation);
    renderer.setPlant(propsRef.current.plant ?? 0);
    const measure = () => {
      const r = container.getBoundingClientRect();
      renderer.resize(r.width, r.height);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    renderer.start();
    return () => {
      ro.disconnect();
      renderer.destroy();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [controller, mode]);

  useEffect(() => {
    rendererRef.current?.setSelected(selectedStation);
  }, [selectedStation]);

  const plant = props.plant ?? 0;
  useEffect(() => {
    rendererRef.current?.setPlant(plant);
  }, [plant]);

  return (
    <div ref={containerRef} style={containerStyle} className="factory-canvas">
      {/* A fresh canvas per mode: a canvas can't switch between WebGL and 2D contexts. */}
      <canvas key={mode} ref={canvasRef} style={canvasStyle} aria-label="Factory floor view" />
      <div style={controlsStyle} className="fc-controls">
        <button type="button" style={btnStyle} className="fc-btn" title="Zoom in" aria-label="Zoom in" onClick={() => rendererRef.current?.zoomBy(1.25)}>
          +
        </button>
        <button type="button" style={btnStyle} className="fc-btn" title="Zoom out" aria-label="Zoom out" onClick={() => rendererRef.current?.zoomBy(0.8)}>
          −
        </button>
        <button
          type="button"
          style={{ ...btnStyle, fontSize: 13 }}
          className="fc-btn"
          title="Fit whole factory"
          aria-label="Reset view"
          onClick={() => rendererRef.current?.resetView()}
        >
          ⤢
        </button>
        {canWebgl && (
          <button
            type="button"
            style={{ ...btnStyle, fontSize: 11, fontWeight: 800 }}
            className="fc-btn"
            title={mode === '3d' ? 'Switch to the flat 2D plan view' : 'Switch to the 3D view'}
            aria-label={mode === '3d' ? 'Switch to 2D view' : 'Switch to 3D view'}
            onClick={() => {
              const next: ViewMode = mode === '3d' ? '2d' : '3d';
              setMode(next);
              try {
                localStorage.setItem(VIEW_KEY, next);
              } catch {
                /* storage unavailable: the choice lasts for this session */
              }
            }}
          >
            {mode === '3d' ? '2D' : '3D'}
          </button>
        )}
      </div>
      {mode === '3d' && (
        <div style={hintStyle} className="fc-hint">
          {coarse ? 'Drag to pan · pinch to zoom · twist to rotate' : 'Drag to pan · right-drag to rotate · wheel to zoom'}
        </div>
      )}
    </div>
  );
}

export default FactoryCanvas;
