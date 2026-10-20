import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { GameController } from './game/GameController';
import './styles.css';

const controller = new GameController();
controller.start();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App controller={controller} />
  </StrictMode>,
);
