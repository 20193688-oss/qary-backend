const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3000';

let accessToken: string | null = null;
export function setAccessToken(t: string | null) {
  accessToken = t;
  if (t) localStorage.setItem('qary_access', t);
  else localStorage.removeItem('qary_access');
}
export function getAccessToken(): string | null {
  if (accessToken) return accessToken;
  const fromLs = localStorage.getItem('qary_access');
  if (fromLs) accessToken = fromLs;
  return accessToken;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json');
  const tok = getAccessToken();
  if (tok && !headers.has('authorization')) headers.set('authorization', `Bearer ${tok}`);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`api ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}
