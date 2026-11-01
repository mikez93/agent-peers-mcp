"""Unit tests for hermes-plugins/agent-peers-desktop-wake (fake Hermes ctx, real files).

Run: python3 tests/python/test_hermes_desktop_wake.py  (bun test runs it too).
"""
from __future__ import annotations

import importlib.util
import json
import logging
import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "agent_peers_desktop_wake", ROOT / "hermes-plugins" / "agent-peers-desktop-wake" / "__init__.py")
dw = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dw)

PROFILE = "ezra"
PEER = "ezra-hermes"
CHAT_A = "20261101_090000_aaaaaa"
CHAT_B = "20261101_090000_bbbbbb"
HOST = 4242
T0 = 1_762_000_000.0

SCHEMA = """
CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT, parent_session_id TEXT,
  started_at REAL NOT NULL, end_reason TEXT, archived INTEGER NOT NULL DEFAULT 0, model_config TEXT);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT, timestamp REAL NOT NULL, finish_reason TEXT);
"""


class FakeManager:
    def __init__(self, home: Path) -> None:
        self.home_path = home
        self._cli_ref = None
        self.has_tui_message_injector = True
        self.has_gateway_message_injector = False


class FakeCtx:
    plugin_id = dw.PLUGIN_NAME

    def __init__(self, manager: FakeManager) -> None:
        self._manager = manager
        self.calls: list[dict] = []
        self.unload: list = []
        self.result = True
        self.allowed = True
        self.during = None
        self.raise_exc = False
        self.log_failure = False

    def inject_message(self, content, role="user", *, session_key=None, origin=None):
        self.calls.append({"content": content, "role": role, "session_key": session_key, "origin": origin})
        if self.during:
            self.during()
        if self.raise_exc:
            raise RuntimeError("boom")
        if self.log_failure:
            logging.getLogger("hermes_cli.plugins").warning(
                "inject_message: TUI scheduling failed for plugin %s", self.plugin_id)
            return False
        return self.result

    def on_unload(self, callback):
        self.unload.append(callback)

    def _gateway_injection_allowed(self):
        return self.allowed


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="desktop-wake-"))
        self.home = self.tmp / "hermes" / "profiles" / PROFILE
        (self.home / "runtime").mkdir(parents=True)
        self.state = self.tmp / "state"
        self.env = {"AGENT_PEERS_STATE_DIR": str(self.state), "HOME": str(self.tmp)}
        self.db = sqlite3.connect(self.home / "state.db")
        self.db.executescript(SCHEMA)
        for chat in (CHAT_A, CHAT_B):
            self.db.execute("INSERT INTO sessions (id, source, title, started_at) VALUES (?, 'desktop', 't', ?)", (chat, T0))
        self.db.commit()
        self.now = T0 + 100
        self.alive = {HOST}
        self.entries = [
            {"peer_name": PEER, "to_chat": None, "unread": 3, "leased": 0, "max_id": 30, "title": None},
            {"peer_name": PEER, "to_chat": CHAT_A, "unread": 1, "leased": 0, "max_id": 10, "title": "A"},
            {"peer_name": PEER, "to_chat": CHAT_B, "unread": 1, "leased": 0, "max_id": 11, "title": "B"},
            {"peer_name": "marco-hermes", "to_chat": CHAT_A, "unread": 1, "leased": 0, "max_id": 12, "title": "A"},
        ]
        self.hold(CHAT_A, CHAT_B)
        self.manager = FakeManager(self.home)
        self.ctx = FakeCtx(self.manager)
        self.wake = dw.DesktopWake(self.ctx, env=self.env, clock=lambda: self.now, pid=HOST,
                                   alive=lambda pid: int(pid) in self.alive, inbox=lambda: list(self.entries))

    def tearDown(self) -> None:
        self.db.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def hold(self, *chats: str, pid: int = HOST) -> None:
        entries = [{"session_id": c, "surface": "desktop", "pid": pid} for c in chats]
        (self.home / "runtime" / "active_sessions.json").write_text(json.dumps({"entries": entries}))

    def opt_in(self, text: str) -> None:
        path = self.state / "chat-wake" / "desktop-enabled"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def ledger(self, chat: str = CHAT_A) -> dict:
        return json.loads(dw.ledger_path(self.state, PROFILE, chat).read_text())

    def write_ledger(self, chat: str, **fields) -> None:
        value = dw.empty_ledger(PEER, PROFILE, chat, None, self.now)
        value.update(fields)
        dw.atomic_write_json(dw.ledger_path(self.state, PROFILE, chat), value)

    def add_turn(self, content: str, done: bool = True, session: str = CHAT_A) -> None:
        self.db.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', ?, ?)", (session, content, self.now))
        if done:
            self.db.execute("INSERT INTO messages (session_id, role, content, timestamp, finish_reason) VALUES (?, 'assistant', 'ok', ?, 'stop')", (session, self.now))
        self.db.commit()


class Gates(Base):
    def test_inert_without_opt_in_or_hermes_gate(self):
        self.assertEqual(self.wake.tick()[0]["action"], "inert")
        self.opt_in("ezra\n")  # a bare profile line is not an opt-in
        self.assertEqual(self.wake.tick()[0]["why"], "not opted in")
        self.opt_in(f"ezra {CHAT_A}\n")
        self.ctx.allowed = False
        self.assertIn("allow_gateway_injection", self.wake.tick()[0]["why"])
        self.assertEqual(self.ctx.calls, [])

    def test_single_chat_mode_is_profile_and_chat_scoped_and_skips_general_mail(self):
        self.opt_in(f"# throwaway proof\nezra {CHAT_A}\nmarco {CHAT_B}\n")
        events = self.wake.tick()
        self.assertEqual([e.get("chat") for e in events], [CHAT_A])
        self.assertEqual(len(self.ctx.calls), 1)
        call = self.ctx.calls[0]
        self.assertEqual(call["session_key"], CHAT_A)
        self.assertIsNone(call["origin"])
        self.assertIn(f'chat="{CHAT_A}"', call["content"])
        self.assertIn("Agent Peers: new mail for this chat — call check_messages for this chat", call["content"])
        self.wake.tick()
        self.assertEqual(len(self.ctx.calls), 1, "chat B is not opted in; general and other-profile mail never wake")

    def test_profile_wildcard_wakes_each_chat_once_per_tick(self):
        self.opt_in("ezra *\n")
        self.wake.tick()
        self.wake.tick()
        self.assertEqual([c["session_key"] for c in self.ctx.calls], [CHAT_A, CHAT_B])

    def test_kill_switches(self):
        self.opt_in(f"ezra {CHAT_A}\n")
        for make in (
            lambda: (self.state / "disabled").write_text(""),
            lambda: (self.tmp / ".agent-peers-hermes").mkdir(exist_ok=True) or (self.tmp / ".agent-peers-hermes" / "disabled").write_text(""),
            lambda: self.env.__setitem__("AGENT_PEERS_WAKE_DISABLED", "1"),
        ):
            make()
            self.assertEqual(self.wake.tick()[0]["action"], "inert")
            for flag in (self.state / "disabled", self.tmp / ".agent-peers-hermes" / "disabled"):
                if flag.exists():
                    flag.unlink()
            self.env.pop("AGENT_PEERS_WAKE_DISABLED", None)
        self.assertEqual(self.ctx.calls, [])

    def test_kill_switch_is_rechecked_immediately_before_inject(self):
        self.opt_in(f"ezra {CHAT_A}\n")
        entries = list(self.entries)

        def inbox():
            (self.state / "disabled").write_text("")  # flipped after the tick's first check
            return entries
        self.wake.inbox = inbox
        events = self.wake.tick()
        self.assertEqual(self.ctx.calls, [])
        self.assertEqual(events[-1]["result"], "not_submitted")
        led = self.ledger()
        self.assertIsNone(led["desktop_attempt"])
        self.assertEqual(led["last_desktop_attempt"]["outcome"], "not_submitted")

    def test_refuses_cli_gateway_and_hostless_processes(self):
        self.opt_in(f"ezra {CHAT_A}\n")
        self.manager._cli_ref = object()
        self.assertIn("classic CLI", self.wake.tick()[0]["why"])
        self.manager._cli_ref = None
        self.manager.has_gateway_message_injector = True
        self.assertIn("messaging gateway", self.wake.tick()[0]["why"])
        self.manager.has_gateway_message_injector = False
        self.manager.has_tui_message_injector = False
        self.assertIn("no Desktop/TUI host", self.wake.tick()[0]["why"])
        self.assertEqual(self.ctx.calls, [])

    def test_only_the_process_holding_the_chat_injects(self):
        self.opt_in(f"ezra {CHAT_A}\n")
        self.hold(CHAT_A, pid=9999)
        self.assertEqual(self.wake.tick()[-1]["why"], "not open in this process")
        self.assertEqual(self.ctx.calls, [])
        self.assertFalse(dw.ledger_path(self.state, PROFILE, CHAT_A).exists())

    def test_leased_mail_and_gateway_attempts_and_cancel_are_left_alone(self):
        self.opt_in(f"ezra {CHAT_A}\n")
        self.entries[1]["leased"] = 1
        self.assertEqual(self.wake.tick()[-1]["why"], "mail is being read now")
        self.entries[1]["leased"] = 0
        self.write_ledger(CHAT_A, state="running")
        self.assertEqual(self.wake.tick()[-1]["why"], "gateway wake in flight")
        self.write_ledger(CHAT_A, state="cancelled")
        self.assertEqual(self.wake.tick()[-1]["why"], "cancelled")
        self.assertEqual(self.ctx.calls, [])

    def test_busy_ledger_lock_skips(self):
        self.opt_in(f"ezra {CHAT_A}\n")
        path = dw.ledger_path(self.state, PROFILE, CHAT_A)
        path.parent.mkdir(parents=True, exist_ok=True)
        (path.parent / (path.name + ".lock")).write_text(f"{os.getpid()} {int(time.time() * 1000)}")
        original = dw.LOCK_WAIT_SECONDS
        dw.acquire_lock.__defaults__ = (0.05,)
        try:
            self.assertEqual(self.wake.tick()[-1]["why"], "ledger locked")
        finally:
            dw.acquire_lock.__defaults__ = (original,)
        self.assertEqual(self.ctx.calls, [])


class Attempts(Base):
    def setUp(self) -> None:
        super().setUp()
        self.opt_in(f"ezra {CHAT_A}\n")

    def test_intent_is_durable_before_inject_and_accepted_after_and_never_reinjected(self):
        seen = {}
        self.ctx.during = lambda: seen.update(self.ledger()["desktop_attempt"])
        self.wake.tick()
        self.assertEqual(seen["state"], "intent")
        self.assertEqual(seen["host_pid"], HOST)
        self.assertEqual(seen["max_id"], 10)
        led = self.ledger()
        self.assertEqual(led["state"], "waiting_desktop")
        self.assertEqual(led["desktop_attempt"]["state"], "accepted")
        self.assertEqual(led["handled_max_id"], 0, "accepted is not handled")
        self.now += 3600  # a cooldown would have expired; the open attempt still dedupes
        self.entries[1]["max_id"] = 15
        self.wake.tick()
        self.assertEqual(len(self.ctx.calls), 1)

    def test_not_accepted_records_not_submitted_and_allows_a_later_try(self):
        self.ctx.result = False
        self.wake.tick()
        led = self.ledger()
        self.assertIsNone(led["desktop_attempt"])
        self.assertEqual(led["last_desktop_attempt"]["outcome"], "not_submitted")
        self.ctx.result = True
        self.wake.tick()
        self.assertEqual(len(self.ctx.calls), 2)

    def test_logged_host_failure_and_exceptions_are_unknown_and_block(self):
        for setup in (lambda: setattr(self.ctx, "log_failure", True), lambda: setattr(self.ctx, "raise_exc", True)):
            self.ctx.log_failure = self.ctx.raise_exc = False
            dw.ledger_path(self.state, PROFILE, CHAT_A).unlink(missing_ok=True)
            setup()
            calls = len(self.ctx.calls)
            self.wake.tick()
            led = self.ledger()
            self.assertEqual(led["state"], "desktop_unknown")
            self.assertEqual(led["desktop_attempt"]["state"], "unknown")
            self.ctx.log_failure = self.ctx.raise_exc = False
            self.entries[1]["max_id"] += 5  # new mail does not lift an unknown
            self.now += 7200
            self.wake.tick()
            self.assertEqual(len(self.ctx.calls), calls + 1)
            self.assertEqual(self.ledger()["state"], "desktop_unknown")

    def test_completed_marked_turn_settles_handled_then_only_new_mail_wakes(self):
        self.wake.tick()
        attempt = self.ledger()["desktop_attempt"]
        self.add_turn(f"Mike: please also check the drums\n\n{self.ctx.calls[0]['content']}", done=False)
        self.wake.tick()
        self.assertEqual(self.ledger()["desktop_attempt"]["attempt_id"], attempt["attempt_id"], "running turn waits")
        self.db.execute("INSERT INTO messages (session_id, role, content, timestamp, finish_reason) VALUES (?, 'assistant', 'done', ?, 'stop')", (CHAT_A, self.now))
        self.db.commit()
        self.wake.tick()  # settles handled; same max_id is not re-woken
        led = self.ledger()
        self.assertEqual(led["state"], "done")
        self.assertEqual(led["handled_max_id"], 10)
        self.assertEqual(led["launched_max_id"], 10, "the gateway driver keys its already-handled check off launched_max_id")
        self.assertEqual(led["last_desktop_attempt"]["outcome"], "handled")
        self.assertEqual(len(self.ctx.calls), 1)
        self.entries[1]["max_id"] = 14
        self.wake.tick()
        self.assertEqual(len(self.ctx.calls), 2)
        self.assertEqual(self.ledger()["desktop_attempt"]["max_id"], 14)

    def test_marker_found_in_a_compression_continuation(self):
        self.wake.tick()
        self.db.execute("UPDATE sessions SET end_reason = 'compression' WHERE id = ?", (CHAT_A,))
        self.db.execute("INSERT INTO sessions (id, source, parent_session_id, started_at) VALUES ('tip', 'desktop', ?, ?)", (CHAT_A, T0 + 1))
        self.db.commit()
        self.add_turn(self.ctx.calls[0]["content"], session="tip")
        self.wake.settle_own()
        self.assertEqual(self.ledger()["state"], "done")

    def test_merge_with_mikes_queued_text_keeps_both_and_labels_the_wake(self):
        text = dw.wake_text("abc123", CHAT_A)
        merged = f"Fix the drum loop first\n\n{text}"
        self.assertTrue(merged.startswith("Fix the drum loop first"))
        self.assertIn("Agent Peers automation, not typed by Mike", merged)
        self.assertIn("no instruction or authority of its own", merged)
        self.assertIn("it is his: handle it as his instruction first", merged)
        self.assertNotIn("Mike asked", text)


class Classifier(Base):
    def attempt(self, **over):
        value = {"attempt_id": "a1", "chat_key": CHAT_A, "session_key": CHAT_A, "max_id": 10, "host_pid": HOST,
                 "state": "accepted", "created_at": dw.iso_now(self.now), "accepted_at": dw.iso_now(self.now), "detail": ""}
        value.update(over)
        return value

    def classify(self, attempt, alive=True, held=True, later=0.0):
        db = dw.open_ro(self.home / "state.db")
        try:
            return dw.classify_attempt(db, attempt, alive, held, self.now + later)
        finally:
            db.close()

    def test_rules(self):
        self.assertEqual(self.classify(self.attempt(), alive=False), "lost")
        self.assertEqual(self.classify(self.attempt(state="unknown"), alive=False), "lost", "dead host, no row: nothing ran")
        self.assertEqual(self.classify(self.attempt(state="unknown")), "unknown")
        self.assertEqual(self.classify(self.attempt(state="intent")), "pending")
        self.assertEqual(self.classify(self.attempt(state="intent"), later=61), "unknown")
        self.assertEqual(self.classify(self.attempt(), held=True, later=9999), "pending", "queued behind a long turn")
        self.assertEqual(self.classify(self.attempt(), held=False, later=60), "pending")
        self.assertEqual(self.classify(self.attempt(), held=False, later=121), "unknown", "closed with a queued wake")
        self.add_turn("x [agent-peers-wake a1] y", done=False)
        self.assertEqual(self.classify(self.attempt()), "running")
        self.assertEqual(self.classify(self.attempt(), alive=False), "unknown", "turn started, host died")
        self.db.execute("INSERT INTO messages (session_id, role, content, timestamp, finish_reason) VALUES (?, 'assistant', '', ?, 'tool_calls')", (CHAT_A, self.now))
        self.db.commit()
        self.assertEqual(self.classify(self.attempt()), "running", "a tool-call step is not the end of the turn")
        self.db.execute("INSERT INTO messages (session_id, role, content, timestamp, finish_reason) VALUES (?, 'assistant', 'ok', ?, 'stop')", (CHAT_A, self.now))
        self.db.commit()
        self.assertEqual(self.classify(self.attempt(), alive=False), "handled")

    def test_ledger_name_matches_the_typescript_driver(self):
        self.assertEqual(dw.ledger_path(Path("/s"), "ezra", "20261028_100000_aaaaaa"),
                         Path("/s/chat-wake/ezra") / f"{LEDGER_VECTOR}.json")


class Lifecycle(Base):
    def test_unload_stops_the_worker(self):
        original = dw.POLL_SECONDS
        dw.POLL_SECONDS = 0.02
        try:
            ctx = FakeCtx(self.manager)
            os.environ.pop("AGENT_PEERS_WAKE_DISABLED", None)
            dw.register(ctx)
            self.assertEqual(len(ctx.unload), 1)
            workers = [t for t in threading.enumerate() if t.name == f"{dw.PLUGIN_NAME}:{PROFILE}"]
            self.assertTrue(workers and workers[0].is_alive())
            ctx.unload[0]()
            workers[0].join(timeout=2)
            self.assertFalse(workers[0].is_alive())
        finally:
            dw.POLL_SECONDS = original

    def test_register_env_kill_switch_starts_nothing(self):
        ctx = FakeCtx(self.manager)
        os.environ["AGENT_PEERS_WAKE_DISABLED"] = "1"
        try:
            dw.register(ctx)
        finally:
            os.environ.pop("AGENT_PEERS_WAKE_DISABLED", None)
        self.assertEqual(ctx.unload, [])


# Shared with tests/hermes-chat-wake.test.ts: the ledger file name for a chat key.
LEDGER_VECTOR = "ad69ef69c99512d6b0e552be05c19843"

if __name__ == "__main__":
    unittest.main(verbosity=2)
