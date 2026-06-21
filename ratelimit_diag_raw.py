"""
Raw-endpoint Discord rate-limit diagnostic (NO discord.py).

Calls PATCH /guilds/{guild_id}/members/{user_id} directly with aiohttp and zero
rate-limit handling, so we see the unfiltered server headers and the exact 429
envelope. This is the ground truth that the discord.py run (ratelimit_diag_library.py)
is compared against to decide whether the library throttles us before the server does.

What it proves:
  - H1: the X-RateLimit-Bucket is the same whether we move to ONE channel or alternate
        channels  -> the destination is in the body, the bucket is keyed by guild_id.
  - H2: the bucket's Limit / Reset-After == how many moves per window are actually allowed.
  - H4: concurrent (asyncio.gather, like end-of-game) vs sequential changes the 429 point.

Run ON THE BOT SERVER, with the willing member connected to voice:
    export DIAG_TARGET_USER_ID=<discord_user_id>
    python ratelimit_diag_raw.py

Safety: caps total requests, stops on the FIRST 429, always restores the member and
deletes the temp channels in a finally block. Never run while the live bot operates on
the same guild, and never concurrently with the library test (shared token + guild bucket).
"""

import asyncio
import json
import logging
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

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(message)s",
)
logger = logging.getLogger("ratelimit_diag_raw")

# A valid bot-shaped User-Agent is expected by Discord. No secrets in here.
USER_AGENT = "DiscordBot (https://github.com/GargamelCoordinator, ratelimit-diag/1.0)"
MAX_BURST_BATCH = 12  # don't let an escalating concurrent batch grow unbounded


class RawMover:
    def __init__(self, cfg: dict, sink: RecordSink):
        self.cfg = cfg
        self.sink = sink
        self.session: "aiohttp.ClientSession | None" = None
        self.seq = 0
        self._last_complete = None
        self.temp_channels: list[int] = []

    async def __aenter__(self):
        self.session = aiohttp.ClientSession(
            headers={
                "Authorization": f"Bot {self.cfg['token']}",
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
            }
        )
        return self

    async def __aexit__(self, *exc):
        if self.session:
            await self.session.close()

    async def _api(self, method: str, path: str, json_body=None):
        """One raw HTTP call. Returns (status, headers, parsed_body_or_None)."""
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

    def _record(self, phase, status, headers, body, dest_channel_id, note=""):
        mono = time.monotonic()
        gap = None
        if self._last_complete is not None:
            gap = (mono - self._last_complete) * 1000.0
        self._last_complete = mono
        self.seq += 1
        rl = extract_rl_headers(headers, body)
        rec = RateLimitRecord(
            seq=self.seq,
            wall_clock_iso=now_iso(),
            monotonic_t=mono,
            phase=phase,
            http_status=status,
            request_gap_ms=gap,
            dest_channel_id=dest_channel_id,
            source="raw",
            note=note,
            **rl,
        )
        self.sink.add(rec)
        logger.info(
            "[%s] seq=%d status=%d bucket=%s limit=%s remaining=%s reset_after=%s "
            "scope=%s retry_after=%s dest=%s",
            phase, rec.seq, status, rec.rl_bucket, rec.rl_limit, rec.rl_remaining,
            rec.rl_reset_after, rec.rl_scope, rec.retry_after, dest_channel_id,
        )
        return rec

    async def create_voice_channel(self, name: str) -> int:
        status, headers, body = await self._api(
            "POST", f"/guilds/{self.cfg['guild_id']}/channels",
            {"name": name, "type": 2},  # type 2 = guild voice
        )
        if status not in (200, 201) or not body or "id" not in body:
            raise RuntimeError(f"Failed to create voice channel '{name}': {status} {body}")
        ch_id = int(body["id"])
        self.temp_channels.append(ch_id)
        logger.info("Created temp voice channel '%s' = %d", name, ch_id)
        return ch_id

    async def move(self, phase: str, dest_channel_id: int, note: str = "") -> RateLimitRecord:
        status, headers, body = await self._api(
            "PATCH",
            f"/guilds/{self.cfg['guild_id']}/members/{self.cfg['target_user_id']}",
            {"channel_id": str(dest_channel_id)},
        )
        return self._record(phase, status, headers, body, dest_channel_id, note)

    # ── Pacing modes ────────────────────────────────────────────────────────
    async def run_sequential(self, phase, dests, spacing, note=""):
        for i, dest in enumerate(dests):
            if i > 0 and spacing > 0:
                await asyncio.sleep(spacing)
            await self.move(phase, dest, note)
            reason = self.sink.should_abort()
            if reason:
                logger.info("[%s] stopping: %s", phase, reason)
                return reason
        return None

    async def burst_until_429(self, phase, toggle):
        """Escalating CONCURRENT batches (mirrors production's asyncio.gather) until
        the first 429 or a safety cap. Each batch fires N moves at once with 0 stagger."""
        batch = 1
        while batch <= MAX_BURST_BATCH:
            dests = [toggle[i % len(toggle)] for i in range(batch)]
            await asyncio.gather(
                *[self.move(phase, d, note=f"concurrent batch={batch}") for d in dests],
                return_exceptions=True,
            )
            reason = self.sink.should_abort()
            if reason:
                logger.info("[%s] stopping burst: %s", phase, reason)
                return reason
            batch += 1
        return "reached MAX_BURST_BATCH without a 429"

    async def restore_and_cleanup(self, target_channel):
        # If we just tripped a 429, wait out the penalty so restore doesn't 429 too.
        recent_429 = [r for r in self.sink.records if r.http_status == 429]
        if recent_429:
            wait = (recent_429[-1].retry_after or 2.0) + 1.0
            logger.info("Backing off %.2fs after 429 before restore", wait)
            await asyncio.sleep(wait)
        restore = self.cfg["restore_channel_id"] or target_channel
        if restore:
            try:
                await self.move("restore", restore, note="restore member to home channel")
            except Exception as e:
                logger.warning("Restore move failed: %s", e)
        for ch in self.temp_channels:
            try:
                await self._api("DELETE", f"/channels/{ch}")
                logger.info("Deleted temp channel %d", ch)
            except Exception as e:
                logger.warning("Failed to delete temp channel %d: %s", ch, e)


async def main():
    cfg = load_diag_config()
    sink = RecordSink("raw")
    logger.info("RAW rate-limit diagnostic starting. JSONL=%s CSV=%s",
                sink.jsonl.path, sink.csv.path)

    target_channel = None
    async with RawMover(cfg, sink) as mover:
        try:
            target_channel = await mover.create_voice_channel("RL-Diag-Target")
            holding_channel = await mover.create_voice_channel("RL-Diag-Holding")

            # Move the member into the target first. If this isn't a 2xx, the member is
            # almost certainly not connected to voice — abort with a clear message.
            setup = await mover.move("setup", target_channel, note="initial move into target")
            if setup.http_status >= 300:
                logger.error(
                    "Initial move returned %d — is %s connected to a voice channel in "
                    "this guild? Aborting.", setup.http_status, cfg["target_user_id"],
                )
                return

            # Phase 1 — baseline, ALTERNATING destination, sequential @1s.
            # Establishes the true per-route limit and the bucket hash from real moves.
            logger.info("=== Phase 1: baseline alternating (sequential) ===")
            await mover.run_sequential(
                "A-baseline-seq",
                [holding_channel, target_channel, holding_channel, target_channel, holding_channel],
                spacing=1.0,
            )
            if sink.should_abort():
                return

            # Phase 2 — SAME-destination probe (mirrors end-of-game: everyone into one
            # channel). Redundant PATCH->target while already there; does it still consume
            # the bucket / share the same hash? (The core same-channel question.)
            logger.info("=== Phase 2: same-destination redundant probe (sequential) ===")
            await mover.move("setup", target_channel, note="ensure in target before probe")
            await mover.run_sequential(
                "S-redundant-seq",
                [target_channel] * 5,
                spacing=0.3,
                note="redundant same-channel PATCH",
            )
            if sink.should_abort():
                return

            # Phase 3 — concurrent burst to force exactly one 429 (mirrors gather).
            logger.info("=== Phase 3: concurrent burst until first 429 ===")
            await mover.burst_until_429("A-burst-concurrent", [target_channel, holding_channel])

        finally:
            logger.info("=== Restoring member and cleaning up temp channels ===")
            await mover.restore_and_cleanup(target_channel)
            sink.close()

    # Quick summary
    buckets = sorted({r.rl_bucket for r in sink.records if r.rl_bucket})
    first_429 = next((r for r in sink.records if r.http_status == 429), None)
    logger.info("Distinct X-RateLimit-Bucket hashes seen: %s", buckets)
    if first_429:
        logger.info(
            "First 429 envelope: scope=%s global=%s retry_after=%s (limit=%s)",
            first_429.rl_scope, first_429.rl_global, first_429.retry_after, first_429.rl_limit,
        )
    else:
        logger.info("No 429 captured within the safety cap.")
    logger.info("Done. Records: %d (429s: %d). See %s",
                len(sink.records), sink.count_429, sink.jsonl.path)


if __name__ == "__main__":
    asyncio.run(main())
