import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { listIncidents } from '../services/api.js';
import SeverityBadge from '../components/SeverityBadge.jsx';
import Loader from '../components/Loader.jsx';
import { formatDate } from '../utils/format.js';

const PAGE_SIZE = 10;

const STATUS_LABELS = { completed: 'Completed', failed: 'Failed', pending: 'Analyzing' };

export default function HistoryPage() {
  // The page number lives in the URL (?page=2), so back/forward and shared
  // links land on the same page.
  const [searchParams, setSearchParams] = useSearchParams();
  const page = Math.max(1, Number(searchParams.get('page')) || 1);

  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    // If the page changes before the request finishes, ignore the old response
    // so it cannot overwrite the newer one.
    let ignore = false;
    setResult(null);
    setError(null);

    listIncidents({ page, limit: PAGE_SIZE })
      .then((data) => !ignore && setResult(data))
      .catch((err) => !ignore && setError(err));

    return () => {
      ignore = true;
    };
  }, [page]);

  const goToPage = (next) => setSearchParams(next === 1 ? {} : { page: String(next) });

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">History</h1>
        {result && result.total > 0 && (
          <span className="pagination-status">
            {result.total} {result.total === 1 ? 'incident' : 'incidents'}
          </span>
        )}
      </div>

      {error && (
        <div className="alert" role="alert">
          <p className="alert-title">History could not be loaded</p>
          <p className="alert-text">{error.message}</p>
        </div>
      )}

      {!result && !error && <Loader label="Loading incidents…" />}

      {result && result.total === 0 && (
        <div className="empty">
          <p className="empty-text">No incidents yet. Analyzed logs show up here.</p>
          <Link className="button" to="/">
            Analyze logs
          </Link>
        </div>
      )}

      {result && result.items.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Severity</th>
                  <th scope="col">Incident</th>
                  <th scope="col">Status</th>
                  <th scope="col">Reported</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((incident) => (
                  <tr key={incident._id}>
                    <td>
                      <SeverityBadge severity={incident.analysis?.severity} />
                    </td>
                    <td>
                      <Link className="incident-link" to={`/incidents/${incident._id}`}>
                        {incident.title}
                      </Link>
                      {incident.analysis?.summary && (
                        <p className="row-summary">{incident.analysis.summary}</p>
                      )}
                    </td>
                    <td className={`status status-${incident.status}`}>
                      {STATUS_LABELS[incident.status] ?? incident.status}
                    </td>
                    <td className="cell-date">{formatDate(incident.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {result.totalPages > 1 && (
            <nav className="pagination" aria-label="Pages">
              <button
                type="button"
                className="button button-quiet"
                onClick={() => goToPage(page - 1)}
                disabled={page <= 1}
              >
                Newer
              </button>
              <span className="pagination-status">
                Page {page} of {result.totalPages}
              </span>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => goToPage(page + 1)}
                disabled={page >= result.totalPages}
              >
                Older
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
