"""
Two-bot overflow test: can a SECOND bot token absorb moves once the first bot's
member-move budget is exhausted?

The single-bot runs proved the move limit is 10 per ~10s on one guild bucket, with
429 scope=user (a per-bot limit). IF that's truly per-token, a second bot in the same
guild should get its OWN independent 10/10s budget — so it can keep moving players
while the first bot is rate-limited. IF the limit were actually shared per-guild, the
second bot would 429 immediately. This test settles it with evidence.

Requirements (run ON THE BOT SERVER):
  - BOT_TOKEN          : the main bot (already in .env)
  - MOVER_TOKEN        : the mover bot, in .env. Must be invited to the SAME guild with the
                         "Move Members" permission (it does NOT need to join voice itself).
                         (BOT_TOKEN_2 is also accepted as a fallback.)
  - DIAG_TARGET_USER_ID: a willing member connected to a voice channel in the guild
Optional:
  - DIAG_RESTORE_CHANNEL_ID (defaults to GENERAL_V_CHANNEL_ID)

    export DIAG_TARGET_USER_ID=<member_id>
    python ratelimit_diag_twobot.py        # exits 0 if PASS, 1 if FAIL/INCONCLUSIVE

Test cases:
  TC1  Bot A exhausts its budget in a fresh window (drives remaining -> 0, trips one 429).
  TC2  Bot B then moves in the SAME window. Independent token -> B gets a full fresh ~10.
  TC3  Both bots fire concurrently from a fresh window; count combined successes before
       any 429. Shared limit -> ~10 total; independent -> ~20 total.

Headline: if Bot B succeeds ~10 times right after Bot A is exhausted (same window), and
the combined concurrent total is ~2x the single-bot limit, a dedicated mover bot works.

Safety: each bot stops at its own first 429; bounded request counts; the member is always
restored and temp channels deleted in a finally block. Do NOT run while the live bot
operates on the same guild.
"""

import asyncio
import json
import logging
import os
import sys
import time

import aiohttp

from ratelimit_diag_common import (
    DISCORD_API_BASE,
    RateLimitRecord,
    RecordSink,
    extract_rl_headers,
    load_diag_config,
    now_iso,
)

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] [%(levelname)s] %(message)s")
logger = logging.getLogger("ratelimit_diag_twobot")

USER_AGENT = "DiscordBot (https://github.com/GargamelCoordinator, ratelimit-diag/1.0)"
WINDOW_WAIT_S = 11.0   # > the 10s reset window, to guarantee a clean start
MAX_PER_PHASE = 12     # cap moves per bot per phase (limit is 10, so 12 trips one 429)
PASS_THRESHOLD = 8     # "got a full fresh budget" if a bot lands >= this many successes


class RawBot:
    """One bot identity (token) issuing raw move PATCHes and logging every header."""

    def __init__(self, label: str, token: str, cfg: dict, sink: RecordSink):
        self.label = label
        self.token = token
        self.cfg = cfg
        self.sink = sink
        self.session: "aiohttp.ClientSession | None" = None
        self.seq = 0
        self._last_complete = None

    async def __aenter__(self):
        self.session = aiohttp.ClientSession(headers={
            "Authorization": f"Bot {self.token}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        })
        return self

    async def __aexit__(self, *exc):
        if self.session:
            await self.session.close()

    async def _api(self, method, path, json_body=None):
        url = f"{DISCORD_API_BASE}{path}"
        async with self.session.request(method, url, json=json_body) as resp:
            text = await resp.text()
            body = None
            if text:
                try:
                    body = json.loads(text)
                except json.JSONDecodeError:
                    body = None
            return resp.status, resp.headers, body

    def _record(self, phase, status, headers, body, dest):
        mono = time.monotonic()
        gap = None
        if self._last_complete is not None:
            gap = (mono - self._last_complete) * 1000.0
        self._last_complete = mono
        self.seq += 1
        rl = extract_rl_headers(headers, body)
        rec = RateLimitRecord(
            seq=self.seq, wall_clock_iso=now_iso(), monotonic_t=mono, phase=phase,
            http_status=status, request_gap_ms=gap, dest_channel_id=dest,
            source=self.label, note="", **rl,
        )
        self.sink.add(rec)
        logger.info(
            "[%s][%s] seq=%d status=%d bucket=%s limit=%s remaining=%s reset_after=%s "
            "scope=%s retry_after=%s",
            self.label, phase, rec.seq, status, rec.rl_bucket, rec.rl_limit,
            rec.rl_remaining, rec.rl_reset_after, rec.rl_scope, rec.retry_after,
        )
        return rec

    async def create_voice_channel(self, name) -> int:
        status, headers, body = await self._api(
            "POST", f"/guilds/{self.cfg['guild_id']}/channels", {"name": name, "type": 2})
        if status not in (200, 201) or not body or "id" not in body:
            raise RuntimeError(f"[{self.label}] failed to create '{name}': {status} {body}")
        ch = int(body["id"])
        logger.info("[%s] created temp voice channel '%s' = %d", self.label, name, ch)
        return ch

    async def delete_channel(self, ch):
        try:
            await self._api("DELETE", f"/channels/{ch}")
            logger.info("[%s] deleted temp channel %d", self.label, ch)
        except Exception as e:
            logger.warning("[%s] failed to delete %d: %s", self.label, ch, e)

    async def move(self, phase, dest) -> RateLimitRecord:
        status, headers, body = await self._api(
            "PATCH", f"/guilds/{self.cfg['guild_id']}/members/{self.cfg['target_user_id']}",
            {"channel_id": str(dest)})
        return self._record(phase, status, headers, body, dest)

    async def run_until_429(self, phase, toggle, max_n=MAX_PER_PHASE, spacing=0.0):
        """Fire moves (alternating destinations so each is a real move) until this bot's
        FIRST 429 or max_n. Returns (successes, got_429, first_remaining)."""
        successes = 0
        first_remaining = None
        for i in range(max_n):
            if i > 0 and spacing > 0:
                await asyncio.sleep(spacing)
            rec = await self.move(phase, toggle[i % len(toggle)])
            if first_remaining is None:
                first_remaining = rec.rl_remaining
            if rec.http_status == 429:
                return successes, True, first_remaining
            if 200 <= rec.http_status < 300:
                successes += 1
            else:
                logger.warning("[%s] unexpected status %d (%s) — stopping phase",
                               self.label, rec.http_status, phase)
                return successes, False, first_remaining
        return successes, False, first_remaining


async def main() -> int:
    cfg = load_diag_config()
    token_b = os.environ.get("MOVER_TOKEN") or os.environ.get("BOT_TOKEN_2")
    if not token_b:
        logger.error("MOVER_TOKEN is not set (expected in .env). It is the mover bot's token.")
        return 1
    if token_b == cfg["token"]:
        logger.error("MOVER_TOKEN is identical to BOT_TOKEN — need a DIFFERENT second bot.")
        return 1

    sink = RecordSink("twobot")
    logger.info("TWO-BOT overflow test starting. JSONL=%s CSV=%s", sink.jsonl.path, sink.csv.path)

    results = {}
    target = holding = None
    async with RawBot("botA", cfg["token"], cfg, sink) as A, \
               RawBot("botB", token_b, cfg, sink) as B:
        try:
            target = await A.create_voice_channel("RL-Diag-Target")
            holding = await A.create_voice_channel("RL-Diag-Holding")
            toggle = [target, holding]

            # Preconditions: member is in voice (A can move them) and B has Move Members.
            setup_a = await A.move("setup-A", target)
            if setup_a.http_status >= 300:
                logger.error("Bot A initial move returned %d — is the member connected to "
                             "voice? Aborting.", setup_a.http_status)
                return 1
            setup_b = await B.move("setup-B", holding)
            if setup_b.http_status == 403:
                logger.error("Bot B got 403 — the second bot is missing 'Move Members' (or "
                             "isn't in the guild / can't see the channel). Aborting.")
                return 1
            if setup_b.http_status >= 300:
                logger.error("Bot B initial move returned %d — aborting.", setup_b.http_status)
                return 1

            # ── TC1 + TC2: A exhausts, then B overflows in the SAME window ──
            logger.info("Waiting %.0fs for a clean rate-limit window...", WINDOW_WAIT_S)
            await asyncio.sleep(WINDOW_WAIT_S)

            logger.info("=== TC1: Bot A exhausts its budget ===")
            a_succ, a_429, _ = await A.run_until_429("TC1-A-exhaust", toggle)
            t_after_a = time.monotonic()
            a_last = next((r for r in reversed(sink.records) if r.source == "botA"), None)

            logger.info("=== TC2: Bot B moves in the SAME window (overflow) ===")
            b_succ, b_429, b_first_remaining = await B.run_until_429("TC2-B-overflow", toggle)
            # How far into A's window did B start? (confirms A's window hadn't reset)
            a_window_left = (a_last.rl_reset_after or 0.0) - (time.monotonic() - t_after_a)
            results.update(dict(a_succ=a_succ, a_429=a_429, b_succ=b_succ, b_429=b_429,
                                b_first_remaining=b_first_remaining,
                                a_window_left_at_b_start=round(a_window_left, 2)))

            # ── TC3: concurrent contention from a fresh window ──
            logger.info("Waiting %.0fs for a clean window before concurrent test...", WINDOW_WAIT_S)
            await asyncio.sleep(WINDOW_WAIT_S)
            logger.info("=== TC3: both bots fire concurrently ===")
            (a3_succ, a3_429, _), (b3_succ, b3_429, _) = await asyncio.gather(
                A.run_until_429("TC3-A-concurrent", toggle),
                B.run_until_429("TC3-B-concurrent", toggle),
            )
            results.update(dict(a3_succ=a3_succ, b3_succ=b3_succ,
                                combined_concurrent=a3_succ + b3_succ))

        finally:
            logger.info("=== Restoring member and deleting temp channels ===")
            recent_429 = [r for r in sink.records if r.http_status == 429]
            if recent_429:
                wait = (recent_429[-1].retry_after or 2.0) + 1.0
                logger.info("Backing off %.2fs after 429 before restore", wait)
                await asyncio.sleep(wait)
            restore = cfg["restore_channel_id"] or target
            if restore:
                try:
                    await A.move("restore", restore)
                except Exception as e:
                    logger.warning("Restore failed: %s", e)
            for ch in (target, holding):
                if ch:
                    await A.delete_channel(ch)
            sink.close()

    return verdict(sink, results)


def verdict(sink: RecordSink, r: dict) -> int:
    buckets_a = sorted({x.rl_bucket for x in sink.records if x.source == "botA" and x.rl_bucket})
    buckets_b = sorted({x.rl_bucket for x in sink.records if x.source == "botB" and x.rl_bucket})

    print("\n" + "=" * 64)
    print("TWO-BOT OVERFLOW VERDICT")
    print("=" * 64)
    print(f"Bot A bucket hash(es): {buckets_a}")
    print(f"Bot B bucket hash(es): {buckets_b}")
    same_bucket = bool(buckets_a) and buckets_a == buckets_b
    print(f"Same bucket hash for both bots: {same_bucket}")

    print(f"\nTC1  Bot A successes before 429: {r.get('a_succ')}  (got 429: {r.get('a_429')})")
    print(f"TC2  Bot B successes in A's window: {r.get('b_succ')}  (got 429: {r.get('b_429')})")
    print(f"     Bot B first 'remaining' seen: {r.get('b_first_remaining')}  "
          f"(A's window left when B started: {r.get('a_window_left_at_b_start')}s)")
    print(f"TC3  concurrent: A={r.get('a3_succ')} + B={r.get('b3_succ')} "
          f"= {r.get('combined_concurrent')} combined successes before any 429")

    a_exhausted = r.get("a_429") is True and (r.get("a_succ") or 0) >= PASS_THRESHOLD
    b_fresh = (r.get("b_succ") or 0) >= PASS_THRESHOLD
    b_started_in_a_window = (r.get("a_window_left_at_b_start") or 0) > 0
    combined_independent = (r.get("combined_concurrent") or 0) >= PASS_THRESHOLD * 2

    print("\n--- analysis ---")
    if not a_exhausted:
        print("INCONCLUSIVE: Bot A did not cleanly exhaust its budget (need a fresh window "
              "and a real 429). Re-run when the guild is quiet.")
        return 1
    if b_fresh and b_started_in_a_window:
        print("Bot B got a FULL fresh budget while Bot A was exhausted, within A's own "
              "rate-limit window -> the limit is PER-TOKEN, not shared per-guild.")
        if combined_independent:
            print(f"Concurrent run confirms it: {r.get('combined_concurrent')} combined "
                  f"successes (~2x the single-bot limit of ~10).")
        print("\nRESULT: PASS — a dedicated second 'mover' bot WILL absorb the overflow. "
              "Two independent 10/10s budgets (≈20 moves/10s combined), and moves can be "
              "isolated from the main bot's other member edits.")
        return 0
    else:
        print("Bot B was ALSO throttled despite a separate token "
              f"(B successes={r.get('b_succ')}, combined concurrent={r.get('combined_concurrent')}).")
        print("\nRESULT: FAIL — the limit behaves as SHARED per-guild for this route. A "
              "second bot would NOT help; pursue pacing/headroom instead.")
        return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
