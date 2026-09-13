// Log only explicit context, never request headers, query strings, or bodies.
function redact(value, env) {
  let text = String(value);
  for (const [key, secret] of Object.entries(env)) {
    if (/secret|token|password|key/i.test(key) && typeof secret === 'string' && secret) {
      text = text.replaceAll(secret, '[redacted]');
    }
  }
  return text
    .replace(/https?:\/\/[^\s"'<>]+/g, url => url.split(/[?#]/)[0])
    .replace(/\b(Bearer|Bot)\s+[^\s,;"']+/gi, '$1 [redacted]')
    .replace(/\b(code|state|access_token|refresh_token|client_secret|csrf|thelab_\w+)\s*[=:]\s*[^\s&,;"']+/gi, '$1=[redacted]')
    .slice(0, 4000);
}

function details(error, env, depth = 0) {
  if (!(error instanceof Error)) return { name: 'NonErrorThrown' };
  return {
    name: redact(error.name, env),
    message: redact(error.message, env),
    stack: typeof error.stack === 'string' ? redact(error.stack, env) : undefined,
    ...(depth < 3 && error.cause ? { cause: details(error.cause, env, depth + 1) } : {}),
  };
}

export function requestContext(request) {
  return { request_id: crypto.randomUUID(), method: request.method, path: new URL(request.url).pathname };
}

export function logError(event, error, context = {}, env = {}) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const errorID = error?.errorId || crypto.randomUUID();
  if (error instanceof Error) error.errorId = errorID;
  const entry = { event, ...context, error_id: errorID, status, retry_after: error?.retryAfter || 0, error: details(error, env) };
  // JSON gives both Wrangler tail and Workers Logs searchable, consistent fields.
  console[status >= 500 ? 'error' : 'warn'](JSON.stringify(entry));
  return errorID;
}
