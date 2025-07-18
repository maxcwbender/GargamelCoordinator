import json
import sqlite3

with open("config.json") as configFile:
    config: dict = json.load(configFile)

con = sqlite3.connect("allUsers.db")

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

# Use this as a temporary lobby + 1 before making the actual game when it starts

def query_mod_results(user_id: int) -> tuple[int, int, int]:
    """
    Count moderation results for a user.

    Args:
        user_id (int): Discord ID of the user.

    Returns:
        tuple(int, int, int): Counts of (approvals, disapprovals, undecided) mod votes.
    """
    query = f"SELECT result FROM mod_notes WHERE registrant_id = ?"
    rows = fetch_all(
        query, (user_id,)
    )
    A = sum(1 for r in rows if r[0] == 1)
    D = sum(1 for r in rows if r[0] == 0)
    W = sum(1 for r in rows if r[0] not in (0, 1))
    return A, D, W

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