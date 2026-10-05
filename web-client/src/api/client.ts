// A 401 from /api means there is no (or no longer a) Bellhop session --
// send the browser to Bellhop's own sign-in, carrying the page it should
// come back to (#69). The login route itself lives under /auth, not /api, so
// it can never loop through here. The thrown error still stops the caller,
// since the navigation is not instantaneous.
function redirectToLogin(): never {
  const returnTo = `${location.pathname}${location.search}`;
  location.href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  throw new Error('Authentication required');
}

// A 503 with setupRequired means first-run setup is still pending (#86):
// nothing but the setup page is served, so go there.
async function check(res: Response): Promise<void> {
  if (res.status === 401) redirectToLogin();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 503 && body.setupRequired) {
      location.href = '/setup';
      throw new Error('Setup required');
    }
    throw new Error(body.error ?? res.statusText);
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  await check(res);
  return res.json();
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await check(res);
  return res.json();
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await check(res);
  return res.json();
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await check(res);
  return res.json();
}

export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`/api${path}`, { method: 'DELETE' });
  await check(res);
}
