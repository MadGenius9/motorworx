import { useCallback, useEffect, useRef, useState } from 'react';
import type { IGameController } from './game/types';
import { FactoryCanvas } from './render/FactoryCanvas';
import type { Command, CommandResult } from './sim/commandTypes';
import type { AlertAction, PanelTab } from './sim/selectors';
import type { StationId } from './sim/types';
import { AlertBar } from './ui/AlertBar';
import { Celebrations } from './ui/Celebrations';
import { isTypingTarget } from './ui/format';
import { GameOverModal } from './ui/GameOverModal';
import { VictoryModal } from './ui/VictoryModal';
import { PlantSwitcher } from './ui/PlantSwitcher';
import { SidePanel } from './ui/SidePanel';
import { StationPanel } from './ui/StationPanel';
import { Toasts, type UiToast } from './ui/Toasts';
import { TopBar } from './ui/TopBar';
import { TutorialCard } from './ui/TutorialCard';
import { UiContext, useControllerVersion, type UiApi } from './ui/useGame';

const TOAST_MS = 3500;

export default function App({ controller }: { controller: IGameController }) {
  const version = useControllerVersion(controller);
  const state = controller.state;
  const [tab, setTab] = useState<PanelTab>('orders');
  const [selected, setSelected] = useState<StationId | null>(null);
  const [plantIdx, setPlantIdx] = useState(0);
  const plant = Math.min(plantIdx, state.plants.length - 1);
  const selectPlant = useCallback((p: number) => {
    setPlantIdx(p);
    setSelected(null);
  }, []);
  const [toasts, setToasts] = useState<UiToast[]>([]);
  // Show the victory screen once, when the goal is reached during play (not when loading a won game).
  const [showVictory, setShowVictory] = useState(false);
  const seenWin = useRef<{ state: unknown; wonAt: number | null }>({ state, wonAt: state.goals.wonAt });
  useEffect(() => {
    const prev = seenWin.current;
    if (prev.state === state && prev.wonAt === null && state.goals.wonAt !== null) setShowVictory(true);
    seenWin.current = { state, wonAt: state.goals.wonAt };
  });
  const toastId = useRef(0);

  const notify = useCallback((text: string, ok: boolean) => {
    const id = ++toastId.current;
    setToasts((ts) => [...ts.filter((t) => t.text !== text), { id, text, ok }].slice(-4));
    window.setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), ok ? TOAST_MS : TOAST_MS + 1500);
  }, []);

  const dispatch = useCallback(
    (cmd: Command): CommandResult => {
      // The controller toasts failures itself; we surface confirmation messages.
      const r = controller.dispatch(cmd);
      if (r.ok && r.message) notify(r.message, true);
      return r;
    },
    [controller, notify],
  );

  const runAction = useCallback(
    (a: AlertAction) => {
      if (a.kind === 'openTab') setTab(a.tab);
      else if (a.kind === 'openStation') {
        setPlantIdx(a.plant ?? 0);
        setSelected(a.station);
      }
      else dispatch(a.command);
    },
    [dispatch],
  );

  // The controller clears its own toast after a few seconds.
  const visibleCtoast = controller.toast;

  // A new game / load replaces the state object; close any station drawer.
  const lastState = useRef(state);
  useEffect(() => {
    if (lastState.current !== state) {
      lastState.current = state;
      setSelected(null);
      setPlantIdx(0);
    }
  }, [state]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector('.modal-backdrop')) return;
      if (e.key === 'Escape') {
        setSelected(null);
        return;
      }
      if (controller.state.gameOver) return;
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        controller.togglePause();
      } else if (e.key === '1') controller.setSpeed(1);
      else if (e.key === '2') controller.setSpeed(2);
      else if (e.key === '3') controller.setSpeed(4);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller]);

  const api: UiApi = {
    controller,
    state,
    version,
    dispatch,
    runAction,
    openTab: setTab,
    selectStation: setSelected,
    selectedStation: selected,
    plant,
    selectPlant,
    notify,
  };

  return (
    <UiContext.Provider value={api}>
      <div className="app">
        <TopBar />
        <AlertBar />
        <main className="main">
          <div className="canvas-area">
            <div className="canvas-host">
              <FactoryCanvas
                controller={controller}
                plant={plant}
                selectedStation={selected}
                onSelectStation={setSelected}
                onOpenTab={setTab}
              />
            </div>
            <PlantSwitcher />
            {selected && <StationPanel id={selected} onClose={() => setSelected(null)} />}
            <TutorialCard />
          </div>
          <SidePanel tab={tab} />
        </main>
        <Toasts controllerToast={visibleCtoast} local={toasts} />
        <Celebrations />
        {state.gameOver && <GameOverModal />}
        {showVictory && !state.gameOver && <VictoryModal onClose={() => setShowVictory(false)} />}
      </div>
    </UiContext.Provider>
  );
}
