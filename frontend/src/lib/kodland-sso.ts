export class KodlandLoginError extends Error {
  constructor(public readonly status: number) { super("Falha no login Kodland."); }
}

export async function loginKodland(username: string, password: string, signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(8000);
  const response = await fetch("https://sso.production.kodland.org/login", {
    method: "POST", redirect: "error", cache: "no-store", credentials: "omit",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: username.trim(), password }),
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new KodlandLoginError(response.status);
  }
  const payload = await response.json();
  if (typeof payload?.access_token !== "string" || !payload.access_token) throw new KodlandLoginError(502);
  return payload.access_token as string;
}
