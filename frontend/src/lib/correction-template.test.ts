import { expect, it } from "vitest";
import { correctionTaskKey } from "./correction-template";

it("shares task identity across students without sharing submissions", () => {
  expect(correctionTaskKey("https://learn.kodland.org/pt/task/123/check/1")).toBe("kodland:123");
  expect(correctionTaskKey("https://learn.kodland.org/pt/task/123/check/2")).toBe("kodland:123");
  expect(correctionTaskKey("https://learn.kodland.org/pt/task/124/check/2")).toBe("kodland:124");
});
it("rejects unverified origins and ambiguous routes", () => {
  for (const url of [undefined, "bad", "https://evil.org/pt/task/123/check/1", "http://learn.kodland.org/pt/task/123/check/1", "https://bo.kodland.org/task/123", "https://learn.kodland.org/pt/task/123"]) expect(correctionTaskKey(url)).toBeNull();
});
