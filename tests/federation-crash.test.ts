import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function child(root: string, mode: string) {
  const process = Bun.spawn([Bun.which("bun")!, join(import.meta.dir, "fixtures/federation-crash.ts"), root, mode], {
    env: { HOME: root }, stdout: "pipe", stderr: "pipe",
  });
  const watchdog = setTimeout(() => process.kill("SIGKILL"), 4000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
    ]);
    expect(stderr).toBe("");
    return { code, stdout, signal: process.signalCode };
  } finally { clearTimeout(watchdog); }
}

test("actual SIGKILL preserves committed outbox and rolls back partial receive, then dedupes after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ap-federation-crash-"));
  try {
    expect((await child(root, "enqueue")).signal).toBe("SIGKILL");
    const source = new Database(join(root, "alpha.db"));
    const outbox = source.query<{ envelope: string; status: string }, []>(
      "SELECT envelope, status FROM federation_outbox",
    ).get()!;
    expect(outbox.status).toBe("pending");
    source.close();
    await writeFile(join(root, "envelope.json"), outbox.envelope, { mode: 0o600 });

    expect((await child(root, "receive-during-transaction")).signal).toBe("SIGKILL");
    let destination = new Database(join(root, "beta.db"));
    expect(destination.query("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 0 });
    expect(destination.query("SELECT count(*) AS n FROM federation_receipts").get()).toEqual({ n: 0 });
    destination.close();

    expect((await child(root, "receive-after-commit")).signal).toBe("SIGKILL");
    destination = new Database(join(root, "beta.db"));
    expect(destination.query("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 1 });
    expect(destination.query("SELECT count(*) AS n FROM federation_receipts").get()).toEqual({ n: 1 });
    destination.close();

    const replay = await child(root, "receive");
    expect(replay.code).toBe(0);
    expect(JSON.parse(replay.stdout)).toMatchObject({ ok: true, message_id: 1 });
    destination = new Database(join(root, "beta.db"));
    expect(destination.query("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 1 });
    expect(destination.query("SELECT count(*) AS n FROM federation_senders").get()).toEqual({ n: 1 });
    destination.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
