import { correctionRoute } from "@/lib/correction-http";
export const runtime = "nodejs";
type Context = { params: Promise<{ suggestionId: string }> };
export async function GET(request: Request, context: Context) { return correctionRoute(request, "get", (await context.params).suggestionId); }
export async function DELETE(request: Request, context: Context) { return correctionRoute(request, "discard", (await context.params).suggestionId); }
