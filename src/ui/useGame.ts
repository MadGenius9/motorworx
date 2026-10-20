import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import type { IGameController } from '../game/types';
import type { Command, CommandResult } from '../sim/commandTypes';
import type { GameState, StationId } from '../sim/types';
import type { AlertAction, PanelTab } from '../sim/selectors';

/** Re-renders the caller whenever controller.version changes. */
export function useControllerVersion(controller: IGameController): number {
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
  const getVersion = useCallback(() => controller.version, [controller]);
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

export interface UiApi {
  controller: IGameController;
  state: GameState;
  version: number;
  /** Dispatch a command; failures (and confirmation messages) are shown as toasts. */
  dispatch(cmd: Command): CommandResult;
  runAction(action: AlertAction): void;
  openTab(tab: PanelTab): void;
  selectStation(id: StationId | null): void;
  selectedStation: StationId | null;
  notify(text: string, ok: boolean): void;
}

export const UiContext = createContext<UiApi | null>(null);

export function useUi(): UiApi {
  const api = useContext(UiContext);
  if (!api) throw new Error('useUi must be used inside <UiContext.Provider>');
  return api;
}
