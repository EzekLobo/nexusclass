import { correctionRoute } from "@/lib/correction-http";
export const runtime = "nodejs";
export async function DELETE(request: Request) { return correctionRoute(request, "cleanup"); }
export async function POST(request: Request) { return correctionRoute(request, "finish_reset"); }
