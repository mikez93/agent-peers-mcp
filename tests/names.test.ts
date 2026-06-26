import { test, expect } from "bun:test";
import {
  appendSuffixWithinLimit,
  generateName,
  generateSuffixWord,
  isValidName,
  NAME_MAX_LEN,
  NAME_REGEX,
  pickAvailablePeerName,
} from "../shared/names.ts";

test("generateName returns adjective-noun", () => {
  const name = generateName();
  expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  expect(name.length).toBeGreaterThanOrEqual(5);
  expect(name.length).toBeLessThanOrEqual(32);
});

test("generateName varies across calls", () => {
  const s = new Set<string>();
  for (let i = 0; i < 20; i++) s.add(generateName());
  expect(s.size).toBeGreaterThan(1);
});

test("isValidName rejects empty, too long, bad chars, and UUID-shaped", () => {
  expect(isValidName("")).toBe(false);
  expect(isValidName("a".repeat(33))).toBe(false);
  expect(isValidName("has space")).toBe(false);
  expect(isValidName("has/slash")).toBe(false);
  expect(isValidName("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toBe(false);
});

test("isValidName accepts normal names", () => {
  expect(isValidName("calm-fox")).toBe(true);
  expect(isValidName("frontend_tab")).toBe(true);
  expect(isValidName("peer1")).toBe(true);
  expect(isValidName("A-B-C")).toBe(true);
});

test("NAME_REGEX is exported", () => {
  expect(NAME_REGEX).toBeInstanceOf(RegExp);
});

test("generateSuffixWord is a single lowercase word that forms a valid name", () => {
  for (let i = 0; i < 20; i++) {
    const w = generateSuffixWord();
    expect(w).toMatch(/^[a-z]+$/);
    expect(isValidName(`repo-codex-${w}`)).toBe(true);
  }
});

test("appendSuffixWithinLimit appends when there is room", () => {
  expect(appendSuffixWithinLimit("ccr-codex", "otter")).toBe("ccr-codex-otter");
  expect(appendSuffixWithinLimit("trophy-shopify-theme-codex", "otter")).toBe("trophy-shopify-theme-codex-otter");
});

test("appendSuffixWithinLimit trims the base (never the suffix) to fit NAME_MAX_LEN", () => {
  const base = "abcdefghijklmnopqrstuvwxyz-codex"; // exactly 32 chars
  const out = appendSuffixWithinLimit(base, "otter");
  expect(out.length).toBeLessThanOrEqual(NAME_MAX_LEN);
  expect(out.endsWith("-otter")).toBe(true);
});

test("appendSuffixWithinLimit removes a dangling dash left by trimming", () => {
  // base[29] is '-', word "x": allowed = 32-1-1 = 30, slice(0,30) ends in '-'
  const base = "a".repeat(29) + "-aa"; // length 32, dash at index 29
  expect(appendSuffixWithinLimit(base, "x")).toBe("a".repeat(29) + "-x");
  expect(appendSuffixWithinLimit(base, "x")).not.toContain("--");
});

test("pickAvailablePeerName returns the base unchanged when it is free (preserves canonical name + reclaim)", () => {
  expect(pickAvailablePeerName("trophy-codex", new Set())).toBe("trophy-codex");
  expect(pickAvailablePeerName("trophy-codex", new Set(["other-codex"]))).toBe("trophy-codex");
});

test("pickAvailablePeerName appends a funny suffix only on a live collision", () => {
  const out = pickAvailablePeerName("trophy-codex", new Set(["trophy-codex"]), { word: () => "otter" });
  expect(out).toBe("trophy-codex-otter");
});

test("pickAvailablePeerName retries past a taken suffix word", () => {
  const words = ["otter", "panda"];
  let i = 0;
  const out = pickAvailablePeerName(
    "trophy-codex",
    new Set(["trophy-codex", "trophy-codex-otter"]),
    { word: () => words[i++ % words.length]! },
  );
  expect(out).toBe("trophy-codex-panda");
});

test("pickAvailablePeerName falls back to a numeric suffix when words keep colliding", () => {
  const out = pickAvailablePeerName(
    "trophy-codex",
    new Set(["trophy-codex", "trophy-codex-otter"]),
    { word: () => "otter", attempts: 5 },
  );
  expect(out).toBe("trophy-codex-2");
});
