import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStateDir, type StateRuntime } from "../shared/state-dir.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

test("state roots retain existing runtime paths and writer precedence", () => {
  for (const runtime of ["codex", "hermes", "droid", "claude"] as StateRuntime[]) {
    const env = { HOME: "/home/test", AGENT_PEERS_STATE_DIR: "/generic",
      [`AGENT_PEERS_${runtime.toUpperCase()}_STATE_DIR`]: "/specific" };
    expect(resolveStateDir({ runtime, env, rootDir: "/explicit" })).toBe("/explicit");
    expect(resolveStateDir({ runtime, env })).toBe("/generic");
    expect(resolveStateDir({ runtime, env: { HOME: "/home/test" } })).toBe(`/home/test/.agent-peers-${runtime}`);
    if (runtime !== "claude") {
      delete (env as NodeJS.ProcessEnv).AGENT_PEERS_STATE_DIR;
      expect(resolveStateDir({ runtime, env })).toBe("/specific");
    }
  }
  for (const runtime of ["hermes", "droid"] as const) {
    expect(resolveStateDir({ env: { AGENT_PEERS_RUNTIME: runtime, AGENT_PEERS_CODEX_STATE_DIR: "/legacy" } })).toBe("/legacy");
  }
});

test("generic state override connects inbox, claims, registry and wake readers without migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "ap-state-dir-"));
  dirs.push(root);
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/state-dir-wake.ts")], {
    env: { ...process.env, HOME: root, AGENT_PEERS_RUNTIME: "codex",
      AGENT_PEERS_STATE_DIR: join(root, "generic"), AGENT_PEERS_CODEX_STATE_DIR: join(root, "legacy"),
      AGENT_PEERS_DROID_STATE_DIR: join(root, "droid"), AGENT_PEERS_HERMES_STATE_DIR: join(root, "hermes") },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual({ action: "wake", unread: 1, claims: 1, legacyExists: true,
    logRootMatches: true, childMatched: true, oldAction: "wake", oldUnread: 1 });
});

test("coordination roots match old running owners even when inbox overrides differ", () => {
  const env = { HOME: "/home/test", AGENT_PEERS_CODEX_STATE_DIR: "/codex", AGENT_PEERS_STATE_DIR: "/inbox" };
  expect(resolveStateDir({ runtime: "codex", kind: "coordination", env })).toBe("/codex");
  expect(resolveStateDir({ runtime: "droid", kind: "coordination", env })).toBe("/home/test/.agent-peers-droid");
  expect(resolveStateDir({ runtime: "hermes", kind: "coordination", env })).toBe("/inbox");
  expect(resolveStateDir({ runtime: "hermes", kind: "coordination",
    env: { HOME: "/home/test", AGENT_PEERS_CODEX_STATE_DIR: "/codex" } })).toBe("/home/test/.agent-peers-hermes");
});

test("openclaw has its own root for inbox and coordination, with no Codex inbox fallback", () => {
  const env = { HOME: "/home/test", AGENT_PEERS_CODEX_STATE_DIR: "/codex" };
  expect(resolveStateDir({ env: { ...env, AGENT_PEERS_RUNTIME: "openclaw" } })).toBe("/home/test/.agent-peers-openclaw");
  expect(resolveStateDir({ runtime: "openclaw", kind: "coordination", env })).toBe("/home/test/.agent-peers-openclaw");
  expect(resolveStateDir({ runtime: "openclaw", kind: "coordination", env: { ...env, AGENT_PEERS_STATE_DIR: "/one" } })).toBe("/one");
  expect(resolveStateDir({ runtime: "openclaw", env: { ...env, AGENT_PEERS_OPENCLAW_STATE_DIR: "/oc" } })).toBe("/oc");
});
