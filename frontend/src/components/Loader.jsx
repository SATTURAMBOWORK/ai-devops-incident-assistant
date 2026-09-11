// A spinner with a message. role="status" makes screen readers announce the
// message, since the spinner itself is only visual.
export default function Loader({ label = 'Loading…' }) {
  return (
    <div className="loader" role="status">
      <span className="loader-ring" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
