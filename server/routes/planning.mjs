import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { db } from '../db.mjs';
import { logger } from '../logger.mjs';

// ─── Summer trip planning API ────────────────────────────────────────────────
// Trips: each active trip has its own password (its own env var), and the
// password entered at the gate is what selects the trip — the auth token derived
// from it is trip-scoped, so every API call knows which trip it's operating on.
//
// Archiving a trip = removing it from this list. Its rows stay in the DB tagged
// with its trip_id but no password reaches them anymore. Archived so far:
//   trip 1 — Maine Trip, July 2–6 2026 (was SUMMER_PLANNING_PASSWORD).
//   Its leftover rows are unused; purge whenever with:
//     DELETE FROM trip_items WHERE trip_id = 1; DELETE FROM trip_allergies WHERE trip_id = 1;
const TRIPS = [
    {
        id: 2,
        name: 'Cabotville Trip',
        datesLabel: 'July 13–16, 2026',
        dates: ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16'],
        password: (process.env.SUMMER_PLANNING_PASSWORD_2 || '').trim(),
    },
];
// Admin name (honor-system, same as all identity here): whoever plans under this
// first name may remove any item, not just their own. Empty => no admin.
const PLANNING_ADMIN = (process.env.SUMMER_PLANNING_ADMIN || '').trim();
const isPlanningAdmin = (name) => !!PLANNING_ADMIN && String(name).trim().toLowerCase() === PLANNING_ADMIN.toLowerCase();
// Deterministic per-trip token: survives restarts with no session store; rotating
// a trip's password invalidates its stored tokens. The trip id in the HMAC input
// keeps tokens distinct even if two trips shared a password. Trips with no
// password configured get no token => fail closed.
for (const trip of TRIPS) {
    trip.token = trip.password
        ? createHmac('sha256', trip.password).update(`summer-planning-token-v2-trip-${trip.id}`).digest('hex')
        : null;
}

function planningSafeEqual(a, b) {
    // Hash both sides so timingSafeEqual always gets equal-length buffers
    return timingSafeEqual(
        createHash('sha256').update(String(a)).digest(),
        createHash('sha256').update(String(b)).digest()
    );
}

function requirePlanningAuth(req, res, next) {
    const configured = TRIPS.filter(t => t.token);
    if (configured.length === 0) return res.status(503).json({ error: 'Planning is not configured on this server' });
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const trip = token ? configured.find(t => planningSafeEqual(token, t.token)) : null;
    if (!trip) return res.status(401).json({ error: 'Unauthorized' });
    req.trip = trip;
    next();
}

const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner'];
const ITEM_CATEGORIES = ['meal', 'snack', 'drink', 'grocery'];
const MAX_INGREDIENTS = 40;

// Insert a single trip item. source is the parent meal id for ingredients, else null.
const insertTripItem = db.prepare(`INSERT INTO trip_items
    (trip_id, category, trip_date, meal_slot, item_name, notes, created_by, created_at, source_item_id, quantity)
    VALUES (@tripId, @category, @tripDate, @mealSlot, @itemName, @notes, @createdBy, @createdAt, @sourceItemId, @quantity)`);

// Clamp a quantity to a positive integer 1..9999, or return fallback if unusable.
function parseQuantity(raw, fallback = 1) {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.min(n, 9999);
}

// Normalize an ingredients payload to a clean [{name, quantity}] (drops blanks).
// Accepts strings (qty 1) or {name, quantity}. Returns null if the shape is invalid.
function cleanIngredients(raw) {
    if (raw == null) return [];
    if (!Array.isArray(raw)) return null;
    const out = [];
    for (const entry of raw) {
        let name, quantity;
        if (typeof entry === 'string') { name = entry.trim(); quantity = 1; }
        else if (entry && typeof entry === 'object') {
            name = typeof entry.name === 'string' ? entry.name.trim() : '';
            quantity = parseQuantity(entry.quantity, 1);
        } else continue;
        if (!name) continue;
        if (name.length > 100) return null;
        out.push({ name, quantity });
    }
    return out.length > MAX_INGREDIENTS ? null : out;
}

export function mountPlanningRoutes(server) {
    // The password is the trip selector: whichever active trip it matches is the
    // trip the returned token unlocks.
    server.post('/api/summer-planning/verify', (req, res) => {
        const configured = TRIPS.filter(t => t.token);
        if (configured.length === 0) return res.status(503).json({ error: 'Planning is not configured on this server' });
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        const trip = password ? configured.find(t => planningSafeEqual(password, t.password)) : null;
        if (!trip) return res.status(401).json({ error: 'Incorrect password' });
        return res.json({ token: trip.token });
    });

    server.get('/api/summer-planning/data', requirePlanningAuth, (req, res) => {
        const items = db.prepare('SELECT * FROM trip_items WHERE trip_id = ? ORDER BY created_at').all(req.trip.id);
        const allergies = db.prepare('SELECT name_key, display_name, allergies FROM trip_allergies WHERE trip_id = ? ORDER BY display_name').all(req.trip.id);
        // isAdmin is derived from the caller's claimed name; we never expose the admin
        // name itself, so non-admins just get false.
        const isAdmin = isPlanningAdmin(req.query.name || '');
        // The frontend renders whichever trip the token selected (name, dates, calendar).
        const trip = { id: req.trip.id, name: req.trip.name, datesLabel: req.trip.datesLabel, dates: req.trip.dates };
        return res.json({ items, allergies, isAdmin, trip });
    });

    server.post('/api/summer-planning/items', requirePlanningAuth, (req, res) => {
        const body = req.body || {};
        const category = typeof body.category === 'string' ? body.category : '';
        const itemName = typeof body.itemName === 'string' ? body.itemName.trim() : '';
        const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
        const createdBy = typeof body.createdBy === 'string' ? body.createdBy.trim() : '';

        if (!ITEM_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });
        if (!itemName || itemName.length > 100) return res.status(400).json({ error: 'Item name is required (max 100 chars)' });
        if (notes.length > 300) return res.status(400).json({ error: 'Notes too long (max 300 chars)' });
        if (!createdBy || createdBy.length > 40) return res.status(400).json({ error: 'Name is required (max 40 chars)' });

        let tripDate = null;
        let mealSlot = null;
        let ingredients = [];
        if (category === 'meal') {
            if (!req.trip.dates.includes(body.tripDate)) return res.status(400).json({ error: `Meal date must be a trip date (${req.trip.datesLabel})` });
            if (!MEAL_SLOTS.includes(body.mealSlot)) return res.status(400).json({ error: 'Meal slot must be breakfast, lunch, or dinner' });
            tripDate = body.tripDate;
            mealSlot = body.mealSlot;
            ingredients = cleanIngredients(body.ingredients);
            if (ingredients === null) return res.status(400).json({ error: `Ingredients must each be ≤100 chars (max ${MAX_INGREDIENTS})` });
        }

        const createdAt = Date.now();
        const tripId = req.trip.id;
        const quantity = category === 'grocery' ? parseQuantity(body.quantity, 1) : 1;
        // Insert the item and any meal ingredients (as linked grocery rows) atomically.
        const create = db.transaction(() => {
            const info = insertTripItem.run({ tripId, category, tripDate, mealSlot, itemName, notes: notes || null, createdBy, createdAt, sourceItemId: null, quantity });
            const mealId = info.lastInsertRowid;
            for (const ing of ingredients) {
                insertTripItem.run({ tripId, category: 'grocery', tripDate: null, mealSlot: null, itemName: ing.name, notes: null, createdBy, createdAt, sourceItemId: mealId, quantity: ing.quantity });
            }
            return mealId;
        });
        const newId = create();
        const item = db.prepare('SELECT * FROM trip_items WHERE id = ?').get(newId);
        logger.info(`[Planning] ${createdBy} added ${category}: ${itemName}${ingredients.length ? ` (+${ingredients.length} ingredients)` : ''}`);
        return res.status(201).json({ item });
    });

    // Add one ingredient to an existing meal (creates a linked grocery row). Only the
    // meal's owner or the admin may add ingredients; the grocery is attributed to the
    // meal's owner so it lands on their grocery commitment.
    server.post('/api/summer-planning/items/:id/ingredients', requirePlanningAuth, (req, res) => {
        const mealId = Number(req.params.id);
        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        const ingredientName = typeof req.body?.itemName === 'string' ? req.body.itemName.trim() : '';
        if (!Number.isInteger(mealId)) return res.status(400).json({ error: 'Invalid meal id' });
        if (!name) return res.status(400).json({ error: 'Name is required' });
        if (!ingredientName || ingredientName.length > 100) return res.status(400).json({ error: 'Ingredient is required (max 100 chars)' });

        const meal = db.prepare('SELECT created_by, category FROM trip_items WHERE id = ? AND trip_id = ?').get(mealId, req.trip.id);
        if (!meal || meal.category !== 'meal') return res.status(404).json({ error: 'Meal not found' });
        const isOwner = meal.created_by.trim().toLowerCase() === name.toLowerCase();
        if (!isOwner && !isPlanningAdmin(name)) return res.status(403).json({ error: 'You can only edit your own meals' });

        const quantity = parseQuantity(req.body?.quantity, 1);
        const info = insertTripItem.run({ tripId: req.trip.id, category: 'grocery', tripDate: null, mealSlot: null, itemName: ingredientName, notes: null, createdBy: meal.created_by, createdAt: Date.now(), sourceItemId: mealId, quantity });
        const item = db.prepare('SELECT * FROM trip_items WHERE id = ?').get(info.lastInsertRowid);
        return res.status(201).json({ item });
    });

    server.delete('/api/summer-planning/items/:id', requirePlanningAuth, (req, res) => {
        const id = Number(req.params.id);
        const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
        if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid item id' });
        if (!name) return res.status(400).json({ error: 'Name is required' });

        const row = db.prepare('SELECT created_by FROM trip_items WHERE id = ? AND trip_id = ?').get(id, req.trip.id);
        if (!row) return res.status(404).json({ error: 'Item not found' });
        const isOwner = row.created_by.trim().toLowerCase() === name.toLowerCase();
        if (!isOwner && !isPlanningAdmin(name)) {
            return res.status(403).json({ error: 'You can only remove your own items' });
        }
        // Deleting a meal also removes the ingredient groceries linked to it.
        db.prepare('DELETE FROM trip_items WHERE (id = ? OR source_item_id = ?) AND trip_id = ?').run(id, id, req.trip.id);
        logger.info(`[Planning] ${name} removed item ${id}${isOwner ? '' : ' (admin)'}`);
        return res.json({ ok: true });
    });

    // Edit an item's name/notes (snacks, drinks, groceries, and meal ingredients).
    // An ingredient is a single grocery row shown both on its meal and in the grocery
    // list, so editing it here updates both places. Owner or admin only.
    server.patch('/api/summer-planning/items/:id', requirePlanningAuth, (req, res) => {
        const id = Number(req.params.id);
        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        const itemName = typeof req.body?.itemName === 'string' ? req.body.itemName.trim() : '';
        const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
        if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid item id' });
        if (!name) return res.status(400).json({ error: 'Name is required' });
        if (!itemName || itemName.length > 100) return res.status(400).json({ error: 'Item name is required (max 100 chars)' });
        if (notes.length > 300) return res.status(400).json({ error: 'Notes too long (max 300 chars)' });

        const row = db.prepare('SELECT created_by, category, quantity FROM trip_items WHERE id = ? AND trip_id = ?').get(id, req.trip.id);
        if (!row) return res.status(404).json({ error: 'Item not found' });
        if (row.category === 'meal') return res.status(400).json({ error: 'Meals are not editable here' });
        const isOwner = row.created_by.trim().toLowerCase() === name.toLowerCase();
        if (!isOwner && !isPlanningAdmin(name)) return res.status(403).json({ error: 'You can only edit your own items' });

        // Quantity only applies to groceries; keep the existing value if none was sent.
        const quantity = row.category === 'grocery' ? parseQuantity(req.body?.quantity, row.quantity || 1) : (row.quantity || 1);
        db.prepare('UPDATE trip_items SET item_name = ?, notes = ?, quantity = ? WHERE id = ?').run(itemName, notes || null, quantity, id);
        const item = db.prepare('SELECT * FROM trip_items WHERE id = ?').get(id);
        logger.info(`[Planning] ${name} edited item ${id}${isOwner ? '' : ' (admin)'}`);
        return res.json({ item });
    });

    // Toggle the shared "purchased" flag for every grocery row sharing a name (the
    // grocery list groups by name). Anybody can mark a shopping item bought.
    server.put('/api/summer-planning/groceries/purchased', requirePlanningAuth, (req, res) => {
        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        const itemName = typeof req.body?.itemName === 'string' ? req.body.itemName.trim() : '';
        const purchased = req.body?.purchased === true || req.body?.purchased === 'true';
        if (!name) return res.status(400).json({ error: 'Name is required' });
        if (!itemName) return res.status(400).json({ error: 'Item name is required' });

        const info = db.prepare(
            `UPDATE trip_items SET purchased_by = ? WHERE category = 'grocery' AND lower(trim(item_name)) = lower(trim(?)) AND trip_id = ?`
        ).run(purchased ? name : null, itemName, req.trip.id);
        if (info.changes === 0) return res.status(404).json({ error: 'No matching groceries' });
        logger.info(`[Planning] ${name} marked "${itemName}" ${purchased ? 'purchased' : 'unpurchased'} (${info.changes})`);
        return res.json({ ok: true, updated: info.changes });
    });

    server.put('/api/summer-planning/allergies', requirePlanningAuth, (req, res) => {
        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        const allergies = typeof req.body?.allergies === 'string' ? req.body.allergies.trim() : '';
        if (!name || name.length > 40) return res.status(400).json({ error: 'Name is required (max 40 chars)' });
        if (!allergies || allergies.length > 500) return res.status(400).json({ error: 'Allergies text is required (max 500 chars)' });

        db.prepare(`INSERT INTO trip_allergies (trip_id, name_key, display_name, allergies, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(trip_id, name_key) DO UPDATE SET display_name = excluded.display_name,
                allergies = excluded.allergies, updated_at = excluded.updated_at`)
            .run(req.trip.id, name.toLowerCase(), name, allergies, Date.now());
        return res.json({ ok: true });
    });

    server.delete('/api/summer-planning/allergies', requirePlanningAuth, (req, res) => {
        const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
        if (!name) return res.status(400).json({ error: 'Name is required' });
        const info = db.prepare('DELETE FROM trip_allergies WHERE trip_id = ? AND name_key = ?').run(req.trip.id, name.toLowerCase());
        if (info.changes === 0) return res.status(404).json({ error: 'No allergy entry found' });
        return res.json({ ok: true });
    });
}
