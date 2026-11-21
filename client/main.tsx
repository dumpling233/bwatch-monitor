import React from 'react';
import { createRoot } from 'react-dom/client';
import { MultiviewPanel } from './multiview/MultiviewPanel';
import { LocalLoginProvider } from './multiview/useLocalLogin';
import { trackScrollbarGutter } from './scrollbarGutter';
import './style.css';
import './modern.css';
import './ui-scroll.css';
import './standalone.css';

trackScrollbarGutter();
createRoot(document.getElementById('root')!).render(
  <main className="monitor-app"><LocalLoginProvider><MultiviewPanel /></LocalLoginProvider></main>
);
