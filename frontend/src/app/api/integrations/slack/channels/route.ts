import { authenticatedUser } from "@/lib/server-auth";
import { listSlackChannels, selectSlackChannels } from "@/lib/slack-server";
import { slackChannelBody, slackHttpError, slackJson } from "@/lib/slack-http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { return slackJson(await listSlackChannels((await authenticatedUser(request)).uid, new URL(request.url).searchParams.get("cursor") ?? "")); } catch (error) { return slackHttpError(error); }
}
export async function PUT(request: Request) {
  try {
    const user = await authenticatedUser(request);
    return slackJson(await selectSlackChannels(user.uid, await slackChannelBody(request)));
  } catch (error) { return slackHttpError(error); }
}
