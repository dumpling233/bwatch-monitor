import React from 'react';
import { createRoot } from 'react-dom/client';
import { MultiviewPanel } from './multiview/MultiviewPanel';
import { LocalLoginProvider } from './multiview/useLocalLogin';
import './style.css';
import './modern.css';

createRoot(document.getElementById('root')!).render(
  <main className="monitor-app"><LocalLoginProvider><MultiviewPanel /></LocalLoginProvider></main>
);

import './standalone.css';
