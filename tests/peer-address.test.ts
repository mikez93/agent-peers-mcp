import { test, expect } from "bun:test";
import { parseAddress, personaOf, withPersonaPrefix, matchesPersonaQuery } from "../shared/peer-address.ts";

test("parseAddress splits name, host and chat", () => {
  expect(parseAddress("marco")).toEqual({ name: "marco", host: null, chat: null });
  expect(parseAddress("valentina/email shit")).toEqual({ name: "valentina", host: null, chat: "email shit" });
  expect(parseAddress("ezra-hermes@mike-mac-studio/Bot Chat")).toEqual({ name: "ezra-hermes", host: "mike-mac-studio", chat: "Bot Chat" });
  expect(parseAddress("valentina/a/b @c")).toEqual({ name: "valentina", host: null, chat: "a/b @c" });
  expect(parseAddress("  kepler@macbook  ")).toEqual({ name: "kepler", host: "macbook", chat: null });
  expect(parseAddress("valentina/   ")).toEqual({ name: "valentina", host: null, chat: null });
});

test("personaOf reads persona names and skips repo fallbacks", () => {
  expect(personaOf({ name: "marco-imekka-director-ops-droid", git_root: "/Users/mike/www/ai/imekka-director-ops" })).toBe("marco");
  expect(personaOf({ name: "kepler-kepler-maintainer-claude", git_root: "/Users/mike/www/ai/kepler-maintainer" })).toBe("kepler");
  expect(personaOf({ name: "ezra-hermes", cwd: "/Users/mike/ezra-workdir" })).toBe("ezra");
  expect(personaOf({ name: "gurdjieff-claude-2", git_root: "/Users/mike/www/ai/gurdjieff" })).toBeNull();
  expect(personaOf({ name: "agentic-coding-resources-codex", git_root: "/Users/mike/www/ai/agentic-coding-resources" })).toBeNull();
  expect(personaOf({ name: "whatever-x", persona: "Vector" })).toBe("vector");
});

test("withPersonaPrefix adds the name once", () => {
  expect(withPersonaPrefix("Standing by after review", "marco")).toBe("Marco: Standing by after review");
  expect(withPersonaPrefix("Kepler: verifying", "kepler")).toBe("Kepler: verifying");
  expect(withPersonaPrefix("Vector HoE: coordinating", "vector")).toBe("Vector HoE: coordinating");
  expect(withPersonaPrefix("Valentinas plan", "valentina")).toBe("Valentina: Valentinas plan");
  expect(withPersonaPrefix("", "massimo")).toBe("Massimo: (no status set)");
  expect(withPersonaPrefix("plain", null)).toBe("plain");
});

test("matchesPersonaQuery matches leading tokens only", () => {
  expect(matchesPersonaQuery("marco-hermes", "Marco")).toBe(true);
  expect(matchesPersonaQuery("marco-imekka-director-ops-droid", "marco")).toBe(true);
  expect(matchesPersonaQuery("marcopolo-claude", "marco")).toBe(false);
  expect(matchesPersonaQuery("vector-agentic-coding-resources-claude-7", "vector-agentic")).toBe(true);
});
