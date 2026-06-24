"""
Mover microservice — performs ALL Gargamel player voice-moves on a POOL of dedicated
bot tokens, isolated from the main bot's other member edits.

Why this exists: Discord limits PATCH /guilds/{guild_id}/members/{user_id} to 10 requests
per ~10s on one bucket keyed by guild_id, scope=user (per-token). When the main bot mixes
moves with its other member edits (roles/nicks), a full 10-player lobby overruns the window
and discord.py silently stalls ~10s. The limit is PER TOKEN, so this service spreads moves
across a pool of mover tokens (MOVER_TOKEN, MOVER_TOKEN_2, ...) for near-instant bursts and
keeps moves off the main bot's bucket entirely. See RATELIMIT_DIAG.md for the proof.

REST-only (no discord.py gateway): a move is fully expressed as (guild_id, user_id, channel_id).

Run on the bot server (each pool bot invited to the guild with Move Members):
    python mover_service.py            # binds 127.0.0.1:MOVER_PORT (default 9997)

Endpoints:
    POST /moves   {guild_id, moves:[{user_id, channel_id}]} -> per-move results
    GET  /health  pool size + per-token budget (no Discord call)
"""

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass

import aiohttp
from aiohttp import web

from ratelimit_diag_common import DISCORD_API_BASE, extract_rl_headers

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] [%(levelname)s] %(message)s")
logger = logging.getLogger("mover_service")

USER_AGENT = "DiscordBot (https://github.com/GargamelCoordinator, mover-service/1.0)"
DEFAULT_LIMIT = 10        # Discord's member-move limit; reconciled from real headers
DEFAULT_WINDOW = 10.0     # seconds; reconciled from X-RateLimit-Reset-After
MAX_RETRIES = 3           # defensive: bounded retries if a 429 ever slips through
RESET_MARGIN = 0.1        # pad the reconciled window so we never roll before Discord does


@dataclass
class Move:
    user_id: int
    channel_id: int


def discover_tokens() -> list[str]:
    """MOVER_TOKEN, then MOVER_TOKEN_2, _3, ... until a gap. De-duped, order preserved."""
    tokens = []
    primary = os.environ.get("MOVER_TOKEN")
    if primary:
        tokens.append(primary)
    i = 2
    while True:
        t = os.environ.get(f"MOVER_TOKEN_{i}")
        if not t:
            break
        tokens.append(t)
        i += 1
    seen, out = set(), []
    for t in tokens:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


class TokenLane:
    """One mover token's session + its local view of the guild move bucket.

    Budget is reserved OPTIMISTICALLY under `lock` (the gate that prevents oversend),
    then RECONCILED conservatively against the authoritative X-RateLimit-* headers."""

    def __init__(self, session, label, limit=DEFAULT_LIMIT, window=DEFAULT_WINDOW):
        self.session = session
        self.label = label
        self.lock = asyncio.Lock()
        self.limit = float(limit)
        self.window = float(window)
        self.remaining = float(limit)
        self.reset_at = time.monotonic() + window


class MoverPool:
    def __init__(self, lanes: list[TokenLane]):
        self.lanes = lanes

    async def acquire_slot(self) -> TokenLane:
        """Reserve one request slot on whichever lane has budget. If all lanes are
        momentarily exhausted, sleep until the soonest window reset and retry (so moves
        queue and never 429 by design). Check-and-decrement happens under the lane lock."""
        while True:
            soonest = None
            # Prefer the lane with the most remaining so 20 moves split 10/10 across 2 tokens.
            for lane in sorted(self.lanes, key=lambda l: l.remaining, reverse=True):
                async with lane.lock:
                    now = time.monotonic()
                    if now >= lane.reset_at:
                        lane.remaining = lane.limit
                        lane.reset_at = now + lane.window
                    if lane.remaining >= 1:
                        lane.remaining -= 1
                        return lane
                    if soonest is None or lane.reset_at < soonest:
                        soonest = lane.reset_at
            wait = max(0.0, (soonest or time.monotonic()) - time.monotonic()) + 0.01
            await asyncio.sleep(min(wait, 1.0))

    async def _reconcile(self, lane: TokenLane, status: int, headers, body):
        """Correct the lane's local budget from the real response headers. Only ever
        TIGHTENS remaining mid-window (min), so it never fights concurrent reservations."""
        rl = extract_rl_headers(headers, body)
        async with lane.lock:
            now = time.monotonic()
            if rl["rl_limit"] is not None:
                lane.limit = float(rl["rl_limit"])
            if rl["rl_reset_after"] is not None:
                lane.reset_at = now + float(rl["rl_reset_after"]) + RESET_MARGIN
                lane.window = float(rl["rl_reset_after"]) or lane.window
            if status == 429:
                lane.remaining = 0.0
                retry = rl["retry_after"] or rl["rl_reset_after"] or lane.window
                lane.reset_at = now + float(retry) + RESET_MARGIN
            elif rl["rl_remaining"] is not None:
                lane.remaining = min(lane.remaining, float(rl["rl_remaining"]))

    async def _raw_move(self, lane: TokenLane, guild_id: int, move: Move):
        url = f"{DISCORD_API_BASE}/guilds/{guild_id}/members/{move.user_id}"
        async with lane.session.request(
            "PATCH", url, json={"channel_id": str(move.channel_id)}
        ) as resp:
            text = await resp.text()
            body = None
            if text:
                try:
                    body = json.loads(text)
                except json.JSONDecodeError:
                    body = None
            return resp.status, resp.headers, body

    async def dispatch_one(self, guild_id: int, move: Move, retries: int = 0) -> dict:
        lane = await self.acquire_slot()
        try:
            status, headers, body = await self._raw_move(lane, guild_id, move)
        except aiohttp.ClientError as e:
            logger.warning("[%s] move %s->%s transport error: %s",
                           lane.label, move.user_id, move.channel_id, e)
            return {"user_id": move.user_id, "channel_id": move.channel_id,
                    "status": 0, "ok": False}
        await self._reconcile(lane, status, headers, body)
        if status == 429 and retries < MAX_RETRIES:
            logger.warning("[%s] 429 on move %s (retry %d) — re-dispatching",
                           lane.label, move.user_id, retries + 1)
            return await self.dispatch_one(guild_id, move, retries + 1)
        ok = 200 <= status < 300
        if not ok:
            logger.warning("[%s] move %s->%s failed: %d",
                           lane.label, move.user_id, move.channel_id, status)
        return {"user_id": move.user_id, "channel_id": move.channel_id,
                "status": status, "ok": ok}

    async def dispatch_batch(self, guild_id: int, moves: list[Move]) -> list[dict]:
        return await asyncio.gather(*[self.dispatch_one(guild_id, m) for m in moves])

    async def close(self):
        for lane in self.lanes:
            try:
                await lane.session.close()
            except Exception:
                pass


# ─── HTTP handlers ──────────────────────────────────────────────────────────
async def handle_moves(request: web.Request) -> web.Response:
    pool: MoverPool = request.app["pool"]
    try:
        data = await request.json()
        guild_id = int(data["guild_id"])
        moves = [Move(int(m["user_id"]), int(m["channel_id"])) for m in data["moves"]]
    except (KeyError, ValueError, TypeError, json.JSONDecodeError) as e:
        return web.json_response({"error": f"bad request: {e}"}, status=400)

    start = time.monotonic()
    results = await pool.dispatch_batch(guild_id, moves)
    elapsed_ms = round((time.monotonic() - start) * 1000, 1)
    ok = sum(1 for r in results if r["ok"])
    logger.info("moved %d/%d in %.1fms (guild %s)", ok, len(results), elapsed_ms, guild_id)
    return web.json_response({
        "results": results, "ok_count": ok, "fail_count": len(results) - ok,
        "elapsed_ms": elapsed_ms,
    })


async def handle_health(request: web.Request) -> web.Response:
    pool: MoverPool = request.app["pool"]
    now = time.monotonic()
    lanes = [{"label": l.label, "remaining": round(l.remaining, 2),
              "reset_in_s": round(max(0.0, l.reset_at - now), 2)} for l in pool.lanes]
    return web.json_response({"ok": True, "pool_size": len(pool.lanes), "lanes": lanes})


async def build_pool() -> MoverPool:
    tokens = discover_tokens()
    if not tokens:
        raise RuntimeError(
            "No mover tokens found. Set MOVER_TOKEN (and optional MOVER_TOKEN_2, _3 ...) "
            "in the environment / .env.")
    lanes = []
    for i, token in enumerate(tokens, start=1):
        session = aiohttp.ClientSession(headers={
            "Authorization": f"Bot {token}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        })
        lanes.append(TokenLane(session, label=f"mover{i}"))
    logger.info("Mover pool ready with %d token(s)", len(lanes))
    return MoverPool(lanes)


async def main():
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass
    with open("config.json") as f:
        config = json.load(f)
    port = int(config.get("MOVER_PORT", 9997))

    pool = await build_pool()
    app = web.Application()
    app["pool"] = pool
    app.router.add_post("/moves", handle_moves)
    app.router.add_get("/health", handle_health)

    async def _on_cleanup(app):
        await app["pool"].close()
    app.on_cleanup.append(_on_cleanup)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()
    logger.info("Mover service listening on http://127.0.0.1:%d", port)
    await asyncio.Event().wait()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
