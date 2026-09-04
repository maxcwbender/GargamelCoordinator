import Database from 'better-sqlite3';
import { join } from 'path';
import { ROOT } from './config.mjs';
import { logger } from './logger.mjs';

export const db = new Database(join(ROOT, 'allUsers.db'));

// Migrate schema: add columns and tables introduced after initial release
const columnMigrations = [
    'ALTER TABLE player_stats ADD COLUMN observer_kills INTEGER DEFAULT 0',
    'ALTER TABLE player_stats ADD COLUMN obs_ward_time_total INTEGER DEFAULT 0',
    'ALTER TABLE player_stats ADD COLUMN obs_ward_count INTEGER DEFAULT 0',
    'ALTER TABLE player_stats ADD COLUMN season INTEGER DEFAULT 1',
    'ALTER TABLE users ADD COLUMN referred_by TEXT',
];
for (const sql of columnMigrations) {
    try { db.exec(sql); } catch (_) { /* column already exists */ }
}

// Ensure match_mvps table exists with composite key (match_id, award_type)
{
    const cols = db.pragma('table_info(match_mvps)');
    const hasAwardType = cols.some(c => c.name === 'award_type');
    if (cols.length > 0 && !hasAwardType) {
        // Old schema (single PK) — drop and recreate with composite key
        logger.info('Migrating match_mvps table to composite key schema');
        db.exec('DROP TABLE match_mvps');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS match_mvps (
        match_id INTEGER NOT NULL,
        account_id INTEGER NOT NULL,
        award_type TEXT NOT NULL DEFAULT 'mvp',
        mvp_score REAL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (match_id, award_type)
    )`);
}

// Summer trip planning (/summer-planning): shared items + per-person allergies
// trip_id: which trip (see TRIPS in routes/planning.mjs) a row belongs to. Rows
// from archived trips keep their trip_id and simply become unreachable.
// source_item_id: when a grocery row is a meal's ingredient, points at the meal's
// id (NULL for standalone groceries). Deleting the meal cascades its ingredients.
// quantity: number of items for the shopping list (groceries). purchased_by: who
// marked it bought (shared flag, NULL = not purchased).
db.exec(`CREATE TABLE IF NOT EXISTS trip_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL DEFAULT 1,
    category TEXT NOT NULL CHECK (category IN ('meal','snack','drink','grocery')),
    trip_date TEXT,
    meal_slot TEXT CHECK (meal_slot IN ('breakfast','lunch','dinner') OR meal_slot IS NULL),
    item_name TEXT NOT NULL,
    notes TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    source_item_id INTEGER,
    quantity INTEGER NOT NULL DEFAULT 1,
    purchased_by TEXT
)`);
// Existing installs: add columns if the table predates them (idempotent).
// DEFAULT 1 on trip_id tags all pre-existing rows as trip 1 (the archived Maine trip).
for (const sql of [
    'ALTER TABLE trip_items ADD COLUMN source_item_id INTEGER',
    'ALTER TABLE trip_items ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE trip_items ADD COLUMN purchased_by TEXT',
    'ALTER TABLE trip_items ADD COLUMN trip_id INTEGER NOT NULL DEFAULT 1',
]) {
    try { db.exec(sql); } catch (_) { /* already exists */ }
}
// Allergies are per-trip (attendees differ trip to trip), so the key is
// (trip_id, name_key). Installs that predate trips have name_key as the sole
// PRIMARY KEY, which SQLite can't alter in place — rebuild the table, tagging
// existing rows as trip 1.
{
    const cols = db.pragma('table_info(trip_allergies)');
    if (cols.length > 0 && !cols.some(c => c.name === 'trip_id')) {
        logger.info('Migrating trip_allergies to per-trip composite key schema');
        db.exec(`ALTER TABLE trip_allergies RENAME TO trip_allergies_v1;
            CREATE TABLE trip_allergies (
                trip_id INTEGER NOT NULL,
                name_key TEXT NOT NULL,
                display_name TEXT NOT NULL,
                allergies TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (trip_id, name_key)
            );
            INSERT INTO trip_allergies (trip_id, name_key, display_name, allergies, updated_at)
                SELECT 1, name_key, display_name, allergies, updated_at FROM trip_allergies_v1;
            DROP TABLE trip_allergies_v1;`);
    }
}
db.exec(`CREATE TABLE IF NOT EXISTS trip_allergies (
    trip_id INTEGER NOT NULL,
    name_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    allergies TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (trip_id, name_key)
)`);
