import json
import sqlite3
import time

with open("config.json") as configFile:
    config: dict = json.load(configFile)

con = sqlite3.connect("allUsers.db")

# --- Schema migrations (idempotent; the website's server/db.mjs applies the same ones) ---
# mod_notes.superseded: 1 marks review rows from a previous registration pass. When a
# registered player leaves Discord and rejoins, they go back through moderation, and the
# old approvals/rejections must not count toward the new decision (they are kept for history).
# users.referral_source: hidden ?ref= tag from the promo link a registrant arrived through
# (e.g. "reddit"); users.referred_by is the Discord member a regular visitor named instead.
# Both are shown only to mods.
# referral_stats: first-time registrations per referral link tag (kind 'link') and per
# referring player (kind 'player'); written by the website, read by /referral_stats.
for _sql in (
    "ALTER TABLE mod_notes ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN referral_source TEXT",
    """CREATE TABLE IF NOT EXISTS referral_stats (
        kind TEXT NOT NULL, key TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
        first_at TEXT NOT NULL, last_at TEXT NOT NULL, PRIMARY KEY (kind, key))""",
    # queue_state: write-through mirror of the in-memory game queue (TheCoordinator.queue) so a
    # crash or restart can put the same players back in the queue. Bot-only; see save_queue_state.
    """CREATE TABLE IF NOT EXISTS queue_state (
        discord_id INTEGER PRIMARY KEY, rating INTEGER NOT NULL, join_time REAL NOT NULL,
        tiebreak REAL NOT NULL, saved_at REAL NOT NULL)""",
):
    try:
        con.execute(_sql)
        con.commit()
    except sqlite3.OperationalError:
        pass  # column already exists

def fetch_one(query, params=()):
    """Execute a SQL query and return a single row or None.

    Args:
        query (str): SQL query string.
        params (tuple): Query parameters.

    Returns:
        tuple or None: The first row of the result set, or None if no results.
    """

    result = con.execute(query, params).fetchone()
    return result[0] if result else None

def fetch_all(query, params=()):
    """Execute a SQL query and return all matching rows.

    Args:
        query (str): SQL query string.
        params (tuple): Query parameters.

    Returns:
        list of tuples: All rows matching the query.
    """

    return con.execute(query, params).fetchall()

def execute(query, params=()):
    """Execute a SQL command (INSERT, UPDATE, DELETE).

    Args:
        query (str): SQL command string.
        params (tuple): Command parameters.
    """
    con.execute(query, params)
    con.commit()

def exists_in(table: str, where_clause: str, params: tuple = ()) -> bool:
    """
    Check if any row exists in a specified table that satisfies a given WHERE clause.

    Args:
        table (str): Name of the table.
        where_clause (str): SQL WHERE clause (without the 'WHERE' keyword).
        params (tuple): Parameters to substitute into the query.

    Returns:
        bool: True if a matching row exists, False otherwise.

    Warning:
        This method does not sanitize the table name or WHERE clause.
        Ensure they are constructed safely to avoid SQL injection.
    """
    query = f"SELECT 1 FROM {table} WHERE {where_clause} LIMIT 1"
    return bool(fetch_one(query, params))

def fetch_steam_id(discord_id: str):
    """
    Returns the Steam id associated with the given Discord id

    Args:
        discord_id (str): the Discord id to convert

    Returns:
        str: the Steam id associated with the given Discord id
    """
    query = f"SELECT steam_id FROM users WHERE discord_id = ?"
    return fetch_one(query,
        (discord_id,))

def fetch_rating(discord_id: str):
    """
    Returns the rating associated with the given Discord id

    Args:
        discord_id (str): the Discord id to find the internal rating of

    Returns:
        str: the rating associated with the given Discord id
    """
    query = f"SELECT rating FROM users WHERE discord_id = ?"
    return fetch_one(query,
        (discord_id,))

# --- Behavior score ---
# Scale mirrors Dota's conduct summary: 0 (worst) to 10000 (clean record).
# Currently only adjustable via the /set_behavior_score slash command; other
# sources (reports, match results, etc.) may feed into it later.
BEHAVIOR_SCORE_MIN = 0
BEHAVIOR_SCORE_MAX = 10000
DEFAULT_BEHAVIOR_SCORE = BEHAVIOR_SCORE_MAX

def fetch_behavior_score(discord_id) -> int:
    """
    Returns the behavior score associated with the given Discord id.

    Args:
        discord_id: the Discord id to look up

    Returns:
        int: the user's behavior score, or DEFAULT_BEHAVIOR_SCORE if the user
        has no row or no score recorded.
    """
    query = "SELECT behavior_score FROM users WHERE discord_id = ?"
    score = fetch_one(query, (discord_id,))
    return DEFAULT_BEHAVIOR_SCORE if score is None else score

def set_behavior_score(discord_id, score: int):
    """
    Sets the behavior score for the given Discord id, clamped to
    [BEHAVIOR_SCORE_MIN, BEHAVIOR_SCORE_MAX].

    Args:
        discord_id: the Discord id of the user to update
        score (int): the new behavior score
    """
    score = max(BEHAVIOR_SCORE_MIN, min(BEHAVIOR_SCORE_MAX, int(score)))
    execute(
        "UPDATE users SET behavior_score = ? WHERE discord_id = ?",
        (score, discord_id),
    )

# Use this as a temporary lobby + 1 before making the actual game when it starts

def query_mod_results(user_id: int) -> tuple[int, int, int]:
    """
    Count moderation results for a user.

    Args:
        user_id (int): Discord ID of the user.

    Returns:
        tuple(int, int, int): Counts of (approvals, disapprovals, undecided) mod votes.
    """
    query = "SELECT result FROM mod_notes WHERE registrant_id = ? AND superseded = 0"
    rows = fetch_all(
        query, (user_id,)
    )
    A = sum(1 for r in rows if r[0] == 1)
    D = sum(1 for r in rows if r[0] == 0)
    W = sum(1 for r in rows if r[0] not in (0, 1))
    return A, D, W

# --- Game queue persistence (crash / restart recovery) ---

def save_queue_state(queue: dict):
    """
    Replace the persisted game queue with the current in-memory one, atomically.

    Args:
        queue (dict): discord_id -> (rating, join_time, tiebreak), as TheCoordinator keeps it.
    """
    now = time.time()
    con.execute("DELETE FROM queue_state")
    con.executemany(
        "INSERT INTO queue_state (discord_id, rating, join_time, tiebreak, saved_at) VALUES (?, ?, ?, ?, ?)",
        [(int(user), int(rating), float(join_time), float(tiebreak), now)
         for user, (rating, join_time, tiebreak) in queue.items()],
    )
    con.commit()

def load_queue_state():
    """
    The persisted game queue from the last run.

    Returns:
        tuple[dict, float | None]: (discord_id -> (rating, join_time, tiebreak), age in seconds of
        the snapshot) — ({}, None) when nothing was saved.
    """
    rows = fetch_all("SELECT discord_id, rating, join_time, tiebreak, saved_at FROM queue_state")
    if not rows:
        return {}, None
    players = {int(r[0]): (int(r[1]), float(r[2]), float(r[3])) for r in rows}
    age = time.time() - max(float(r[4]) for r in rows)
    return players, age

def clear_queue_state():
    """Forget the persisted game queue."""
    execute("DELETE FROM queue_state")

# --- Referral tally ---

def fetch_referral_stats():
    """
    Referral tally rows, busiest first within each kind.

    Returns:
        list[tuple]: (kind, key, count, first_at, last_at); kind is 'link' for a ?ref=
        promo-link tag or 'player' for a Discord member named in "Referred By".
    """
    return fetch_all(
        "SELECT kind, key, count, first_at, last_at FROM referral_stats ORDER BY kind, count DESC, key"
    )

# --- Registration queue (returning players) ---

def fetch_registration(discord_id):
    """
    Returns the registration row for a Discord id, or None if they never registered.

    Returns:
        dict | None: {"steam_id", "rating", "modsRemaining", "referred_by", "referral_source", "dateCreated"}
    """
    row = con.execute(
        "SELECT steam_id, rating, modsRemaining, referred_by, referral_source, dateCreated FROM users WHERE discord_id = ?",
        (discord_id,),
    ).fetchone()
    if not row:
        return None
    return {"steam_id": row[0], "rating": row[1], "modsRemaining": row[2], "referred_by": row[3],
            "referral_source": row[4], "dateCreated": row[5]}

def is_fresh_registrant(discord_id, mods_required: int) -> bool:
    """
    True when the user is sitting in the registration queue untouched: every mod review
    is still outstanding and no live (non-superseded) mod_notes row exists for them.
    This is the state right after a first-time website registration, so a member-join
    event for such a user must NOT be treated as a returning player.
    """
    reg = fetch_registration(discord_id)
    if not reg or reg["modsRemaining"] < mods_required:
        return False
    live_notes = fetch_one(
        "SELECT COUNT(*) FROM mod_notes WHERE registrant_id = ? AND superseded = 0",
        (discord_id,),
    )
    return not live_notes

def requeue_returning_registrant(discord_id, mods_required: int) -> dict:
    """
    Puts a previously registered player back into the registration queue, keeping their
    rating (MMR) but requiring a fresh round of mod review:
      - previous mod_notes rows are marked superseded (kept for history, ignored by
        query_mod_results and the /poll_registration exclusion),
      - any mod who still had this player assigned is released,
      - modsRemaining is reset to mods_required.

    Returns:
        dict: {"rating", "approvals", "rejections", "notes"} describing the prior pass,
        so the mod-channel notice can summarise what earlier reviewers decided.
    """
    A, D, _ = query_mod_results(discord_id)
    prior_notes = [
        (mod_id, result, notes)
        for mod_id, result, notes in fetch_all(
            "SELECT mod_id, result, notes FROM mod_notes WHERE registrant_id = ? AND superseded = 0",
            (discord_id,),
        )
    ]
    with con:
        con.execute(
            "UPDATE mod_notes SET superseded = 1 WHERE registrant_id = ? AND superseded = 0",
            (discord_id,),
        )
        con.execute(
            "UPDATE users SET assignedRegistrant = NULL WHERE assignedRegistrant = ?",
            (discord_id,),
        )
        con.execute(
            "UPDATE users SET modsRemaining = ? WHERE discord_id = ?",
            (int(mods_required), discord_id),
        )
    return {"rating": fetch_rating(discord_id), "approvals": A, "rejections": D, "notes": prior_notes}

def power_mean(ratings: list[int], p: int = 5) -> int:
    return int((sum(r ** p for r in ratings) / len(ratings)) ** (1 / p))

def unfun_score(radiant_ratings: list[int], dire_ratings: list[int], p: int = 2) -> int:
    """
    Calculates the unfun score of a game according to the given (sorted) list of radiant ratings and dire ratings. 
    
    Assumes that the given ratings were given in sorted form. 
    
    Args: 
        radiant_ratings (list[int]): The sorted list of radiant team ratings. 
        dire_ratings (list[int]): The sorted list of dire team ratings. 
        p (int): The power by which to raise the relative differences. 
        
    Returns: 
        The unfun score between the two teams given. 
    """ 
    return int(sum([abs(radiant_ratings[i] - dire_ratings[i]) ** p for i in range(len(radiant_ratings))]) ** (1 / p))