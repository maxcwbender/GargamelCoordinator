"""
discord.py Discord rate-limit diagnostic (uses member.move_to, like the real bot).

Purpose: determine whether discord.py pauses us CLIENT-SIDE (its internal per-bucket
lock / pre-emptive sleep when X-RateLimit-Remaining hits 0) before the server ever
returns a 429 — i.e. whether the library, not Discord, is the source of the end-of-game
pause. Compared against ratelimit_diag_raw.py (raw, no library) which is the ground truth.

How we observe without altering behavior: we wrap aiohttp.ClientSession._request (the call
discord.py's HTTPClient uses under the hood) to read each response's status + X-RateLimit-*
headers and the wall-clock gap between actual HTTP sends. We never touch the body or change
the result. discord.py's own DEBUG narrative (bucket locks, pre-emptive sleeps) is captured
to logs/Discord_HTTP_<ts>.txt via the existing setup_logging() handler.

Key tell:
  - LARGE gap between sends with NO 429  -> discord.py slept client-side (pre-emptive).
  - actual 429 status in the stream      -> the server limited us (library just retried).

Run ON THE BOT SERVER, member connected to voice, NOT concurrently with the raw test:
    export DIAG_TARGET_USER_ID=<discord_user_id>
    python ratelimit_diag_library.py
"""

import asyncio
import logging
import os
import time

os.makedirs("logs", exist_ok=True)

import aiohttp
import discord

from logger import setup_logging
from ratelimit_diag_common import (
    RateLimitRecord,
    RecordSink,
    extract_rl_headers,
    load_diag_config,
    now_iso,
)

setup_logging()
logger = logging.getLogger("ratelimit_diag_library")


# ─── Observe-only recorder, fed by the aiohttp wrapper ──────────────────────
class _LibRecorder:
    def __init__(self):
        self.sink: "RecordSink | None" = None
        self.phase = "idle"
        self.recording = False
        self.seq = 0
        self._last_complete = None

    def record(self, method, url, status, headers):
        if not self.recording or self.sink is None:
            return
        # Only the member-move route: PATCH /guilds/{id}/members/{id}
        if method.upper() != "PATCH" or "/members/" not in str(url):
            return
        mono = time.monotonic()
        gap = None
        if self._last_complete is not None:
            gap = (mono - self._last_complete) * 1000.0
        self._last_complete = mono
        self.seq += 1
        rl = extract_rl_headers(headers, None)
        note = ""
        # Heuristic flag: a big gap with no 429 strongly implies a library-side wait.
        if status != 429 and gap is not None and gap > 750:
            note = "possible library pre-emptive wait"
        rec = RateLimitRecord(
            seq=self.seq,
            wall_clock_iso=now_iso(),
            monotonic_t=mono,
            phase=self.phase,
            http_status=status,
            request_gap_ms=gap,
            dest_channel_id=None,  # destination is in the discord.py body, not visible here
            source="library",
            note=note,
            **rl,
        )
        self.sink.add(rec)
        logger.info(
            "[%s] seq=%d status=%d bucket=%s limit=%s remaining=%s reset_after=%s "
            "gap_ms=%s scope=%s retry_after=%s%s",
            self.phase, rec.seq, status, rec.rl_bucket, rec.rl_limit, rec.rl_remaining,
            rec.rl_reset_after, None if gap is None else round(gap, 1), rec.rl_scope,
            rec.retry_after, f"  <-- {note}" if note else "",
        )


REC = _LibRecorder()

# Wrap aiohttp's low-level request. Affects only this process. Observe-only: we read
# headers/status off the response and return it untouched so discord.py behaves normally.
_orig_request = aiohttp.ClientSession._request


async def _patched_request(self, method, str_or_url, **kwargs):
    resp = await _orig_request(self, method, str_or_url, **kwargs)
    try:
        REC.record(method, str_or_url, resp.status, resp.headers)
    except Exception:  # never let diagnostics break a real request
        pass
    return resp


aiohttp.ClientSession._request = _patched_request


def _log_version_and_internals():
    logger.info("discord.py version: %s", getattr(discord, "__version__", "unknown"))
    try:
        import discord.http as dhttp
        logger.info(
            "discord.http internals present: HTTPClient=%s Ratelimit=%s MaybeUnlock=%s",
            hasattr(dhttp, "HTTPClient"), hasattr(dhttp, "Ratelimit"),
            hasattr(dhttp, "MaybeUnlock"),
        )
    except Exception as e:
        logger.info("Could not introspect discord.http: %s", e)


async def _move(member, channel, phase, note=""):
    REC.phase = phase
    try:
        await member.move_to(channel)
    except discord.HTTPException as e:
        logger.warning("[%s] move_to failed: %s %s", phase, e.status, e.text)
    except Exception as e:
        logger.warning("[%s] move_to error: %s", phase, e)


async def run_diagnostic(client: discord.Client, cfg: dict, sink: RecordSink):
    guild = client.get_guild(cfg["guild_id"])
    if guild is None:
        logger.error("Bot is not in guild %s. Aborting.", cfg["guild_id"])
        return

    member = guild.get_member(cfg["target_user_id"])
    if member is None:
        member = await guild.fetch_member(cfg["target_user_id"])

    if member.voice is None or member.voice.channel is None:
        logger.error("Target member %s is not connected to voice. Aborting.",
                     cfg["target_user_id"])
        return
    original_channel = member.voice.channel
    logger.info("Target %s is in voice channel '%s'", member.display_name, original_channel.name)

    target = await guild.create_voice_channel("RL-Diag-Target")
    holding = await guild.create_voice_channel("RL-Diag-Holding")
    temp_channels = [target, holding]

    try:
        REC.recording = True

        # Phase 1 — baseline alternating, sequential @1s (real moves -> bucket + limit).
        logger.info("=== Phase 1: baseline alternating (sequential) ===")
        for i, ch in enumerate([target, holding, target, holding, target]):
            if i > 0:
                await asyncio.sleep(1.0)
            await _move(member, ch, "A-baseline-seq")
            if sink.should_abort():
                return

        # Phase 2 — same-destination redundant probe (mirrors end-of-game: one channel).
        logger.info("=== Phase 2: same-destination redundant probe (sequential) ===")
        await _move(member, target, "setup")
        for _ in range(5):
            await asyncio.sleep(0.3)
            await _move(member, target, "S-redundant-seq", note="redundant same-channel")
            if sink.should_abort():
                return

        # Phase 3 — EXACT end-of-game replica: 10 concurrent move_to into ONE channel via
        # asyncio.gather with the production 0.15*index stagger. Watch whether discord.py's
        # bucket lock serializes these (gaps, no 429) vs. real 429s.
        logger.info("=== Phase 3: end-of-game replica (10 concurrent move_to into one channel) ===")
        REC.phase = "S-endgame-concurrent"

        async def _staggered(idx):
            if idx > 0:
                await asyncio.sleep(0.15 * idx)
            await _move(member, target, "S-endgame-concurrent",
                        note=f"endgame gather idx={idx}")

        await asyncio.gather(*[_staggered(i) for i in range(10)], return_exceptions=True)

    finally:
        REC.recording = False
        logger.info("=== Restoring member and deleting temp channels ===")
        try:
            await member.move_to(original_channel)
        except Exception as e:
            logger.warning("Restore failed: %s", e)
        for ch in temp_channels:
            try:
                await ch.delete()
            except Exception as e:
                logger.warning("Failed to delete %s: %s", ch, e)


async def main():
    cfg = load_diag_config()
    sink = RecordSink("library")
    REC.sink = sink
    _log_version_and_internals()
    logger.info("LIBRARY rate-limit diagnostic starting. JSONL=%s CSV=%s",
                sink.jsonl.path, sink.csv.path)

    intents = discord.Intents.default()
    intents.members = True
    client = discord.Client(intents=intents)

    @client.event
    async def on_ready():
        logger.info("Logged in as %s", client.user)
        try:
            await run_diagnostic(client, cfg, sink)
        finally:
            await client.close()

    try:
        await client.start(cfg["token"])
    finally:
        sink.close()
        buckets = sorted({r.rl_bucket for r in sink.records if r.rl_bucket})
        waits = [r for r in sink.records if "pre-emptive" in (r.note or "")]
        first_429 = next((r for r in sink.records if r.http_status == 429), None)
        logger.info("Distinct X-RateLimit-Bucket hashes: %s", buckets)
        logger.info("Suspected library pre-emptive waits: %d | real 429s: %d",
                    len(waits), sink.count_429)
        if first_429:
            logger.info("First 429: scope=%s global=%s retry_after=%s",
                        first_429.rl_scope, first_429.rl_global, first_429.retry_after)
        logger.info("Done. Records: %d. See %s", len(sink.records), sink.jsonl.path)


if __name__ == "__main__":
    asyncio.run(main())
