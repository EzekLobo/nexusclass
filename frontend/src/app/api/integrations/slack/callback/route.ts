import { finishSlackOAuth, slackConfig, slackCookie } from "@/lib/slack-server";
import { slackHttpError } from "@/lib/slack-http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  let origin: string;
  try { origin = new URL(slackConfig().redirectUri).origin; } catch (error) { return slackHttpError(error); }
  const url = new URL(request.url);
  const browser = (request.headers.get("cookie") ?? "").split(";").map((value) => value.trim()).find((value) => value.startsWith(`${slackCookie}=`))?.slice(slackCookie.length + 1) ?? "";
  let status = "error";
  try {
    await finishSlackOAuth(url.searchParams.get("state") ?? "", browser, url.searchParams.has("error") ? null : url.searchParams.get("code"));
    status = "connected";
  } catch { /* No provider payload or OAuth query is logged or reflected. */ }
  return new Response(null, { status: 303, headers: {
    location: `${origin}/settings/slack?slack=${status}`, "cache-control": "no-store", "referrer-policy": "no-referrer",
    "set-cookie": `${slackCookie}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  } });
}
