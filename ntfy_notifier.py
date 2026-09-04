"""
NtfyNotifier — publishes push notifications for the Gargamel queue to an ntfy topic.

Players subscribe on their phones with the ntfy app (iOS/Android) via the website's
/notifications page; the bot publishes plain HTTP POSTs to https://ntfy.sh/<NTFY_TOPIC>.

The topic name (NTFY_TOPIC in .env, e.g. gargamel-queue-<hash>) is the only secret on
free ntfy.sh: anyone who knows it can subscribe AND publish. It is public by design —
the signup page hands it to anyone who visits — so never reuse it for anything sensitive.

Notifications sent:
  - Queue fill thresholds (full-2, full-1, full — i.e. 8/9/10 at TEAM_SIZE 5), each on
    its own cooldown so a bouncy queue (8→7→8...) doesn't spam phones.
  - Ready check initiated.
  - Custom messages from the /notify mod command (no cooldown).

Automatic queue/ready-check alerts publish with Cache:no — they go only to live
subscribers and never sit in ntfy's ~12h replay cache (a stale "9/10!" is misleading).
/notify announcements stay cached so late openers of the app still see them. Nothing
published to ntfy.sh can be deleted afterward, so caching is decided at send time.

All publishes run in a worker thread (requests is blocking) and are fire-and-forget:
a dead ntfy.sh can never stall or break queue handling.
"""

import asyncio
import logging
import os
import time

import requests

logger = logging.getLogger("ntfy_notifier")

# Re-notify a given fill threshold at most once per window; the queue hovering
# around a threshold should not buzz subscribers' phones every crossing.
QUEUE_THRESHOLD_COOLDOWN = 30 * 60
# Ready checks are mod-initiated and rare; this only guards against double-fires.
READY_CHECK_COOLDOWN = 5 * 60

DEFAULT_SERVER = "https://ntfy.sh"


class NtfyNotifier:
    def __init__(self, topic: str | None = None, server: str | None = None):
        self.topic = (topic or os.environ.get("NTFY_TOPIC", "")).strip()
        self.server = (server or os.environ.get("NTFY_SERVER", DEFAULT_SERVER)).rstrip("/")
        # Publish access token (NTFY_TOKEN). Needed once the topic is write-protected —
        # a reserved topic on ntfy.sh or an ACL'd topic on a self-hosted server — so only
        # the bot can publish while subscribing stays open to everyone.
        self.token = os.environ.get("NTFY_TOKEN", "").strip()
        self._last_sent: dict[str, float] = {}
        if not self.topic:
            logger.warning("NTFY_TOPIC not set; queue push notifications are disabled.")

    @property
    def enabled(self) -> bool:
        return bool(self.topic)

    # --- public entry points (called from the bot's async context) ---

    def queue_update(self, count: int, needed: int) -> None:
        """Notify subscribers when the queue reaches needed-2, needed-1, or needed players.

        Call with the pool size returned by TheCoordinator.add_player; players join one at
        a time, so each threshold is hit exactly rather than skipped over.
        """
        if count == needed:
            title = "Gargamel Queue is FULL!"
            message = f"The Gargamel Queue is FULL at {count}/{needed} players! Game starting soon, hop in now!"
            priority = "high"
            tags = "video_game,tada"
        elif count == needed - 1:
            title = "One more player needed!"
            message = f"The Gargamel Queue is at {count}/{needed} players. Just ONE more to pop! Queue up now!"
            priority = "high"
            tags = "video_game,fire"
        elif count == needed - 2:
            title = "Gargamel Queue filling up!"
            message = f"The Gargamel Queue is at {count}/{needed} players! Two more and the game pops!"
            priority = "default"
            tags = "video_game"
        else:
            return
        self._fire(f"queue_{count}", QUEUE_THRESHOLD_COOLDOWN, message, title, priority, tags)

    def ready_check(self) -> None:
        """Notify subscribers that a ready check has started."""
        self._fire(
            "ready_check",
            READY_CHECK_COOLDOWN,
            "A ready check has been initiated in the Gargamel Queue! Be sure to respond if you're playing!",
            "Gargamel Ready Check!",
            "high",
            "white_check_mark,bell",
        )

    async def send_custom(self, message: str, title: str = "Gargamel League") -> bool:
        """Send a mod-authored message (the /notify command). Awaited so the caller can
        report success/failure back to the mod; bypasses all cooldowns."""
        if not self.enabled:
            return False
        try:
            await asyncio.to_thread(self._publish, message, title, "default", "loudspeaker")
            return True
        except Exception as e:
            logger.warning(f"[ntfy] Custom notification failed: {e}")
            return False

    # --- internals ---

    def _fire(self, key: str, cooldown: float, message: str, title: str, priority: str, tags: str) -> None:
        if not self.enabled:
            return
        now = time.monotonic()
        last = self._last_sent.get(key)
        if last is not None and now - last < cooldown:
            logger.debug(f"[ntfy] Suppressed '{key}' (cooldown, {int(now - last)}s since last).")
            return
        # Stamp before the send goes out so near-simultaneous joins can't double-fire.
        self._last_sent[key] = now

        async def _send():
            try:
                await asyncio.to_thread(self._publish, message, title, priority, tags, False)
                logger.info(f"[ntfy] Sent '{key}' notification.")
            except Exception as e:
                logger.warning(f"[ntfy] Notification '{key}' failed: {e}")

        try:
            asyncio.get_running_loop().create_task(_send())
        except RuntimeError:
            # No event loop (e.g. called from sync test code) — send inline.
            try:
                self._publish(message, title, priority, tags, False)
            except Exception as e:
                logger.warning(f"[ntfy] Notification '{key}' failed: {e}")

    def _publish(self, message: str, title: str, priority: str, tags: str, cache: bool = True) -> None:
        headers = {"Title": title, "Priority": priority, "Tags": tags}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if not cache:
            # Deliver to subscribers but never store server-side: ntfy.sh keeps cached
            # messages ~12h and replays them to anyone who subscribes or reconnects,
            # and published messages can't be deleted. Queue-state alerts are stale
            # within minutes, so they shouldn't linger in anyone's history.
            headers["Cache"] = "no"
        resp = requests.post(
            f"{self.server}/{self.topic}",
            data=message.encode("utf-8"),
            headers=headers,
            timeout=10,
        )
        resp.raise_for_status()
