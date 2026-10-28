import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { LegalPage } from './components/LegalPage';
import { SatoshiActivityPage } from './components/SatoshiActivityPage';
import { usePathname } from './lib/router';
import './styles.css';

function Root() {
  const path = usePathname();
  if (path === '/satoshi-activity') return <SatoshiActivityPage />;
  if (path === '/terms' || path === '/privacy') return <LegalPage />;
  return <App />;
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root element');

createRoot(rootEl).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
