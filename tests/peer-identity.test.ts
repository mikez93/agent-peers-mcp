import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPeerName, extractPersona, resolvePeerIdentity } from "../shared/peer-identity.ts";
import { appendSuffixWithinLimit, isValidName, NAME_MAX_LEN } from "../shared/names.ts";

const temps: string[] = [];
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });
function repo(name = "example-repo") {
  const temp = mkdtempSync(join(tmpdir(), "peer-identity-"));
  temps.push(temp);
  const path = join(temp, name);
  mkdirSync(path);
  execFileSync("git", ["init", "-q", path]);
  return path;
}

test("real persona declarations use the person's given name, never YAML role words", () => {
  for (const [full, expected, yaml] of [
    ["Vector", "vector", "vector-agentic-master"],
    ["Valentina Moretti", "valentina", "trophy-ceo-valentina"],
    ["Marco Caruso", "marco", "marco-caruso"],
    ["Luca Moretti", "luca", "luca-prompt-library-manager"],
  ] as const) {
    expect(extractPersona(`---\nname: ${yaml}\n---\nYou are **${full}**, the Virtual Director.\nTalk to Kepler.`)).toBe(expected);
  }
  expect(extractPersona("# Kepler\nYou are Kepler, master Hermes deployment expert.\nYou are not any maintained agent.\nTalk to Vector and Marco.")).toBe("kepler");
});

test("generic, ambiguous, quoted, example and missing identities do not invent a persona", () => {
  for (const text of ["name: trophy-ceo-valentina", "You are an AI assistant.", "You are **runtime-agnostic**: Codex or Droid.", "You are Codex, an assistant.", "Talk to **Luca**.", "You are **Vector**.\nYou are **Marco**.", "> You are **Marco**.", "```md\nYou are **Marco**.\n```", "You are the **librarian and architect**."]) {
    expect(extractPersona(text)).toBeNull();
  }
});

test("nested cwd inherits root identity and nearest declaration overrides it", () => {
  const path = repo("agentic-coding-resources");
  writeFileSync(join(path, "AGENTS.md"), "You are **Vector**, the architect.");
  const sub = join(path, "packages", "child");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "AGENTS.md"), "# Build rules\nRun bun test.");
  expect(defaultPeerName(sub, "codex")).toBe("vector-agentic-coding-resources-codex");
  writeFileSync(join(sub, "AGENTS.md"), "You are **Kepler**, the maintainer.");
  expect(defaultPeerName(sub, "droid")).toBe("kepler-agentic-coding-resources-droid");
});

test("explicit names are preserved and invalid overrides are rejected", () => {
  const path = repo();
  expect(defaultPeerName(path, "codex", "My-Existing_Name")).toBe("My-Existing_Name");
  expect(() => defaultPeerName(path, "codex", "bad name")).toThrow("Invalid peer name");
  expect(defaultPeerName(path, "claude")).toBe("example-repo-claude");
});

test("shell-facing resolver honors PEER_NAME and emits only the resolved name", () => {
  const path = repo("shell-project");
  writeFileSync(join(path, "AGENTS.md"), "You are **Marco Caruso**, the director.");
  const cli = join(import.meta.dir, "..", "peer-name.ts");
  const run = (override: string) => execFileSync(process.execPath, [cli, path, "codex"], {
    encoding: "utf8", env: { ...process.env, PEER_NAME: override },
  });
  expect(run("")).toBe("marco-shell-project-codex\n");
  expect(run("explicit-existing-peer")).toBe("explicit-existing-peer\n");
});

test("long repository names preserve persona, harness, and full collision suffix", () => {
  const path = repo("repository-".repeat(16));
  writeFileSync(join(path, "AGENTS.md"), "You are **Valentina Moretti**, the CEO.");
  const name = defaultPeerName(path, "codex");
  expect(name).toStartWith("valentina-repository-");
  expect(name).toEndWith("-codex");
  expect(name.length).toBeLessThanOrEqual(NAME_MAX_LEN - 8);
  expect(appendSuffixWithinLimit(name, "mantis")).toBe(`${name}-mantis`);
  expect(isValidName(name)).toBe(true);
});

test("linked worktrees retain repository name and their own AGENTS.md", () => {
  const path = repo("named-repository");
  writeFileSync(join(path, "AGENTS.md"), "You are **Vector**, the architect.");
  execFileSync("git", ["-C", path, "add", "AGENTS.md"]);
  execFileSync("git", ["-C", path, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
  const worktree = join(path, "..", "random-worktree");
  execFileSync("git", ["-C", path, "worktree", "add", "-q", "--detach", worktree]);
  expect(resolvePeerIdentity({ cwd: worktree, harness: "droid" }).name).toBe("vector-named-repository-droid");
  writeFileSync(join(worktree, "AGENTS.md"), "You are **Luca Moretti**, the librarian.");
  expect(defaultPeerName(worktree, "droid")).toBe("luca-named-repository-droid");
});
