// The only file that talks to the backend. Pages call these functions and get
// plain data back, or an ApiError with a readable message.

// Empty in development: requests go to /api on the Vite dev server, which
// proxies them to the backend (see vite.config.js), so there is no CORS setup.
// Set VITE_API_BASE_URL at build time when the API lives on another origin.
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

// Keeps the backend's error `code` (VALIDATION_ERROR, ANALYSIS_FAILED, ...) so
// a page can decide how to explain the problem, not just print the message.
export class ApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(`${BASE_URL}/api${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch {
    throw new ApiError('Cannot reach the server. Check that the backend is running.', {
      code: 'NETWORK_ERROR',
    });
  }

  // Every backend response is { success, data } or { success: false, error }.
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    throw new ApiError(body?.error?.message ?? `Request failed with status ${res.status}`, {
      status: res.status,
      code: body?.error?.code,
    });
  }
  return body.data;
}

export function createIncident(input) {
  return request('/incidents', { method: 'POST', body: JSON.stringify(input) });
}

export function listIncidents({ page = 1, limit = 10 } = {}) {
  return request(`/incidents?page=${page}&limit=${limit}`);
}

export function getIncident(id) {
  return request(`/incidents/${id}`);
}
