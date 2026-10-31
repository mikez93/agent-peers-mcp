import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enabledProfiles, runHermesWakePass } from "../shared/hermes-wake-pass.ts";
import type { ChatInboxEntry } from "../shared/types.ts";

const entry = (peer_name: string, to_chat: string | null, max_id = 5): ChatInboxEntry => ({
  peer_id: "p", peer_name, to_chat, title: to_chat ? "email shit" : null, unread: 1, leased: 0, max_id, oldest_sent_at: "t",
});

function envWith(enabled?: string) {
  const dir = mkdtempSync(join(tmpdir(), "hermes-wake-pass-"));
  if (enabled !== undefined) {
    mkdirSync(join(dir, "chat-wake"), { recursive: true });
    writeFileSync(join(dir, "chat-wake", "enabled"), enabled);
  }
  return { AGENT_PEERS_STATE_DIR: dir, HOME: dir, AGENT_PEERS_HERMES_BIN: "/bin/false" } as NodeJS.ProcessEnv;
}

test("nothing is woken until a profile is enabled", async () => {
  let asked = false;
  const r = await runHermesWakePass({ env: envWith(), inbox: async () => { asked = true; return [entry("ezra-hermes", null)]; } });
  expect(r).toEqual([]);
  expect(asked).toBe(false); // no broker call at all while disabled
});

test("only enabled profiles are woken, with the chat key and max id", async () => {
  const calls: unknown[] = [];
  const env = envWith("# staged rollout\nezra\n");
  expect([...enabledProfiles(env)]).toEqual(["ezra"]);
  const r = await runHermesWakePass({
    env,
    inbox: async () => [entry("ezra-hermes", "20261031_030101_c01856", 9), entry("valentina-hermes", null)],
    wake: async (req) => { calls.push(req); return { state: "launched", detail: "ok" }; },
  });
  expect(calls).toEqual([{ peerName: "ezra-hermes", profile: "ezra", chatKey: "20261031_030101_c01856", title: "email shit", unread: 1, maxId: 9 }]);
  expect(r.map((x) => `${x.profile}:${x.outcome.state}`)).toEqual(["ezra:launched"]);
});

test("an old broker without the chat inbox is a no-op", async () => {
  expect(await runHermesWakePass({ env: envWith("ezra\n"), inbox: async () => null })).toEqual([]);
});

test("a driver error is reported, never thrown", async () => {
  const r = await runHermesWakePass({
    env: envWith("ezra\n"),
    inbox: async () => [entry("ezra-hermes", null)],
    wake: async () => { throw new Error("boom"); },
  });
  expect(r[0]!.outcome.detail).toContain("boom");
});
