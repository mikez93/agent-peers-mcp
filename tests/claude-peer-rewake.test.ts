// bin/claude-peer-rewake stands down for sessions that wake themselves
// through the inbox socket, and cleans markers left by dead servers.

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "..", "bin", "claude-peer-rewake");

function py(code: string, stateDir: string): string {
  const r = Bun.spawnSync(["/usr/bin/python3", "-I", "-c", `
import importlib.machinery, importlib.util
loader = importlib.machinery.SourceFileLoader("rewake", ${JSON.stringify(HOOK)})
spec = importlib.util.spec_from_loader("rewake", loader)
m = importlib.util.module_from_spec(spec); loader.exec_module(m)
${code}
`], { env: { ...process.env, AGENT_PEERS_STATE_DIR: stateDir } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

test("socket wake marker makes the hook stand down", () => {
  const root = mkdtempSync(join(tmpdir(), "ap-rewake-"));
  expect(py("print(m.socket_wake_active(4242))", root)).toBe("False");
  mkdirSync(join(root, "socket-wake"), { recursive: true });
  writeFileSync(join(root, "socket-wake", "4242"), "x");
  expect(py("print(m.socket_wake_active(4242))", root)).toBe("True");
});

test("markers of exited servers are removed, live ones kept", () => {
  const root = mkdtempSync(join(tmpdir(), "ap-rewake-"));
  mkdirSync(join(root, "socket-wake"), { recursive: true });
  writeFileSync(join(root, "socket-wake", String(process.pid)), "live");
  writeFileSync(join(root, "socket-wake", "999999"), "dead");
  py("m.drop_stale_socket_markers(m.processes())", root);
  expect(existsSync(join(root, "socket-wake", String(process.pid)))).toBe(true);
  expect(existsSync(join(root, "socket-wake", "999999"))).toBe(false);
});
