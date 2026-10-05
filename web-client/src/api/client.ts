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

async function check(res: Response): Promise<void> {
  if (res.status === 401) redirectToLogin();
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
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
