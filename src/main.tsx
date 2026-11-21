import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AccountingProvider } from './context/AccountingContext';

// Register PWA service worker for offline caching & installability
registerSW({ immediate: true });

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <AccountingProvider>
      <App />
    </AccountingProvider>
  </ErrorBoundary>
);
