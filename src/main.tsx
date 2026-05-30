import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { useAutoReload } from './hooks/useAutoReload';
import './index.css';

function Root() {
  useAutoReload();
  return <App />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
