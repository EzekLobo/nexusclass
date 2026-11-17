import { correctionRoute } from "@/lib/correction-http";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) { return correctionRoute(request, "suggest"); }
