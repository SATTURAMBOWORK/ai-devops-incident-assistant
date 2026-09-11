import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App.jsx';
import './styles/index.css';

// Entry point: find <div id="root"> in index.html and render the app into it.
// BrowserRouter keeps the URL and the page in sync (/, /incidents, /incidents/:id).
// StrictMode runs extra checks in development only; it does nothing in production.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
