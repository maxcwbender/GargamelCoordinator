"""
Shared foundation for the Discord rate-limit diagnostic harness.

This module is import-only and performs NO network I/O on import. It is used by:
  - ratelimit_diag_raw.py     (raw aiohttp PATCH, no discord.py)
  - ratelimit_diag_library.py (discord.py member.move_to)
  - ratelimit_diag_report.py  (overlay/analysis of the JSONL output)

Goal of the harness: prove whether all player-move requests share ONE rate-limit
bucket keyed by guild_id (regardless of destination channel), characterize the real
limit/window, and determine whether observed slowdowns are server 429s or discord.py
pausing client-side. See the plan and ratelimits.md for the full rationale.

Security: the bot token is read ONLY from os.environ["BOT_TOKEN"] and is never logged
or written to any output file.
"""

import csv
import json
import os
from dataclasses import dataclass, asdict, fields
from datetime import datetime, timezone

# ─── Safety controls (shared by both test scripts) ──────────────────────────
# These cap the blast radius of a live test against the production guild/token.
MAX_TOTAL_REQUESTS = 60      # hard ceiling on move PATCHes per run
ABORT_AFTER_N_429 = 1        # stop the moment we capture the first real 429
MAX_INVALID_RESPONSES = 3    # abort if 401/403/429 accumulate (Cloudflare budget)

DISCORD_API_BASE = "https://discord.com/api/v10"


def load_diag_config(config_path: str = "config.json") -> dict:
    """
    Load everything the diagnostic scripts need, mirroring how the bot itself
    reads config (Master_Bot.py:339) and its token (BOT_TOKEN via dotenv).

    Returns a dict with: guild_id, general_voice_channel_id, restore_channel_id,
    target_user_id, token. Raises a clear error if anything required is missing.
    The token is intentionally NOT logged anywhere.
    """
    # Load .env the same way Master_Bot does, if python-dotenv is present.
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass  # dotenv optional; env vars may already be exported on the server

    with open(config_path) as f:
        config = json.load(f)

    token = os.environ.get("BOT_TOKEN")
    if not token:
        raise RuntimeError("BOT_TOKEN is not set in the environment (.env or export).")

    try:
        guild_id = int(config["GUILD_ID"])
    except (KeyError, ValueError) as e:
        raise RuntimeError(f"GUILD_ID missing or non-numeric in {config_path}: {e}")

    general_voice = config.get("GENERAL_V_CHANNEL_ID")
    general_voice = int(general_voice) if general_voice is not None else None

    target_user = os.environ.get("DIAG_TARGET_USER_ID")
    if not target_user:
        raise RuntimeError(
            "DIAG_TARGET_USER_ID is not set. Export the Discord user id of the "
            "willing member who will be connected to voice during the test."
        )

    restore_channel = os.environ.get("DIAG_RESTORE_CHANNEL_ID")
    restore_channel = int(restore_channel) if restore_channel else general_voice

    return {
        "guild_id": guild_id,
        "general_voice_channel_id": general_voice,
        "restore_channel_id": restore_channel,
        "target_user_id": int(target_user),
        "token": token,
    }


# ─── Per-request record ─────────────────────────────────────────────────────
@dataclass
class RateLimitRecord:
    """One row per HTTP move attempt. Identical schema for the raw and library
    runs so their timelines can be overlaid on the same axes."""
    seq: int                        # request ordinal within the run
    wall_clock_iso: str             # UTC ISO timestamp the request completed
    monotonic_t: float              # time.monotonic() at completion (ordering/gaps)
    phase: str                      # e.g. "baseline", "S-concurrent", "A-sequential"
    http_status: int                # HTTP status code (or 0 if the call raised)
    rl_limit: "int | None"          # X-RateLimit-Limit
    rl_remaining: "int | None"      # X-RateLimit-Remaining
    rl_reset: "float | None"        # X-RateLimit-Reset (epoch seconds)
    rl_reset_after: "float | None"  # X-RateLimit-Reset-After (seconds)
    rl_bucket: "str | None"         # X-RateLimit-Bucket (THE proof of shared bucket)
    rl_scope: "str | None"          # X-RateLimit-Scope (user/global/shared, on 429)
    rl_global: "bool | None"        # X-RateLimit-Global (true only on global 429)
    retry_after: "float | None"     # Retry-After header / body retry_after (on 429)
    request_gap_ms: "float | None"  # wall-clock gap since previous request started
    dest_channel_id: "int | None"   # channel_id sent in the PATCH body
    source: str                     # "raw" | "library"
    note: str = ""                  # freeform (e.g. "library pre-emptive wait")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─── Header extraction ──────────────────────────────────────────────────────
def extract_rl_headers(headers, body: "dict | None" = None) -> dict:
    """
    Case-insensitively pull every X-RateLimit-* header plus Retry-After from any
    mapping (aiohttp CIMultiDict, requests headers, or a plain dict). On a 429 the
    JSON body also carries retry_after/global, so pass `body` to prefer those.

    Returns a dict with keys matching RateLimitRecord's rl_* / retry_after fields.
    """
    lower = {str(k).lower(): v for k, v in dict(headers).items()}

    def _num(key, cast):
        val = lower.get(key)
        if val is None or val == "":
            return None
        try:
            return cast(val)
        except (ValueError, TypeError):
            return None

    rl_global_raw = lower.get("x-ratelimit-global")
    rl_global = None
    if rl_global_raw is not None:
        rl_global = str(rl_global_raw).lower() == "true"

    retry_after = _num("retry-after", float)
    if body and isinstance(body, dict) and body.get("retry_after") is not None:
        # Body value is authoritative and millisecond-precise on 429s.
        try:
            retry_after = float(body["retry_after"])
        except (ValueError, TypeError):
            pass
    if body and isinstance(body, dict) and body.get("global") is not None:
        rl_global = bool(body["global"])

    return {
        "rl_limit": _num("x-ratelimit-limit", int),
        "rl_remaining": _num("x-ratelimit-remaining", int),
        "rl_reset": _num("x-ratelimit-reset", float),
        "rl_reset_after": _num("x-ratelimit-reset-after", float),
        "rl_bucket": lower.get("x-ratelimit-bucket"),
        "rl_scope": lower.get("x-ratelimit-scope"),
        "rl_global": rl_global,
        "retry_after": retry_after,
    }


# ─── Output sinks ───────────────────────────────────────────────────────────
class JsonlWriter:
    """Append-only JSONL sink (canonical record of every request)."""

    def __init__(self, source: str, log_dir: str = "logs"):
        os.makedirs(log_dir, exist_ok=True)
        ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        self.path = os.path.join(log_dir, f"ratelimit_{source}_{ts}.jsonl")
        self._fh = open(self.path, "a", encoding="utf-8")

    def write(self, record: RateLimitRecord):
        self._fh.write(json.dumps(asdict(record)) + "\n")
        self._fh.flush()

    def close(self):
        try:
            self._fh.close()
        except Exception:
            pass


class CsvWriter:
    """Append-only CSV sink (spreadsheet-friendly view of the same records)."""

    def __init__(self, source: str, log_dir: str = "logs"):
        os.makedirs(log_dir, exist_ok=True)
        ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        self.path = os.path.join(log_dir, f"ratelimit_{source}_{ts}.csv")
        self._cols = [f.name for f in fields(RateLimitRecord)]
        self._fh = open(self.path, "a", encoding="utf-8", newline="")
        self._writer = csv.DictWriter(self._fh, fieldnames=self._cols)
        self._writer.writeheader()
        self._fh.flush()

    def write(self, record: RateLimitRecord):
        self._writer.writerow(asdict(record))
        self._fh.flush()

    def close(self):
        try:
            self._fh.close()
        except Exception:
            pass


class RecordSink:
    """Convenience fan-out: writes each record to both JSONL and CSV and keeps a
    running 429 / invalid-response tally for the safety guards."""

    def __init__(self, source: str, log_dir: str = "logs"):
        self.source = source
        self.jsonl = JsonlWriter(source, log_dir)
        self.csv = CsvWriter(source, log_dir)
        self.records: list[RateLimitRecord] = []
        self.count_429 = 0
        self.count_invalid = 0

    def add(self, record: RateLimitRecord):
        self.jsonl.write(record)
        self.csv.write(record)
        self.records.append(record)
        if record.http_status == 429:
            self.count_429 += 1
        if record.http_status in (401, 403, 429):
            self.count_invalid += 1

    def should_abort(self) -> "str | None":
        """Return a reason string if a safety threshold has been crossed."""
        if self.count_429 >= ABORT_AFTER_N_429:
            return f"captured {self.count_429} x 429 (target reached) — stopping"
        if self.count_invalid >= MAX_INVALID_RESPONSES:
            return f"{self.count_invalid} invalid responses — aborting to protect Cloudflare budget"
        if len(self.records) >= MAX_TOTAL_REQUESTS:
            return f"reached MAX_TOTAL_REQUESTS={MAX_TOTAL_REQUESTS} — stopping"
        return None

    def close(self):
        self.jsonl.close()
        self.csv.close()
