import { correctionRoute } from "@/lib/correction-http";
export const runtime = "nodejs";
export async function POST(request: Request) { return correctionRoute(request, "approve"); }
