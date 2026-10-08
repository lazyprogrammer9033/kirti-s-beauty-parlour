// Thin wrapper around fetch for the JSON API.

export class ApiError extends Error {
  constructor(status, data) {
    super((data && data.error) || 'Request failed');
    this.status = status;
    this.data = data || {};
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);

async function request(method, url, body, extraHeaders = {}) {
  const headers = { Accept: 'application/json', ...extraHeaders };
  if (method !== 'GET') headers['X-Salon-Request'] = '1';
  let payload;
  if (body instanceof Blob || body instanceof ArrayBuffer) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch('/api' + url, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, { error: 'Cannot reach the salon app. Check the Wi-Fi connection and that the main computer is on.' });
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json() : null;
  if (res.status === 401 && !url.startsWith('/auth/')) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b = {}, h) => request('POST', u, b, h),
  put: (u, b = {}) => request('PUT', u, b),
  del: (u) => request('DELETE', u),
};

// Downloads a file from a GET endpoint (works in Safari and Chrome).
export function download(url) {
  const a = document.createElement('a');
  a.href = '/api' + url;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}
