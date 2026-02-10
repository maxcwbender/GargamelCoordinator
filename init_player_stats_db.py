#!/usr/bin/env python3
"""
Initialize player stats and avatar tables in allUsers.db
"""
import sqlite3

def init_database():
    conn = sqlite3.connect('allUsers.db')
    cursor = conn.cursor()

    # Create player_stats table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS player_stats (
            account_id INTEGER PRIMARY KEY,
            personaname TEXT NOT NULL,
            wins INTEGER DEFAULT 0,
            losses INTEGER DEFAULT 0,
            kills INTEGER DEFAULT 0,
            deaths INTEGER DEFAULT 0,
            assists INTEGER DEFAULT 0,
            gold_per_minute INTEGER DEFAULT 0,
            total_gold INTEGER DEFAULT 0,
            wards_placed INTEGER DEFAULT 0,
            observer_kills INTEGER DEFAULT 0,
            obs_ward_time_total INTEGER DEFAULT 0,
            obs_ward_count INTEGER DEFAULT 0,
            matches INTEGER DEFAULT 0,
            last_updated INTEGER NOT NULL,
            UNIQUE(account_id)
        )
    ''')

    # Create player_avatars table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS player_avatars (
            account_id INTEGER PRIMARY KEY,
            avatar_url TEXT,
            last_updated INTEGER NOT NULL,
            UNIQUE(account_id)
        )
    ''')

    # Create index on last_updated for efficient queries
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_player_stats_updated
        ON player_stats(last_updated)
    ''')

    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_player_avatars_updated
        ON player_avatars(last_updated)
    ''')

    conn.commit()

    # Show current schema
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = cursor.fetchall()
    print("Tables in database:")
    for table in tables:
        print("  - " + str(table[0]))

    conn.close()
    print("\nDatabase initialized successfully!")

if __name__ == '__main__':
    init_database()
