"""Unit tests for hermes-plugins/agent-peers-desktop-wake (fake Hermes ctx, real files).

Run: python3 tests/python/test_hermes_desktop_wake.py  (bun test runs it too).
DESKTOP_WAKE_PLUGIN=<path to __init__.py> runs the same tests against another copy of
the plugin; the Ap10806Regressions class uses only APIs that 4e5fd81 also had, so it
can show each of Marco's findings red on that commit and green here.
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
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
PLUGIN = Path(os.environ.get("DESKTOP_WAKE_PLUGIN") or ROOT / "hermes-plugins" / "agent-peers-desktop-wake" / "__init__.py")
SPEC = importlib.util.spec_from_file_location("agent_peers_desktop_wake", PLUGIN)
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
        self.hooks: dict[str, list] = {}
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

    def register_hook(self, name, callback):
        self.hooks.setdefault(name, []).append(callback)

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
        """Transcript rows only. The plugin no longer reads them; tests use them to prove that."""
        self.db.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', ?, ?)", (session, content, self.now))
        if done:
            self.db.execute("INSERT INTO messages (session_id, role, content, timestamp, finish_reason) VALUES (?, 'assistant', 'ok', ?, 'stop')", (session, self.now))
        self.db.commit()

    def turn(self, prompt, session: str = CHAT_A, turn_id: str = "t1", end: bool = True) -> None:
        """What Hermes does for one turn: pre_llm_call at the start, post_llm_call after persistence."""
        self.assertIsNone(self.wake.on_pre_llm_call(session_id=session, task_id="x", turn_id=turn_id, user_message=prompt,
                                                    conversation_history=[], is_first_turn=False, model="m", platform="desktop"))
        if end:
            self.assertIsNone(self.wake.on_post_llm_call(session_id=session, task_id="x", turn_id=turn_id, user_message=prompt,
                                                         assistant_response="done", conversation_history=[], model="m", platform="desktop"))

    def evidence(self, attempt_id: str, kind: str) -> Path:
        return self.state / "chat-wake" / PROFILE / "evidence" / f"{attempt_id}.{kind}.json"


class Ap10806Regressions(Base):
    """Marco AP10806 findings 1-5. Red on 4e5fd81, green on this revision."""

    def setUp(self) -> None:
        super().setUp()
        self.opt_in(f"ezra {CHAT_A}\n")

    def test_f1_provisional_assistant_rows_never_settle_the_wake(self):
        self.wake.tick()
        self.add_turn(self.ctx.calls[0]["content"], done=False)
        for reason in ("verification_required", "verify_hook_continue", "stop"):
            self.db.execute("INSERT INTO messages (session_id, role, content, timestamp, finish_reason) VALUES (?, 'assistant', 'interim', ?, ?)",
                            (CHAT_A, self.now, reason))
            self.db.commit()
            self.wake.settle_own()
            led = self.ledger()
            self.assertNotEqual(led["state"], "done", f"a transcript row ({reason}) is not the wake's own turn ending")
            self.assertEqual(led["handled_max_id"], 0)
            self.assertIsNotNone(led["desktop_attempt"])

    def test_f2_unreadable_transcript_with_dead_host_is_unknown_not_lost(self):
        self.wake.tick()
        self.add_turn(self.ctx.calls[0]["content"], done=False)
        path = dw.ledger_path(self.state, PROFILE, CHAT_A)
        led = self.ledger()
        led["desktop_attempt"]["state"] = "unknown"
        self.alive.clear()
        with patch.object(dw, "open_ro", return_value=None):
            self.wake._settle(path, led)
        after = self.ledger()
        self.assertEqual(after["state"], "desktop_unknown")
        self.assertIsNotNone(after["desktop_attempt"], "uncertain stays open for the operator")
        self.alive.add(HOST)
        self.entries[1]["max_id"] = 15
        self.wake.tick()
        self.assertEqual(len(self.ctx.calls), 1, "no automatic re-inject")

    def test_f3_lock_owner_is_published_atomically(self):
        ledger = self.tmp / "chat.json"
        original_fdopen = os.fdopen
        second = []
        armed = [True]

        def during_create(fd, *args, **kwargs):
            if armed[0]:
                armed[0] = False
                second.append(dw.acquire_lock(ledger, wait=0))
            return original_fdopen(fd, *args, **kwargs)
        with patch.object(dw.os, "fdopen", side_effect=during_create):
            first = dw.acquire_lock(ledger, wait=0)
        self.assertFalse(first is not None and second[0] is not None, "two simultaneous owners")
        for release in (first, second[0]):
            if release:
                release()

    def test_f3_live_holder_is_never_reaped_on_age(self):
        ledger = self.tmp / "chat.json"
        lock = self.tmp / "chat.json.lock"
        lock.write_text(json.dumps({"pid": os.getpid(), "token": "someone-else"}))
        self.assertIsNone(dw.acquire_lock(ledger, wait=0))
        lock.write_text(f"{os.getpid()} {int(time.time() * 1000) - 31_000}")  # old format, "stale" by age
        self.assertIsNone(dw.acquire_lock(ledger, wait=0))
        self.assertTrue(lock.exists())

    def test_f3_release_checks_the_owner(self):
        ledger = self.tmp / "chat.json"
        lock = self.tmp / "chat.json.lock"
        release = dw.acquire_lock(ledger, wait=0)
        self.assertIsNotNone(release)
        lock.write_text(json.dumps({"pid": os.getpid(), "token": "successor"}))  # reaped and retaken meanwhile
        release()
        self.assertTrue(lock.exists(), "release removed another owner's lock")

    def test_f4_cancellation_survives_settlement(self):
        self.wake.tick()
        path = dw.ledger_path(self.state, PROFILE, CHAT_A)
        led = self.ledger()
        led["state"] = "cancelled"
        dw.atomic_write_json(path, led)
        self.wake.tick()
        self.assertEqual(self.ledger()["state"], "cancelled")
        self.alive.clear()
        self.wake._settle(path, self.ledger())
        self.assertEqual(self.ledger()["state"], "cancelled")
        self.alive.add(HOST)
        self.add_turn(self.ctx.calls[0]["content"])
        self.entries[1]["max_id"] = 15
        self.wake.tick()
        self.assertEqual(self.ledger()["state"], "cancelled")
        self.assertEqual(len(self.ctx.calls), 1)

    def test_f5_exact_chat_opt_in_is_rechecked_after_the_inbox_read(self):
        entries = list(self.entries)

        def opt_out():
            self.opt_in("")
            return entries
        self.wake.inbox = opt_out
        self.wake.tick()
        self.assertEqual(self.ctx.calls, [])

        def swap_to_b():
            self.opt_in(f"ezra {CHAT_B}\n")  # a different chat's opt-in does not cover A
            return [entries[1]]
        self.opt_in(f"ezra {CHAT_A}\n")
        self.wake.inbox = swap_to_b
        self.wake.tick()
        self.assertEqual(self.ctx.calls, [])


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

    def test_kill_switch_after_the_inbox_read_stops_before_the_intent(self):
        self.opt_in(f"ezra {CHAT_A}\n")
        entries = list(self.entries)

        def inbox():
            (self.state / "disabled").write_text("")
            return entries
        self.wake.inbox = inbox
        events = self.wake.tick()
        self.assertEqual(self.ctx.calls, [])
        self.assertEqual(events[-1]["action"], "skip")
        self.assertIn("disabled", events[-1]["why"])
        self.assertFalse(dw.ledger_path(self.state, PROFILE, CHAT_A).exists(), "no intent written")

    def test_kill_switch_or_opt_out_after_the_intent_stops_the_inject(self):
        for flip in (lambda: (self.state / "disabled").write_text(""), lambda: self.opt_in(f"ezra {CHAT_B}\n")):
            self.opt_in(f"ezra {CHAT_A}\n")
            (self.state / "disabled").unlink(missing_ok=True)
            dw.ledger_path(self.state, PROFILE, CHAT_A).unlink(missing_ok=True)
            original = self.wake._save

            def save(path, ledger, state, detail, original=original, flip=flip):
                original(path, ledger, state, detail)
                if "intent" in detail:
                    flip()
            self.wake._save = save
            events = self.wake.tick()
            self.wake._save = original
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
        (path.parent / (path.name + ".lock")).write_text(json.dumps({"pid": os.getpid(), "start": dw.self_start(), "token": "t"}))
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
        self.now += 3600  # a cooldown would have expired; the open attempt still blocks
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

    def test_the_wakes_own_turn_settles_it_and_only_new_mail_wakes_again(self):
        self.wake.tick()
        attempt = self.ledger()["desktop_attempt"]
        prompt = f"Mike: please also check the drums\n\n{self.ctx.calls[0]['content']}"  # merged with Mike's text
        self.turn(prompt, end=False)
        self.assertTrue(self.evidence(attempt["attempt_id"], "started").exists())
        self.wake.tick()
        led = self.ledger()
        self.assertEqual(led["desktop_attempt"]["attempt_id"], attempt["attempt_id"], "a running turn waits")
        self.assertIn("turn started", led["detail"])
        self.wake.on_post_llm_call(session_id=CHAT_A, turn_id="t1", user_message=prompt, assistant_response="done")
        self.wake.tick()  # settles handled; the same max_id is not woken again
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

    def test_hooks_record_only_the_wakes_own_turn(self):
        self.wake.tick()
        aid = self.ledger()["desktop_attempt"]["attempt_id"]
        prompt = self.ctx.calls[0]["content"]
        self.turn("Mike typed this; no marker")
        self.turn(prompt, session=CHAT_B)  # the marker in another chat's turn
        self.assertFalse(self.evidence(aid, "started").exists())
        other = dw.DesktopWake(self.ctx, env=self.env, clock=lambda: self.now, pid=5555, alive=lambda pid: True, inbox=lambda: [])
        other.on_pre_llm_call(session_id=CHAT_A, turn_id="t9", user_message=prompt)  # another process
        self.assertFalse(self.evidence(aid, "started").exists())
        self.turn(prompt, turn_id="t1", end=False)
        self.wake.on_post_llm_call(session_id=CHAT_A, turn_id="t2", user_message=prompt)  # a different turn's end
        self.assertFalse(self.evidence(aid, "ended").exists())
        self.wake.settle_own()
        self.assertEqual(self.ledger()["state"], "waiting_desktop")
        self.wake.on_post_llm_call(session_id=CHAT_A, turn_id="t1", user_message=[{"type": "text", "text": prompt}])
        self.assertTrue(self.evidence(aid, "ended").exists())
        self.wake.settle_own()
        self.assertEqual(self.ledger()["state"], "done")

    def test_closed_with_the_wake_queued_is_unknown_never_reinjected_until_operator_clear(self):
        self.wake.tick()
        self.hold(CHAT_B)  # Mike closed chat A; Hermes drops a queued prompt at close
        self.wake.settle_own()
        self.assertEqual(self.ledger()["state"], "desktop_unknown")
        self.hold(CHAT_A, CHAT_B)  # reopened, and new mail arrives
        self.entries[1]["max_id"] = 15
        self.now += 7200
        self.wake.tick()
        self.assertEqual(len(self.ctx.calls), 1, "no automatic re-inject")
        # What cli.ts hermes-desktop-clear writes; after it the next tick may wake again.
        led = self.ledger()
        led["last_desktop_attempt"] = {**led["desktop_attempt"], "outcome": "cleared"}
        led["desktop_attempt"] = None
        led["state"] = "waiting_desktop"
        dw.atomic_write_json(dw.ledger_path(self.state, PROFILE, CHAT_A), led)
        self.wake.tick()
        self.assertEqual(len(self.ctx.calls), 2)

    def test_late_evidence_still_settles_an_unknown_attempt(self):
        self.wake.tick()
        prompt = self.ctx.calls[0]["content"]
        self.hold(CHAT_B)
        self.wake.settle_own()
        self.assertEqual(self.ledger()["state"], "desktop_unknown")
        self.turn(prompt)
        self.wake.settle_own()
        self.assertEqual(self.ledger()["state"], "done")

    def test_duplicate_text_dropped_while_returning_true_stays_pending_and_blocks(self):
        # _enqueue_prompt may drop an exact duplicate of the in-flight text and still return True.
        self.wake.tick()
        for _ in range(3):
            self.now += 3600
            self.entries[1]["max_id"] += 1
            self.wake.tick()
        led = self.ledger()
        self.assertEqual(led["state"], "waiting_desktop")
        self.assertEqual(led["desktop_attempt"]["state"], "accepted")
        self.assertEqual(len(self.ctx.calls), 1, "pending blocks re-wake; only evidence or an operator ends it")

    def test_lineage_after_compression_rekey(self):
        self.wake.tick()
        prompt = self.ctx.calls[0]["content"]
        self.db.execute("UPDATE sessions SET end_reason = 'compression' WHERE id = ?", (CHAT_A,))
        self.db.execute("INSERT INTO sessions (id, source, parent_session_id, started_at) VALUES ('tip', 'desktop', ?, ?)", (CHAT_A, T0 + 1))
        self.db.commit()
        self.hold("tip", CHAT_B)  # the registry entry is re-keyed to the tip
        self.wake.settle_own()
        self.assertEqual(self.ledger()["state"], "waiting_desktop", "still held through the lineage")
        self.turn(prompt, session="tip")
        self.wake.settle_own()
        self.assertEqual(self.ledger()["state"], "done")
        self.entries[1]["max_id"] = 20
        self.wake.tick()
        self.assertEqual(self.ctx.calls[-1]["session_key"], "tip", "inject target is the registry entry's session_id")
        self.assertEqual(self.ledger()["desktop_attempt"]["chat_key"], CHAT_A)

    def test_unreadable_evidence_or_registry_is_unknown(self):
        self.wake.tick()
        aid = self.ledger()["desktop_attempt"]["attempt_id"]
        self.evidence(aid, "started").parent.mkdir(parents=True, exist_ok=True)
        self.evidence(aid, "started").write_text("{not json")
        self.wake.settle_own()
        self.assertEqual(self.ledger()["state"], "desktop_unknown")
        self.evidence(aid, "started").unlink()
        led = self.ledger()
        led["desktop_attempt"]["state"] = "accepted"
        dw.atomic_write_json(dw.ledger_path(self.state, PROFILE, CHAT_A), led)
        (self.home / "runtime" / "active_sessions.json").write_text("{broken")
        self.wake.settle_own()
        self.assertEqual(self.ledger()["state"], "desktop_unknown")

    def test_reused_host_pid_is_not_the_host(self):
        self.wake.host_start = "Sat Nov  1 09:00:00 2026"
        self.wake.tick()
        self.assertEqual(self.ledger()["desktop_attempt"]["host_start"], "Sat Nov  1 09:00:00 2026")
        self.wake.start_of = lambda pid: "Sat Nov  1 11:00:00 2026"  # same pid, different process
        self.wake.settle_own()
        self.assertEqual(self.ledger()["state"], "desktop_unknown")

    def test_cancelled_ledger_keeps_cancelled_when_its_attempt_settles_handled(self):
        self.wake.tick()
        prompt = self.ctx.calls[0]["content"]
        led = self.ledger()
        led["state"] = "cancelled"
        dw.atomic_write_json(dw.ledger_path(self.state, PROFILE, CHAT_A), led)
        self.turn(prompt)
        self.wake.settle_own()
        led = self.ledger()
        self.assertEqual(led["state"], "cancelled")
        self.assertIsNone(led["desktop_attempt"])
        self.assertEqual(led["last_desktop_attempt"]["outcome"], "handled")

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

    def test_rules(self):
        none = {"started": None, "ended": None}
        started = {"started": {"attempt_id": "a1"}, "ended": None}
        ended = {"started": {"attempt_id": "a1"}, "ended": {"attempt_id": "a1"}}

        def c(ev, att, alive=True, held=True, later=0.0):
            return dw.classify_attempt(ev, att, alive, held, self.now + later)
        self.assertEqual(c(None, self.attempt()), "unknown", "unreadable evidence is never a negative")
        self.assertEqual(c(none, self.attempt(), alive=False), "unknown", "a dead host proves nothing")
        self.assertEqual(c(none, self.attempt(state="unknown")), "unknown")
        self.assertEqual(c(none, self.attempt(state="intent")), "pending")
        self.assertEqual(c(none, self.attempt(state="intent"), later=61), "unknown")
        self.assertEqual(c(none, self.attempt(), later=99999), "pending", "queued behind a long turn")
        self.assertEqual(c(none, self.attempt(), held=False), "unknown", "closed with a queued wake")
        self.assertEqual(c(none, self.attempt(), held=None), "unknown", "registry unreadable")
        self.assertEqual(c(started, self.attempt()), "running")
        self.assertEqual(c(started, self.attempt(), alive=False), "unknown", "turn started, host died")
        self.assertEqual(c(ended, self.attempt(state="unknown"), alive=False, held=None), "handled")

    def test_lock_reaps_only_dead_or_reused_holders_and_restores_a_fresh_one(self):
        ledger = self.tmp / "chat.json"
        lock = self.tmp / "chat.json.lock"
        lock.write_text(json.dumps({"pid": 999_999, "start": None, "token": "dead"}))
        release = dw.acquire_lock(ledger, wait=0)
        self.assertIsNotNone(release)
        release()
        lock.write_text(json.dumps({"pid": os.getpid(), "start": "Thu Jan  1 00:00:00 1970", "token": "reused"}))
        release = dw.acquire_lock(ledger, wait=0)
        self.assertIsNotNone(release)
        release()
        lock.write_text("fresh")
        dw._reap(lock, "what we judged")
        self.assertEqual(lock.read_text(), "fresh")

    def test_ledger_name_matches_the_typescript_driver(self):
        self.assertEqual(dw.ledger_path(Path("/s"), "ezra", "20261028_100000_aaaaaa"),
                         Path("/s/chat-wake/ezra") / f"{LEDGER_VECTOR}.json")


class Lifecycle(Base):
    def test_register_hooks_and_unload_stops_the_worker(self):
        original = dw.POLL_SECONDS
        dw.POLL_SECONDS = 0.02
        try:
            ctx = FakeCtx(self.manager)
            os.environ.pop("AGENT_PEERS_WAKE_DISABLED", None)
            dw.register(ctx)
            self.assertEqual(sorted(ctx.hooks), ["post_llm_call", "pre_llm_call"])
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
        self.assertEqual(ctx.hooks, {})


# Shared with tests/hermes-chat-wake.test.ts: the ledger file name for a chat key.
LEDGER_VECTOR = "ad69ef69c99512d6b0e552be05c19843"

if __name__ == "__main__":
    unittest.main(verbosity=2)
