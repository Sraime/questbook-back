import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('Pas de #root dans index.html');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
