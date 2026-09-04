"""
Quick Steam login self-test using the Python ValvePython `steam` library — the Python
counterpart to `lobbymanager check`. It logs into each configured Steam account, reports the
exact EResult, logs out, and exits 0 (all OK) / 1 (any failed).

Purpose: cross-check the Go go-steam result. Same credentials, different library:
  - Python logs in OK but Go fails  -> the Go go-steam login is the problem.
  - Python ALSO fails               -> it's account/Steam-side (and the Python EResult,
                                        e.g. AccountLoginDeniedNeedTwoFactor, tells us what
                                        go-steam was reporting generically as InvalidPassword).

Reads STEAM_USERNAME_<i>/STEAM_PASSWORD_<i> from .env (same vars the Go lobbymanager uses).

Run in the project venv (needs the `steam` package from requirements.txt):
    python steam_login_check.py                 # bare username+password
    python steam_login_check.py <code>          # with a mobile authenticator code
    python steam_login_check.py <code> email    # with an email Steam Guard code

NOTE: a Steam Guard code is account-specific, so a single code only validates ONE account
(test with account 0's code; account 0 succeeding is the proof).
"""

import os
import sys


def load_accounts():
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass
    accounts = []
    i = 0
    while True:
        user = os.environ.get(f"STEAM_USERNAME_{i}")
        pw = os.environ.get(f"STEAM_PASSWORD_{i}")
        if not user or not pw:
            break
        accounts.append((user, pw))
        i += 1
    return accounts


def check_login(username, password, two_factor_code=None, auth_code=None):
    """Attempt one Steam logon; return True on success. Logs the EResult either way."""
    import gevent
    from steam.client import SteamClient
    from steam.enums import EResult

    client = SteamClient()
    if two_factor_code:
        print("  sending logon WITH mobile Steam Guard code")
    elif auth_code:
        print("  sending logon WITH email Steam Guard code")
    else:
        print("  sending logon (username + password only)")

    result = None
    try:
        with gevent.Timeout(45):
            result = client.login(
                username, password,
                two_factor_code=two_factor_code,
                auth_code=auth_code,
            )
    except gevent.Timeout:
        print("  timed out after 45s (possible network / Steam CM reachability problem)")
        return False
    except Exception as e:
        print(f"  exception during login: {e!r}")
        return False
    finally:
        try:
            client.logout()
        except Exception:
            pass

    if result == EResult.OK:
        print("  logon succeeded — logged out")
        return True
    print(f"  logon FAILED: {result!r}")
    return False


def main():
    args = sys.argv[1:]
    code = args[0] if args else None
    code_type = args[1].lower() if len(args) > 1 else "mobile"
    two_factor = code if (code and code_type != "email") else None
    auth_code = code if (code and code_type == "email") else None

    accounts = load_accounts()
    if not accounts:
        print("[pycheck] No Steam accounts found (set STEAM_USERNAME_0/STEAM_PASSWORD_0 in .env)")
        return 1

    print(f"[pycheck] Loaded {len(accounts)} account(s)")
    failures = 0
    for i, (user, pw) in enumerate(accounts):
        print(f"[pycheck] Testing account {i} ({user})...")
        if check_login(user, pw, two_factor, auth_code):
            print(f"[pycheck] account {i} ({user}): LOGIN OK")
        else:
            print(f"[pycheck] account {i} ({user}): LOGIN FAILED")
            failures += 1

    if failures == 0:
        print(f"[pycheck] SUCCESS: all {len(accounts)} account(s) logged in and out cleanly.")
        return 0
    print(f"[pycheck] FAILURE: {failures} of {len(accounts)} account(s) could not log in.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
