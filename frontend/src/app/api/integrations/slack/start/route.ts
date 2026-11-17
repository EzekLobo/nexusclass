import { authenticatedUser } from "@/lib/server-auth";
import { beginSlackOAuth, slackCookie } from "@/lib/slack-server";
import { slackHttpError, slackJson } from "@/lib/slack-http";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const result = await beginSlackOAuth((await authenticatedUser(request)).uid);
    return slackJson({ url: result.url }, 200, { "set-cookie": `${slackCookie}=${result.browser}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600` });
  } catch (error) { return slackHttpError(error); }
}
