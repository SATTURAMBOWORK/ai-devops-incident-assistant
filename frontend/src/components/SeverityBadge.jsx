import { sentenceCase } from '../utils/format.js';

// A small colored pill for LOW / MEDIUM / HIGH / CRITICAL. The color comes from
// the `sev-*` class in index.css, the same tokens the incident header uses.
export default function SeverityBadge({ severity }) {
  if (!severity) {
    return <span className="badge">None</span>;
  }

  return <span className={`badge sev-${severity.toLowerCase()}`}>{sentenceCase(severity)}</span>;
}
