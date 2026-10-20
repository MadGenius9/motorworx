import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { StationId } from '../config/balance';
import type { IGameController } from '../game/types';
import type { PanelTab } from '../sim/selectors';
import { FactoryRenderer } from './FactoryRenderer';

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

/** Full-size factory view. Fills its parent; the parent must have a definite height. */
export function FactoryCanvas(props: FactoryCanvasProps) {
  const { controller, selectedStation } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<FactoryRenderer | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const renderer = new FactoryRenderer(canvas, controller, {
      onSelectStation: (id) => propsRef.current.onSelectStation(id),
      onOpenTab: (tab) => propsRef.current.onOpenTab(tab),
    });
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
  }, [controller]);

  useEffect(() => {
    rendererRef.current?.setSelected(selectedStation);
  }, [selectedStation]);

  const plant = props.plant ?? 0;
  useEffect(() => {
    rendererRef.current?.setPlant(plant);
  }, [plant]);

  return (
    <div ref={containerRef} style={containerStyle} className="factory-canvas">
      <canvas ref={canvasRef} style={canvasStyle} aria-label="Factory floor view" />
      <div style={controlsStyle}>
        <button type="button" style={btnStyle} title="Zoom in" aria-label="Zoom in" onClick={() => rendererRef.current?.zoomBy(1.25)}>
          +
        </button>
        <button type="button" style={btnStyle} title="Zoom out" aria-label="Zoom out" onClick={() => rendererRef.current?.zoomBy(0.8)}>
          −
        </button>
        <button
          type="button"
          style={{ ...btnStyle, fontSize: 13 }}
          title="Fit whole factory"
          aria-label="Reset view"
          onClick={() => rendererRef.current?.resetView()}
        >
          ⤢
        </button>
      </div>
    </div>
  );
}

export default FactoryCanvas;
