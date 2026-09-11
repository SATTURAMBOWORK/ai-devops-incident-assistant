import { useState } from 'react';
import { useNavigate } from 'react-router';
import { createIncident } from '../services/api.js';
import Loader from '../components/Loader.jsx';

const MAX_LOG_CHARS = 50000; // same limit the backend validates

// One entry per metric input, so the form renders them in a loop instead of
// repeating the same markup four times.
const METRIC_FIELDS = [
  { name: 'cpuUsage', label: 'CPU (%)', max: 100 },
  { name: 'memoryUsage', label: 'Memory (%)', max: 100 },
  { name: 'requestCount', label: 'Requests', step: 1 },
  { name: 'errorRate', label: 'Error rate (%)', max: 100 },
];

const EMPTY_METRICS = { cpuUsage: '', memoryUsage: '', requestCount: '', errorRate: '' };

// Lets someone try the app without hunting for real logs.
const SAMPLE = {
  title: 'api-1 keeps restarting',
  logs: `2026-09-10T10:02:09Z api-1  GET /api/reports/export 200 8412ms
2026-09-10T10:02:11Z api-1  <--- Last few GCs --->
2026-09-10T10:02:11Z api-1  FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
2026-09-10T10:02:12Z docker  container api-1 exited with code 137
2026-09-10T10:02:15Z docker  container api-1 restarted (restart count: 4)`,
  metrics: { cpuUsage: '45', memoryUsage: '98', requestCount: '', errorRate: '12' },
};

// Explain each kind of failure in terms of what the user can do about it.
function describeError(error) {
  if (error.code === 'VALIDATION_ERROR') {
    return { title: 'Check the form', text: error.message };
  }
  if (error.code === 'ANALYSIS_FAILED' || error.code === 'EMBEDDING_FAILED') {
    return {
      title: 'The analysis service returned an error',
      text: 'This attempt is saved in History as failed. The free API tiers have per-minute limits, so try again in a minute.',
      details: error.message,
    };
  }
  return { title: 'Analysis did not start', text: error.message };
}

export default function AnalyzePage() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [logs, setLogs] = useState('');
  const [metrics, setMetrics] = useState(EMPTY_METRICS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  function updateMetric(name, value) {
    setMetrics((current) => ({ ...current, [name]: value }));
  }

  function fillSample() {
    setTitle(SAMPLE.title);
    setLogs(SAMPLE.logs);
    setMetrics(SAMPLE.metrics);
    setError(null);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    // Inputs hold strings. Send only the metrics that were filled in, as numbers.
    const filledMetrics = Object.fromEntries(
      Object.entries(metrics)
        .filter(([, value]) => value !== '')
        .map(([name, value]) => [name, Number(value)])
    );

    try {
      const incident = await createIncident({
        logs,
        ...(title.trim() && { title: title.trim() }),
        ...(Object.keys(filledMetrics).length && { metrics: filledMetrics }),
      });
      navigate(`/incidents/${incident._id}`);
    } catch (err) {
      setError(describeError(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="analyze">
      <h1 className="hero-title">What broke?</h1>
      <p className="hero-text">
        Paste logs from your app or container. You get the likely root cause, the log lines that
        point to it, and steps to fix it, based on your runbook.
      </p>

      <form className="form" onSubmit={handleSubmit}>
        <div className="field">
          <div className="field-row">
            <label className="field-label" htmlFor="logs">
              Logs
            </label>
            <button type="button" className="link-button" onClick={fillSample} disabled={submitting}>
              Use sample logs
            </button>
          </div>
          <textarea
            id="logs"
            className="textarea"
            value={logs}
            onChange={(e) => setLogs(e.target.value)}
            maxLength={MAX_LOG_CHARS}
            placeholder="2026-09-10T10:02:11Z api-1  FATAL ERROR: ..."
            spellCheck={false}
            required
            disabled={submitting}
          />
          <span className="field-hint">
            {logs.length.toLocaleString()} of {MAX_LOG_CHARS.toLocaleString()} characters. The most
            recent lines matter most.
          </span>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="title">
            Title <span className="field-hint">(optional)</span>
          </label>
          <input
            id="title"
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            placeholder="api-1 keeps restarting"
            disabled={submitting}
          />
        </div>

        <fieldset className="metrics" disabled={submitting}>
          <legend className="metrics-legend">
            Metrics at the time <span className="field-hint">(optional)</span>
          </legend>
          <div className="metrics-grid">
            {METRIC_FIELDS.map((field) => (
              <div key={field.name}>
                <label className="metric-label" htmlFor={field.name}>
                  {field.label}
                </label>
                <input
                  id={field.name}
                  className="input"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={field.max}
                  step={field.step ?? 'any'}
                  value={metrics[field.name]}
                  onChange={(e) => updateMetric(field.name, e.target.value)}
                />
              </div>
            ))}
          </div>
        </fieldset>

        {error && (
          <div className="alert" role="alert">
            <p className="alert-title">{error.title}</p>
            <p className="alert-text">{error.text}</p>
            {error.details && (
              <details className="alert-details">
                <summary>Technical details</summary>
                <pre>{error.details}</pre>
              </details>
            )}
          </div>
        )}

        <div className="form-actions">
          <button type="submit" className="button" disabled={submitting || !logs.trim()}>
            Analyze logs
          </button>
          {submitting && <Loader label="Reading the logs and checking the runbook…" />}
        </div>
      </form>
    </div>
  );
}
