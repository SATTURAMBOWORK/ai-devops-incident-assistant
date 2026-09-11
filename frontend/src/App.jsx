import { Link, NavLink, Route, Routes } from 'react-router';
import AnalyzePage from './pages/AnalyzePage.jsx';
import HistoryPage from './pages/HistoryPage.jsx';
import IncidentPage from './pages/IncidentPage.jsx';

// The frame every page shares (top bar), plus which URL shows which page.
export default function App() {
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link className="brand" to="/">
            Incident Assistant
          </Link>
          <nav className="nav" aria-label="Main">
            {/* `end` so "Analyze" is not also highlighted on /incidents. */}
            <NavLink className="nav-link" to="/" end>
              Analyze
            </NavLink>
            <NavLink className="nav-link" to="/incidents">
              History
            </NavLink>
          </nav>
        </div>
      </header>

      <main className="page">
        <Routes>
          <Route path="/" element={<AnalyzePage />} />
          <Route path="/incidents" element={<HistoryPage />} />
          <Route path="/incidents/:id" element={<IncidentPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </>
  );
}

function NotFound() {
  return (
    <div className="empty">
      <p className="empty-text">There is no page at this address.</p>
      <Link className="button" to="/">
        Analyze logs
      </Link>
    </div>
  );
}
