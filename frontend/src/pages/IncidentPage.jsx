import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { getIncident } from '../services/api.js';
import Loader from '../components/Loader.jsx';
import { formatDate, sentenceCase } from '../utils/format.js';

const METRIC_LABELS = {
  cpuUsage: ['CPU', '%'],
  memoryUsage: ['Memory', '%'],
  requestCount: ['Requests', ''],
  errorRate: ['Error rate', '%'],
};

// What the colored band at the top says, and which color it uses.
function headerState(incident) {
  if (incident.status === 'completed') {
    const severity = incident.analysis.severity;
    return { text: `${sentenceCase(severity)} severity`, className: `sev-${severity.toLowerCase()}` };
  }
  if (incident.status === 'failed') {
    return { text: 'Analysis failed', className: 'sev-failed' };
  }
  return { text: 'Analysis in progress', className: '' };
}

export default function IncidentPage() {
  const { id } = useParams();
  const [incident, setIncident] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let ignore = false;
    setIncident(null);
    setError(null);

    getIncident(id)
      .then((data) => !ignore && setIncident(data))
      .catch((err) => !ignore && setError(err));

    return () => {
      ignore = true;
    };
  }, [id]);

  if (error) {
    const notFound = error.status === 404 || error.status === 400;
    return (
      <div>
        <Link className="back-link" to="/incidents">
          Back to history
        </Link>
        <div className="alert" role="alert">
          <p className="alert-title">
            {notFound ? 'This incident does not exist' : 'The incident could not be loaded'}
          </p>
          <p className="alert-text">
            {notFound ? 'The link may be wrong, or the incident was deleted.' : error.message}
          </p>
        </div>
      </div>
    );
  }

  if (!incident) {
    return <Loader label="Loading incident…" />;
  }

  const header = headerState(incident);
  const { analysis } = incident;
  const metrics = Object.entries(incident.metrics ?? {}).filter(([key]) => METRIC_LABELS[key]);
  const logLines = incident.logs.split('\n').length;

  return (
    <article>
      <Link className="back-link" to="/incidents">
        Back to history
      </Link>

      <header className={`incident-header ${header.className}`}>
        <p className="incident-severity">{header.text}</p>
        <h1 className="incident-title">{incident.title}</h1>
        <dl className="meta">
          <div>
            <dt>Reported</dt>
            <dd>{formatDate(incident.createdAt)}</dd>
          </div>
          {incident.durationMs != null && (
            <div>
              <dt>Analysis took</dt>
              <dd>{(incident.durationMs / 1000).toFixed(1)} s</dd>
            </div>
          )}
          {analysis && (
            <div>
              <dt>Confidence</dt>
              <dd>{analysis.confidence}%</dd>
            </div>
          )}
        </dl>
      </header>

      {incident.status === 'failed' && (
        <div className="alert section" role="alert">
          <p className="alert-title">No analysis was produced</p>
          <p className="alert-text">
            The logs were saved, but the analysis service returned an error. Submit the logs again
            from the Analyze page.
          </p>
          {incident.error && (
            <details className="alert-details">
              <summary>Technical details</summary>
              <pre>{incident.error}</pre>
            </details>
          )}
        </div>
      )}

      {analysis && (
        <>
          <p className="lead">{analysis.summary}</p>

          <div className="incident-grid">
            <div>
              <section className="section">
                <h2 className="section-title">Root cause</h2>
                <p className="section-text">{analysis.rootCause}</p>
              </section>

              <section className="section">
                <h2 className="section-title">Evidence</h2>
                <ul className="evidence">
                  {analysis.evidence.map((line, i) => (
                    <li key={i} className="evidence-item">
                      {line}
                    </li>
                  ))}
                </ul>
              </section>

              <section className="section">
                <h2 className="section-title">Steps to fix it</h2>
                <ol className="steps">
                  {analysis.steps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              </section>
            </div>

            <aside className="aside">
              <section>
                <h2 className="aside-title">Confidence</h2>
                <div className="confidence-value">{analysis.confidence}%</div>
                <div
                  className="meter"
                  role="meter"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={analysis.confidence}
                  aria-label="Confidence"
                >
                  <span className="meter-fill" style={{ width: `${analysis.confidence}%` }} />
                </div>
                <p className="aside-note">How strongly the evidence supports the root cause.</p>
              </section>

              <section>
                <h2 className="aside-title">Runbook entries used</h2>
                {incident.retrievedDocs.length > 0 ? (
                  <ul className="matches">
                    {incident.retrievedDocs.map((doc) => (
                      <li key={doc.title} className="match">
                        <span>{doc.title}</span>
                        <span className="match-score">{Math.round(doc.score * 100)}% match</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="aside-note">
                    No runbook entry matched, so this analysis is based on the logs alone.
                  </p>
                )}
              </section>

              {metrics.length > 0 && (
                <section>
                  <h2 className="aside-title">Metrics</h2>
                  <dl className="facts">
                    {metrics.map(([key, value]) => (
                      <div key={key} style={{ display: 'contents' }}>
                        <dt>{METRIC_LABELS[key][0]}</dt>
                        <dd>
                          {value.toLocaleString()}
                          {METRIC_LABELS[key][1]}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}

              <section>
                <h2 className="aside-title">Analysis run</h2>
                <dl className="facts">
                  <dt>Model</dt>
                  <dd>{incident.model}</dd>
                  <dt>Tokens</dt>
                  <dd>{incident.tokensUsed?.toLocaleString()}</dd>
                </dl>
              </section>
            </aside>
          </div>
        </>
      )}

      <details className="logs">
        <summary>
          Original logs ({logLines} {logLines === 1 ? 'line' : 'lines'})
        </summary>
        <pre>{incident.logs}</pre>
      </details>
    </article>
  );
}
