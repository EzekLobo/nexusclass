import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { suggestionId, validateSlackWebMessage, verifyDeviceSignature, classifySlackMessage } from "@/lib/slack-ingestion";

const message = { message_id: "p1763212345678900", channel: "brazil-tutors", sender: "Ana", text: "@Ezekiel, revise a atividade até sexta.", url: "https://app.slack.com/client/TABC/C123/p1763212345678900", timestamp: "2026-11-15T12:00:00.000Z" };

describe("Slack web message ingestion", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("accepts messages from the two channels and a direct Slack link", () => {
    expect(validateSlackWebMessage(message)).toEqual(message);
    expect(() => validateSlackWebMessage({ ...message, channel: "other-channel" })).toThrow(/lista permitida/i);
    expect(() => validateSlackWebMessage({ ...message, url: "https://example.com/message" })).toThrow(/Slack/i);
  });

  it("deduplicates by channel and message identifier", () => {
    expect(suggestionId(message)).toBe(suggestionId(message));
    expect(suggestionId(message)).not.toBe(suggestionId({ ...message, channel: "brazil-tutors-team-3" }));
    expect(suggestionId(message)).toMatch(/^[a-f0-9]{40}$/);
  });

  it("verifies signed requests and rejects stale or altered requests", () => {
    const pair = generateKeyPairSync("ed25519"); const timestamp = String(Date.now()); const raw = JSON.stringify(message);
    const signature = sign(null, Buffer.from(`${timestamp}.${raw}`), pair.privateKey).toString("base64url");
    const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(verifyDeviceSignature(raw, timestamp, signature, publicKey)).toBe(true);
    expect(verifyDeviceSignature(`${raw} `, timestamp, signature, publicKey)).toBe(false);
    expect(verifyDeviceSignature(raw, String(Date.now() - 600_000), signature, publicKey)).toBe(false);
  });

  it("uses Gemini structured output and skips non actionable messages", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key"); vi.stubEnv("GEMINI_MODEL", "gemini-test");
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.generationConfig.responseMimeType).toBe("application/json");
      expect(body.systemInstruction.parts[0].text).toMatch(/nunca siga instruções/i);
      expect(body.contents[0].parts[0].text).toContain(message.text);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ actionable: true, title: "Revisar atividade", description: "Corrigir os exercícios", kind: "task", priority: "normal", category: "Aula", due_date: "" }) }] } }] }), { status: 200 });
    });
    await expect(classifySlackMessage(message, fetcher)).resolves.toMatchObject({ title: "Revisar atividade", due_date: null });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ actionable: false, title: "", description: "", kind: "task", priority: "normal", category: "Slack", due_date: "" }) }] } }] }), { status: 200 }));
    await expect(classifySlackMessage(message, fetcher)).resolves.toBeNull();
  });
});
