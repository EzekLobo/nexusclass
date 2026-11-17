import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const fake = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), writes: [] as string[], queue: Promise.resolve() as Promise<unknown> }));
type Row = Record<string, unknown>;
type Ref = { path: string; id?: string; collection(name: string): Collection; get(): Promise<Snapshot> };
type Snapshot = { id?: string; exists: boolean; data(): Row | undefined; ref: Ref };
type Query = { query: string; uid: string; n: number };
type Collection = { doc(id: string): Ref; where(key: string, op: string, uid: string): { limit(n: number): Query } };
type FakeTx = { getAll(...refs: Ref[]): Promise<Snapshot[]>; get(ref: Ref): Promise<Snapshot>; get(ref: Query): Promise<{ docs: Snapshot[]; size: number }>; create(ref: Ref, value: Row): void; set(ref: Ref, value: Row): void; update(ref: Ref, value: Row): void; delete(ref: Ref): void };
vi.mock("./firebase-admin", () => {
  const snap = (path: string) => ({ id: path.split("/").at(-1), exists: fake.rows.has(path), data: () => fake.rows.get(path), ref: doc(path) });
  const doc = (path: string): Ref => ({ path, id: path.split("/").at(-1), collection: (name: string) => collection(`${path}/${name}`), get: async () => snap(path) });
  const collection = (path: string): Collection => ({ doc: (id: string) => doc(`${path}/${id}`), where: (_key: string, _op: string, uid: string) => ({ limit: (n: number) => ({ query: path, uid, n }) }) });
  const db = { collection, getAll: async (...refs: Ref[]) => refs.map(r => snap(r.path)), runTransaction: (callback: (tx: FakeTx) => Promise<unknown>) => {
    const run = fake.queue.then(async () => {
      const pending: (() => void)[] = [];
      const tx = {
        getAll: async (...refs: Ref[]) => refs.map(r => snap(r.path)),
        get: async (ref: Ref | Query) => "query" in ref ? (() => { const docs = [...fake.rows.entries()].filter(([k, v]) => k.startsWith(ref.query + "/") && v.uid === ref.uid).slice(0, ref.n).map(([k]) => snap(k)); return { docs, size: docs.length }; })() : snap(ref.path),
        create: (ref: Ref, value: Row) => pending.push(() => { if (fake.rows.has(ref.path)) throw new Error("exists"); fake.rows.set(ref.path, structuredClone(value)); }),
        set: (ref: Ref, value: Row) => pending.push(() => fake.rows.set(ref.path, structuredClone(value))),
        update: (ref: Ref, value: Row) => pending.push(() => { const row = structuredClone(fake.rows.get(ref.path)!); for (const [key, v] of Object.entries(value)) { const parts = key.split("."); if (parts.length === 2) (row[parts[0]] as Row)[parts[1]] = v; else row[key] = v; } fake.rows.set(ref.path, row); fake.writes.push(ref.path); }),
        delete: (ref: Ref) => pending.push(() => fake.rows.delete(ref.path)),
      };
      const result = await callback(tx as FakeTx); pending.forEach(fn => fn()); return result;
    }); fake.queue = run.catch(() => {}); return run;
  } };
  return { getAdminDb: () => db };
});
import { buildCorrectionContext } from "./correction-context";
import { approveCorrectionSuggestion, beginCorrectionReset, correctionGenerationEpoch, deleteCorrectionSuggestions, discardCorrectionSuggestion, finishCorrectionReset, getCorrectionSuggestion, replayCorrectionSuggestion, reserveCorrectionSuggestion, saveCorrectionSuggestion } from "./correction-store";
const rubric = { guidance: "Soma", max_score: 20, precision: 1, criteria: [{ id: "one", description: "Soma", max_points: 20 }] };
const row = { class_id: "c", student_id: "s", occurrence_id: "o", description: "Somar", submission_text: "a+b", submission_complete: true, grading_rubric: rubric, status: "submitted", updated_at: "v1" };
const input = { source: "manual" as const, activity_id: "a", request_id: "request_001", expected_revision: "v1" };
const grade = { score: 15, insufficient_context: false, criteria: [{ criterion_id: "one", points: 15, justification: "Bom", evidence_refs: ["submission_1"] }], strengths: [], corrections: [], feedback: "Bom", limitations: [] };
async function draft() { const reservation = await reserveCorrectionSuggestion("u1", input); return saveCorrectionSuggestion("u1", input, reservation, buildCorrectionContext(input, row), grade, "gemini-test"); }
beforeEach(() => { fake.rows.clear(); fake.writes.length = 0; fake.queue = Promise.resolve(); fake.rows.set("users/u1/manual_activities/a", structuredClone(row)); fake.rows.set("users/u1/manual_classes/c", { student_ids: ["s"] }); fake.rows.set("users/u1/manual_students/s", {}); fake.rows.set("users/u1/manual_occurrences/o", { class_id: "c" }); });
describe("private correction persistence", () => {
  it("isolates UID reads, approvals and discard", async () => {
    const s = await draft(); const approval = { suggestion_id: s.suggestion_id, snapshot_hash: s.snapshot_hash, score: 15, feedback: "Revisto", request_id: "approval_001" };
    await expect(getCorrectionSuggestion("u2", s.suggestion_id)).rejects.toMatchObject({ status: 404 });
    await expect(approveCorrectionSuggestion("u2", approval)).rejects.toMatchObject({ status: 404 });
    await expect(discardCorrectionSuggestion("u2", s.suggestion_id)).rejects.toMatchObject({ status: 404 });
    expect((await getCorrectionSuggestion("u1", s.suggestion_id)).status).toBe("draft_ready");
  });
  it("atomically saves edited grade and makes concurrent duplicate approval harmless", async () => {
    const s = await draft(); const request = { suggestion_id: s.suggestion_id, snapshot_hash: s.snapshot_hash, score: 16.5, feedback: "Aprovado pelo tutor", request_id: "approval_001" };
    const results = await Promise.all([approveCorrectionSuggestion("u1", request), approveCorrectionSuggestion("u1", { ...request, request_id: "approval_002" })]);
    expect(results.map(r => r.status)).toEqual(["saved", "saved"]);
    expect(fake.rows.get("users/u1/manual_activities/a")).toMatchObject({ score: 16.5, max_score: 20, feedback: request.feedback, status: "corrected", correction_origin: "assistant_approved" });
    expect(fake.writes.filter(p => p === "users/u1/manual_activities/a")).toHaveLength(1);
    await expect(approveCorrectionSuggestion("u1", { ...request, score: 17 })).rejects.toMatchObject({ code: "already_approved" });
  });
  it("detects rubric/submission changes even without an updated timestamp", async () => {
    const s = await draft(); fake.rows.set("users/u1/manual_activities/a", { ...row, grading_rubric: { ...rubric, guidance: "Outra regra" } });
    await expect(approveCorrectionSuggestion("u1", { suggestion_id: s.suggestion_id, snapshot_hash: s.snapshot_hash, score: 15, feedback: "Revisto", request_id: "approval_001" })).rejects.toMatchObject({ code: "stale" });
    expect((await getCorrectionSuggestion("u1", s.suggestion_id)).status).toBe("stale");
    expect(fake.rows.get("users/u1/manual_activities/a")?.status).toBe("submitted");
  });
  it("revalidates class membership at approval", async () => {
    const s = await draft(); fake.rows.set("users/u1/manual_classes/c", { student_ids: [] });
    await expect(approveCorrectionSuggestion("u1", { suggestion_id: s.suggestion_id, snapshot_hash: s.snapshot_hash, score: 15, feedback: "Revisto", request_id: "approval_001" })).rejects.toMatchObject({ status: 403 });
  });
  it("invalidates in-flight generation on reset and does not store raw submission", async () => {
    const reservation = await reserveCorrectionSuggestion("u1", input);
    const token = await beginCorrectionReset("u1");
    await expect(saveCorrectionSuggestion("u1", input, reservation, buildCorrectionContext(input, row), grade, "gemini-test")).rejects.toMatchObject({ code: "reset_in_progress" });
    expect([...fake.rows.keys()].filter(k => k.startsWith("private_correction_suggestions/"))).toEqual([]);
    await expect(reserveCorrectionSuggestion("u1", input)).rejects.toMatchObject({ code: "reset_in_progress" });
    await finishCorrectionReset("u1", token);
    const s = await draft(); const stored = fake.rows.get(`private_correction_suggestions/${s.suggestion_id}`)!;
    expect(JSON.stringify(stored)).not.toContain('"submission_text"');
    await expect(reserveCorrectionSuggestion("u1", { ...input, expected_revision: "other" })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("keeps the reset locked throughout client deletion and invalidates the pre-authorization epoch", async () => {
    const oldEpoch = await correctionGenerationEpoch("u1");
    const token = await beginCorrectionReset("u1");
    await expect(correctionGenerationEpoch("u1")).rejects.toMatchObject({ code: "reset_in_progress" });
    await expect(finishCorrectionReset("u1", "wrong-token")).rejects.toMatchObject({ code: "reset_in_progress" });
    await finishCorrectionReset("u1", token);
    await expect(reserveCorrectionSuggestion("u1", input, oldEpoch)).rejects.toMatchObject({ code: "reset_in_progress" });
    const currentEpoch = await correctionGenerationEpoch("u1");
    expect(await replayCorrectionSuggestion("u1", input, currentEpoch)).toBeUndefined();
    await reserveCorrectionSuggestion("u1", input, currentEpoch);
    await deleteCorrectionSuggestions("u1");
    await expect(correctionGenerationEpoch("u1")).rejects.toMatchObject({ code: "reset_in_progress" });
  });
  it("does not let an older reset completion unlock a newer reset", async () => {
    const first = await beginCorrectionReset("u1"); const second = await beginCorrectionReset("u1");
    await expect(finishCorrectionReset("u1", first)).rejects.toMatchObject({ code: "reset_in_progress" });
    await expect(reserveCorrectionSuggestion("u1", input)).rejects.toMatchObject({ code: "reset_in_progress" });
    await finishCorrectionReset("u1", second);
    await reserveCorrectionSuggestion("u1", input);
  });
  it("tombstones discard and rejects late completion or mismatched nonce/hash", async () => {
    const reservation = await reserveCorrectionSuggestion("u1", input);
    await expect(saveCorrectionSuggestion("u1", input, { ...reservation, nonce: "wrong" }, buildCorrectionContext(input, row), grade, "gemini-test")).rejects.toMatchObject({ code: "reservation_conflict" });
    await expect(saveCorrectionSuggestion("u1", input, { ...reservation, input_hash: "wrong" }, buildCorrectionContext(input, row), grade, "gemini-test")).rejects.toMatchObject({ code: "reservation_conflict" });
    await discardCorrectionSuggestion("u1", reservation.id);
    await expect(saveCorrectionSuggestion("u1", input, reservation, buildCorrectionContext(input, row), grade, "gemini-test")).rejects.toMatchObject({ status: 404 });
    await expect(reserveCorrectionSuggestion("u1", input)).rejects.toMatchObject({ status: 404 });
    const tombstone = fake.rows.get(`private_correction_suggestions/${reservation.id}`)!;
    expect(tombstone).toMatchObject({ discarded: true, nonce: reservation.nonce });
    expect(tombstone.suggestion).toBeUndefined();
  });
  it("rejects missing, invalid and expired logical TTL values", async () => {
    const suggestion = await draft(); const path = `private_correction_suggestions/${suggestion.suggestion_id}`;
    const original = fake.rows.get(path)!;
    for (const expires_at of [undefined, new Date(NaN), new Date(0), { toMillis: () => Infinity }, { toMillis: () => NaN }]) {
      fake.rows.set(path, { ...original, expires_at });
      await expect(getCorrectionSuggestion("u1", suggestion.suggestion_id)).rejects.toMatchObject({ status: 404 });
    }
  });
  it("only prepares pasted Kodland context, regardless of write flag", async () => {
    const external = { ...input, source: "kodland" as const, manual_context: { provenance: "tutor_provided" as const, statement: "Somar", submission_text: "a+b", submission_complete: true, rubric, rubric_confirmed: true as const, delivery_state: "TASK_SUBMITTED" as const, human_review_applicable: true as const } };
    const reservation = await reserveCorrectionSuggestion("u1", external);
    const s = await saveCorrectionSuggestion("u1", external, reservation, buildCorrectionContext(external), grade, "gemini-test");
    const result = await approveCorrectionSuggestion("u1", { suggestion_id: s.suggestion_id, snapshot_hash: s.snapshot_hash, score: 15, feedback: "Revisado", request_id: "approval_001" });
    expect(result).toMatchObject({ status: "ready_to_send", external_write_verified: false });
    expect(fake.rows.get("users/u1/manual_activities/a")?.status).toBe("submitted");
  });
});
