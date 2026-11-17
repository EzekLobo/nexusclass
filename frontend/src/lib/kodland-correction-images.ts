import "server-only";
import { Resolver } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { correctionError } from "./correction-validation";

const maxBytes = 2 * 1024 * 1024;
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) blocked.addSubnet(address, prefix);

export function matchesKodlandImage(mime: string, bytes: Buffer): boolean {
  switch (mime) {
    case "image/png": return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) && bytes.toString("ascii", 12, 16) === "IHDR";
    case "image/jpeg": return bytes.length >= 5 && bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")) && bytes.subarray(-2).equals(Buffer.from("ffd9", "hex"));
    case "image/webp": return bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16));
    default: return false;
  }
}

export async function downloadKodlandImage(value: string, signal: AbortSignal) {
  const hosts = (process.env.KODLAND_CORRECTION_IMAGE_HOSTS ?? "").split(",").map(host => host.trim().toLowerCase()).filter(Boolean);
  const rejected = () => correctionError(422, "kodland_image_host", "O host do anexo ainda não está autorizado para correção. Abra a entrega na Kodland.");
  const failed = () => correctionError(502, "kodland_image_download", "Não foi possível ler a imagem da Kodland. Tente gerar novamente.");
  const invalid = () => correctionError(422, "kodland_image_format", "O anexo excede 2 MiB ou não é uma imagem PNG, JPEG ou WebP válida.");
  let url: URL;
  try { url = new URL(value); } catch { throw rejected(); }
  if (url.protocol !== "https:" || url.port || url.username || url.password || isIP(url.hostname) || !hosts.includes(url.hostname)) throw rejected();

  const deadline = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
  const resolver = new Resolver({ timeout: 1500, tries: 1 });
  const stop = () => resolver.cancel();
  deadline.throwIfAborted();
  deadline.addEventListener("abort", stop, { once: true });
  let addresses: string[];
  try { addresses = await resolver.resolve4(url.hostname); } catch { throw failed(); }
  finally { deadline.removeEventListener("abort", stop); }
  const address = addresses[0];
  if (!address || addresses.some(ip => isIP(ip) !== 4 || blocked.check(ip))) throw rejected();

  return new Promise<{ mimeType: string; data: string }>((resolve, reject) => {
    // Pin the vetted address while preserving TLS hostname verification and SNI.
    const req = request({
      hostname: address, servername: url.hostname, path: url.pathname + url.search,
      agent: false, signal: deadline, headers: { host: url.hostname, accept: "image/png, image/jpeg, image/webp" },
    }, response => {
      const mimeType = response.headers["content-type"]?.split(";")[0].trim().toLowerCase() ?? "";
      if (response.statusCode !== 200) { reject(failed()); response.destroy(); return; }
      if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType) || Number(response.headers["content-length"]) > maxBytes) {
        reject(invalid()); response.destroy(); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("error", () => reject(failed()));
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { reject(invalid()); response.destroy(); return; }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        if (!matchesKodlandImage(mimeType, bytes)) { reject(invalid()); return; }
        resolve({ mimeType, data: bytes.toString("base64") });
      });
    });
    req.on("error", () => reject(failed()));
    req.end();
  });
}
