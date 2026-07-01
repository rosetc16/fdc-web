import './storage.js';          // installs window.storage (localStorage-backed) before App loads
import '@tabler/icons-webfont/dist/tabler-icons.min.css'; // bundle icons locally (no slow CDN fetch)
import './index.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
