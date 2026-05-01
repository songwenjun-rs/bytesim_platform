// All API calls go through Vite proxy → BFF (port 8080) → run-svc (port 8081).
// In production, set VITE_BFF_URL at build time.
//
// Slice-15: every request carries the JWT (Authorization) and the active
// project id (X-Project-ID). Token + active project live in localStorage so
// they survive a page refresh; a 401 anywhere clears state and bounces to
// /login. WS connects via wsURL() — same origin, server reads ?token=.

const BASE = "";

const TOKEN_KEY = "bytesim.jwt";
const PROJECT_KEY = "bytesim.project";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getProject(): string | null {
  return localStorage.getItem(PROJECT_KEY);
}

export function setSession(token: string, project: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(PROJECT_KEY, project);
}

export function setProject(project: string): void {
  localStorage.setItem(PROJECT_KEY, project);
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(PROJECT_KEY);
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  const t = getToken();
  if (t) h["Authorization"] = `Bearer ${t}`;
  const p = getProject();
  if (p) h["X-Project-ID"] = p;
  return h;
}

function handle401(r: Response): void {
  // No /login screen anymore — clearing the bad token lets main.tsx's
  // bootstrapAuth refetch on next reload. We don't redirect.
  if (r.status === 401) clearSession();
}

export async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!r.ok) {
    handle401(r);
    throw new Error(`${r.status} ${r.statusText} @ ${path}`);
  }
  return r.json() as Promise<T>;
}

export async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) {
    handle401(r);
    throw new Error(`${r.status} ${await r.text()} @ ${path}`);
  }
  return r.json() as Promise<T>;
}

export function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...(init.headers as Record<string, string> | undefined), ...authHeaders() };
  return fetch(`${BASE}${path}`, { ...init, headers }).then((r) => {
    if (r.status === 401) handle401(r);
    return r;
  });
}

export function wsURL(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const sep = path.includes("?") ? "&" : "?";
  const t = getToken();
  const tokenQs = t ? `${sep}token=${encodeURIComponent(t)}` : "";
  return `${proto}://${window.location.host}${path}${tokenQs}`;
}
