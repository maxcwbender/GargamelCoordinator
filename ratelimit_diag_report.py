"""
Overlay/analysis for the rate-limit diagnostic runs (read-only, no network).

Loads the JSONL produced by ratelimit_diag_raw.py and ratelimit_diag_library.py and
prints the evidence summary: distinct bucket hashes (expect ONE shared across same- and
alternating-destination), the inferred limit/window, library pre-emptive waits vs. real
429s, and the authoritative first-429 envelope.

Usage:
    python ratelimit_diag_report.py                         # auto-pick latest raw + library
    python ratelimit_diag_report.py raw.jsonl library.jsonl # explicit files
"""

import glob
import json
import os
import sys


def _latest(pattern):
    files = glob.glob(pattern)
    return max(files, key=os.path.getmtime) if files else None


def load(path):
    if not path or not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def summarize(label, records):
    print(f"\n===== {label} =====")
    if not records:
        print("  (no records)")
        return

    buckets = sorted({r["rl_bucket"] for r in records if r.get("rl_bucket")})
    print(f"  requests: {len(records)}")
    print(f"  distinct X-RateLimit-Bucket: {buckets}")
    if len(buckets) <= 1:
        print("  -> single bucket: destination channel does NOT create separate routes (H1 ✔)")
    else:
        print("  -> MULTIPLE buckets seen; investigate which routes differ")

    limits = sorted({r["rl_limit"] for r in records if r.get("rl_limit") is not None})
    resets = sorted({round(r["rl_reset_after"], 2)
                     for r in records if r.get("rl_reset_after") is not None})
    print(f"  X-RateLimit-Limit values: {limits}")
    print(f"  X-RateLimit-Reset-After values (s): {resets}")
    if limits and resets:
        print(f"  -> ~{limits[-1]} moves per {resets[-1]}s window (H2)")

    # Bucket-by-destination cross-check (raw run carries dest_channel_id).
    by_dest = {}
    for r in records:
        d = r.get("dest_channel_id")
        if d is not None and r.get("rl_bucket"):
            by_dest.setdefault(d, set()).add(r["rl_bucket"])
    if by_dest:
        print("  bucket per destination channel:")
        for dest, bks in by_dest.items():
            print(f"    dest {dest}: {sorted(bks)}")

    waits = [r for r in records if "pre-emptive" in (r.get("note") or "")]
    n429 = [r for r in records if r.get("http_status") == 429]
    print(f"  suspected library pre-emptive waits: {len(waits)}")
    print(f"  real 429s: {len(n429)}")

    # Show the remaining countdown so the window is visible at a glance.
    print("  remaining-countdown (seq: status remaining reset_after gap_ms phase):")
    for r in records:
        print(f"    {r['seq']:>3}: {r['http_status']} "
              f"rem={r.get('rl_remaining')} reset={r.get('rl_reset_after')} "
              f"gap={None if r.get('request_gap_ms') is None else round(r['request_gap_ms'], 1)} "
              f"{r.get('phase')}")

    if n429:
        f = n429[0]
        print(f"  FIRST 429 envelope: scope={f.get('rl_scope')} global={f.get('rl_global')} "
              f"retry_after={f.get('retry_after')} limit={f.get('rl_limit')}")


def main():
    if len(sys.argv) >= 3:
        raw_path, lib_path = sys.argv[1], sys.argv[2]
    else:
        raw_path = _latest("logs/ratelimit_raw_*.jsonl")
        lib_path = _latest("logs/ratelimit_library_*.jsonl")

    print(f"raw file:     {raw_path}")
    print(f"library file: {lib_path}")

    raw = load(raw_path)
    lib = load(lib_path)
    summarize("RAW (no discord.py)", raw)
    summarize("LIBRARY (discord.py)", lib)

    # Cross-source verdict on H3.
    print("\n===== verdict =====")
    raw_buckets = {r["rl_bucket"] for r in raw if r.get("rl_bucket")}
    lib_buckets = {r["rl_bucket"] for r in lib if r.get("rl_bucket")}
    if raw_buckets and lib_buckets:
        shared = raw_buckets & lib_buckets
        print(f"  bucket hash shared across raw+library: {sorted(shared) or 'NONE'}")
    raw_429 = sum(1 for r in raw if r.get("http_status") == 429)
    lib_429 = sum(1 for r in lib if r.get("http_status") == 429)
    lib_waits = sum(1 for r in lib if "pre-emptive" in (r.get("note") or ""))
    if lib_waits and lib_429 == 0 and raw_429 > 0:
        print("  -> H3: discord.py pauses CLIENT-SIDE (pre-emptive waits, no 429) while the "
              "raw run hits real 429s. The library is the source of the pause.")
    elif lib_429 > 0 and raw_429 > 0:
        print("  -> H3: both hit real server 429s. The limit is server-side; the library is "
              "not artificially throttling beyond it.")
    else:
        print("  -> H3 inconclusive from these runs; inspect the countdown timelines above "
              "and logs/Discord_HTTP_*.txt.")


if __name__ == "__main__":
    main()
