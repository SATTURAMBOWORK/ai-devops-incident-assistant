// Small display helpers shared by several pages and components.

// "2026-09-10T10:02:11.000Z" -> "Sep 10, 2026, 3:32 PM", in the viewer's own
// locale and time zone.
export function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value)
  );
}

// "HIGH" -> "High". Sentence case reads calmer than shouting capitals.
export function sentenceCase(word) {
  return word.charAt(0) + word.slice(1).toLowerCase();
}
