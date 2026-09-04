"""
MoverClient — thin async HTTP client the main bot uses to delegate player voice-moves to
the mover microservice (mover_service.py). Mirrors the shape of RESTAPIClient in
Master_Bot.py (the existing aiohttp client for the Go lobbymanager).

Contract: every method returns a value that lets the caller decide whether to fall back to
moving players directly. `move_batch` returns the service's JSON dict on success, or None on
ANY failure/timeout/unreachable — the master treats None as "mover down, move them myself".
"""

import asyncio
import logging

import aiohttp

logger = logging.getLogger("mover_client")


class MoverClient:
    # Generous timeout: the mover SERIALIZES moves (~RTT + 0.1s each, pool-wide), so two
    # 10-player batches landing together can take ~7s+. A premature timeout here would
    # trip the master's direct-move fallback and double-move players.
    def __init__(self, base_url: str = "http://127.0.0.1:9997", timeout: float = 25.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = aiohttp.ClientTimeout(total=timeout)

    async def move_batch(self, guild_id: int, moves: list[tuple[int, int]]):
        """Ask the mover to perform a batch of moves.

        moves: list of (user_id, channel_id) integer pairs.
        Returns the service JSON dict {results, ok_count, fail_count, elapsed_ms} on HTTP 200,
        or None if the service is unreachable / times out / returns non-200.
        """
        if not moves:
            return {"results": [], "ok_count": 0, "fail_count": 0, "elapsed_ms": 0.0}
        payload = {
            "guild_id": int(guild_id),
            "moves": [{"user_id": int(u), "channel_id": int(c)} for u, c in moves],
        }
        try:
            async with aiohttp.ClientSession(timeout=self.timeout) as session:
                async with session.post(f"{self.base_url}/moves", json=payload) as resp:
                    if resp.status != 200:
                        logger.warning("mover /moves returned %d", resp.status)
                        return None
                    return await resp.json()
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            logger.warning("mover /moves unreachable: %s", e)
            return None

    async def health(self) -> bool:
        try:
            short = aiohttp.ClientTimeout(total=3.0)
            async with aiohttp.ClientSession(timeout=short) as session:
                async with session.get(f"{self.base_url}/health") as resp:
                    return resp.status == 200
        except (aiohttp.ClientError, asyncio.TimeoutError):
            return False
