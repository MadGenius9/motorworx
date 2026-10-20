import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { GameController } from './game/GameController';
import './styles.css';

const controller = new GameController();
controller.start();
// Debug handle for the browser console and automated play-tests.
(window as unknown as { motorworx: GameController }).motorworx = controller;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App controller={controller} />
  </StrictMode>,
);
