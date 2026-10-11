import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { BrandingProvider } from './branding';
import './styles.css';
import { applyTheme, savedTheme } from './theme';

applyTheme(savedTheme());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrandingProvider>
      <BrowserRouter basename="/app">
        <App />
      </BrowserRouter>
    </BrandingProvider>
  </React.StrictMode>,
);
