import { authenticatedUser } from "@/lib/server-auth";
import { disconnectSlack, slackStatus } from "@/lib/slack-server";
import { slackHttpError, slackJson } from "@/lib/slack-http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { return slackJson(await slackStatus((await authenticatedUser(request)).uid)); } catch (error) { return slackHttpError(error); }
}
export async function DELETE(request: Request) {
  try { return slackJson(await disconnectSlack((await authenticatedUser(request)).uid)); } catch (error) { return slackHttpError(error); }
}
