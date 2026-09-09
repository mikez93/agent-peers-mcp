import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("50 adapter cycles: five simultaneous chats, 25 close/25 reap, pending mail retained and resources bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "hermes-cycles-"));
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/hermes-conversation-cycles.ts"), root],
      { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as {
      baseline: { fd: number; rss: number };
      measurements: { cycle: number; fd: number; rss: number; identities: number; calls: number; waiters: number; timers: number;
        pendingAcks: number; peers: number; bindings: { active: number; dormant: number } }[];
      stopped: { identities: number; calls: number; waiters: number; timers: number };
      peakIdentities: number; unread: number; leases: number; tokens: number; maxCleanupMs: number;
      bodyFiles: number; metadataFiles: number; contentsMatch: boolean; persistedIds: number[]; brokerIds: number[];
    };
    expect(result.measurements).toHaveLength(50);
    expect(result.peakIdentities).toBe(5);
    for (const row of result.measurements) {
      expect(row.identities).toBe(0);
      expect(row.calls).toBe(0);
      expect(row.waiters).toBe(0);
      expect(row.timers).toBe(1);
      expect(row.pendingAcks).toBe(0);
      expect(row.peers).toBe(0);
      expect(row.bindings).toMatchObject({ active: 0, dormant: row.cycle * 5 });
      expect(row.fd).toBe(result.baseline.fd);
    }
    expect(result.stopped).toMatchObject({ identities: 0, calls: 0, waiters: 0, timers: 0 });
    expect(result.unread).toBe(250);
    expect(result.leases).toBe(0);
    expect(result.tokens).toBe(0);
    expect(result.bodyFiles).toBe(250);
    expect(result.metadataFiles).toBe(250);
    expect(result.contentsMatch).toBe(true);
    expect(result.persistedIds).toEqual(result.brokerIds);
    expect(result.maxCleanupMs).toBeLessThan(10_000);
    const from10 = result.measurements.slice(9);
    const growth = from10.at(-1)!.rss - from10[0]!.rss;
    console.log("HERMES_CYCLES " + JSON.stringify({ cycles: 50, peakIdentities: 5, dormant: 250, unread: result.unread,
      fdBaseline: result.baseline.fd, fdFinal: from10.at(-1)!.fd, rssBaseline: result.baseline.rss,
      rssCycle10: from10[0]!.rss, rssPeak: Math.max(...result.measurements.map(m => m.rss)),
      rssFinal: from10.at(-1)!.rss, rssGrowth10to50: growth, maxCleanupMs: result.maxCleanupMs }));
    expect(growth).toBeLessThanOrEqual(10 * 1024 * 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
