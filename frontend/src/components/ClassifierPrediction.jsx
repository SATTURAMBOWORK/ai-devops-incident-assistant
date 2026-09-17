// Shows what our own trained classifier (ml/) predicted for an incident.
//
// It sits next to the LLM's analysis rather than inside it: the two are
// separate opinions, and seeing them side by side is the point.

// The classifier returns runbook ids ('oom-killed'); people read titles.
// Mirrors backend/src/knowledge/runbook.js. If a new category is added there
// and not here, the fallback below still shows something readable.
const CATEGORY_TITLES = {
  'oom-killed': 'Container killed: out of memory',
  'db-connection-refused': 'Database connection failure',
  'disk-full': 'Disk space exhausted',
  'port-in-use': 'Port already in use',
  'crash-loop': 'Application crash loop on startup',
  'ssl-cert-expired': 'SSL/TLS certificate problem',
  'high-latency': 'High latency and request timeouts',
  'error-rate-spike': 'Spike in 5xx errors after a deployment',
  'dns-resolution-failure': 'DNS resolution failure',
  'permission-denied': 'Permission denied',
  'missing-config': 'Missing configuration or dependency',
  'too-many-open-files': 'Too many open files',
  'auth-brute-force': 'Brute-force login attempts',
};

// 'some-new-label' -> 'Some new label'
function categoryTitle(label) {
  if (CATEGORY_TITLES[label]) return CATEGORY_TITLES[label];
  const words = label.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// The backend stores confidence as 0-1; the rest of the page speaks in percent.
const toPercent = (value) => Math.round(value * 100);

export default function ClassifierPrediction({ classification, retrievedDocs }) {
  // The backend leaves this field out when the ML service was down, too unsure,
  // or the logs looked healthy. That is a normal outcome, not an error, so say
  // it plainly.
  if (!classification?.label) {
    return (
      <section>
        <h2 className="aside-title">ML prediction</h2>
        <p className="aside-note">
          No prediction: the classifier was unavailable, or found no pattern it recognises
          with enough confidence.
        </p>
      </section>
    );
  }

  const title = categoryTitle(classification.label);
  const percent = toPercent(classification.confidence);

  // Does our model agree with the top runbook entry retrieval found? Two
  // independent methods landing on the same answer is worth pointing out; a
  // disagreement is worth a second look.
  const topDoc = retrievedDocs?.[0]?.title;
  const agrees = topDoc ? topDoc === title : null;

  return (
    <section>
      <h2 className="aside-title">ML prediction</h2>
      <p className="section-text">{title}</p>
      <div className="confidence-value">{percent}%</div>
      <div
        className="meter"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="Classifier confidence"
      >
        <span className="meter-fill" style={{ width: `${percent}%` }} />
      </div>

      {agrees !== null && (
        <p className="aside-note">
          {agrees
            ? 'Agrees with the top runbook match.'
            : `Differs from the top runbook match (${topDoc}).`}
        </p>
      )}

      {/* The model returns one answer, but real incidents often have two true
          causes - a crash loop caused by missing config is both. The runner-up
          is worth reading, so it is labelled rather than left as a bare list. */}
      {classification.alternatives?.length > 0 && (
        <div className="alternatives">
          <h3 className="alternatives-title">Also possible</h3>
          <ul className="matches">
            {classification.alternatives.map((alt) => (
              <li key={alt.label} className="match">
                <span>{categoryTitle(alt.label)}</span>
                <span className="match-score">{toPercent(alt.confidence)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {classification.modelVersion && (
        <p className="aside-note model-version">Model {classification.modelVersion}</p>
      )}
    </section>
  );
}
