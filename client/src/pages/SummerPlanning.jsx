import { useCallback, useEffect, useRef, useState } from 'react';

const API = '/api/summer-planning';

const SLOTS = [
    { key: 'breakfast', label: '☕ Breakfast' },
    { key: 'lunch', label: '🥪 Lunch' },
    { key: 'dinner', label: '🍽️ Dinner' },
];
const LISTS = [
    { key: 'snack', title: '🍿 Snacks', placeholder: 'Snack (e.g. trail mix)' },
    { key: 'drink', title: '🍹 Drinks & Alcohol', placeholder: 'Drink (e.g. White Claw 12-pack)' },
    { key: 'grocery', title: '🛒 Groceries', placeholder: 'Grocery item (e.g. carton of eggs)' },
];

const norm = s => String(s || '').trim().toLowerCase();
const clampQty = v => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 1 ? Math.min(n, 9999) : 1; };

// 'YYYY-MM-DD' -> { date, dow, dom, label } (UTC so the labels don't shift a
// day for viewers west of the date line).
function buildDays(dates) {
    return (dates || []).map(date => {
        const [y, m, d] = date.split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        return {
            date,
            dow: dt.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
            dom: d,
            label: dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }),
        };
    });
}

// Inline edit form for an item (snack/drink/grocery/grocery member). Groceries
// also get a quantity field. Enter saves, Escape cancels.
function EditRow({ item, onSave, onCancel }) {
    const [name, setName] = useState(item.item_name);
    const [notes, setNotes] = useState(item.notes || '');
    const [quantity, setQuantity] = useState(item.quantity || 1);
    const nameRef = useRef(null);

    useEffect(() => {
        const f = nameRef.current;
        if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
    }, []);

    const save = () => onSave(item.id, { itemName: name, notes, quantity: clampQty(quantity) });
    const onKeyDown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };

    return (
        <li className="edit-row">
            <input ref={nameRef} className="edit-field" value={name} onChange={e => setName(e.target.value)}
                onKeyDown={onKeyDown} maxLength={100} placeholder="Name" aria-label="Item name" />
            {item.category === 'grocery' && (
                <input className="edit-field qty-input" type="number" min="1" max="9999" value={quantity}
                    onChange={e => setQuantity(e.target.value)} onKeyDown={onKeyDown} aria-label="Quantity" title="Number of items" />
            )}
            <input className="edit-field" value={notes} onChange={e => setNotes(e.target.value)}
                onKeyDown={onKeyDown} maxLength={300} placeholder="Notes (optional)" aria-label="Notes" />
            <button className="btn btn-sm" onClick={save}>Save</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>Cancel</button>
        </li>
    );
}

// Add form for snacks / drinks / groceries.
function AddItemForm({ category, placeholder, onAdd }) {
    const [itemName, setItemName] = useState('');
    const [notes, setNotes] = useState('');
    const [quantity, setQuantity] = useState(1);
    const [busy, setBusy] = useState(false);

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        const payload = { category, itemName, notes };
        if (category === 'grocery') payload.quantity = clampQty(quantity);
        const ok = await onAdd(payload);
        if (ok) { setItemName(''); setNotes(''); setQuantity(1); }
        setBusy(false);
    };

    return (
        <form className={'add-form' + (category === 'grocery' ? ' grocery-add' : '')} onSubmit={submit}>
            <input type="text" value={itemName} onChange={e => setItemName(e.target.value)}
                placeholder={placeholder} maxLength={100} required />
            {category === 'grocery' && (
                <input type="number" className="qty-input" min="1" max="9999" value={quantity}
                    onChange={e => setQuantity(e.target.value)} aria-label="Quantity" title="Number of items" />
            )}
            <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="Notes (optional)" maxLength={300} />
            <button type="submit" className="btn btn-sm" disabled={busy}>Add</button>
        </form>
    );
}

// New-meal form with the staged-ingredient builder. Pending ingredients live in
// the parent (keyed by date|slot) so they survive collapsing/expanding the day.
function MealForm({ dayDate, slotKey, pending, onStageIngredient, onUnstageIngredient, onAddMeal }) {
    const [itemName, setItemName] = useState('');
    const [notes, setNotes] = useState('');
    const [ingName, setIngName] = useState('');
    const [ingQty, setIngQty] = useState(1);
    const [busy, setBusy] = useState(false);

    const stage = () => {
        if (onStageIngredient(ingName, ingQty)) {
            setIngName('');
            setIngQty(1);
        }
    };

    const onIngKeyDown = (e) => {
        // Enter in either the ingredient name or its quantity adds the ingredient
        // (and crucially prevents the surrounding meal form from submitting).
        if (e.key === 'Enter') { e.preventDefault(); stage(); }
    };

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        const ok = await onAddMeal({
            category: 'meal',
            tripDate: dayDate,
            mealSlot: slotKey,
            itemName,
            notes,
            ingredients: pending,
        });
        if (ok) { setItemName(''); setNotes(''); }
        setBusy(false);
    };

    return (
        <form className="add-form meal-form" onSubmit={submit}>
            <div className="meal-form-row">
                <input type="text" value={itemName} onChange={e => setItemName(e.target.value)}
                    placeholder="Meal you'll cook / buy for" maxLength={100} required />
                <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
                    placeholder="Notes (optional)" maxLength={300} />
            </div>
            <div className="ingredient-builder">
                <div className="ing-builder-label">Ingredients you'll buy, added to Groceries</div>
                <div className="ing-chip-row">
                    {pending.map((ing, i) => (
                        <span key={i} className="ing-chip">
                            {ing.name}{ing.quantity > 1 ? ` ×${ing.quantity}` : ''}
                            <button type="button" className="ing-x" onClick={() => onUnstageIngredient(i)}
                                aria-label={`remove ${ing.name}`}>×</button>
                        </span>
                    ))}
                </div>
                <div className="ing-add-row">
                    <input type="text" className="ing-input" value={ingName} onChange={e => setIngName(e.target.value)}
                        onKeyDown={onIngKeyDown} placeholder="Add an ingredient…" maxLength={100} />
                    <input type="number" className="qty-input" min="1" max="9999" value={ingQty}
                        onChange={e => setIngQty(e.target.value)} onKeyDown={onIngKeyDown}
                        aria-label="Quantity" title="Number of items" />
                    <button type="button" className="btn btn-sm btn-ghost" onClick={stage}>+ Add</button>
                </div>
            </div>
            <button type="submit" className="btn btn-sm meal-submit" disabled={busy}>Add meal</button>
        </form>
    );
}

// Inline "+ ingredient" control on an already-saved meal.
function SavedIngredientAdder({ onAdd }) {
    const [name, setName] = useState('');
    const [qty, setQty] = useState(1);

    const add = async () => {
        if (!name.trim()) return;
        if (await onAdd(name.trim(), clampQty(qty))) { setName(''); setQty(1); }
    };
    const onKeyDown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };

    return (
        <span className="ing-add-inline">
            <input type="text" className="ing-input-sm" value={name} onChange={e => setName(e.target.value)}
                onKeyDown={onKeyDown} placeholder="+ ingredient" maxLength={100} />
            <input type="number" className="qty-input-sm" value={qty} onChange={e => setQty(e.target.value)}
                onKeyDown={onKeyDown} min="1" max="9999" aria-label="Quantity" title="Number of items" />
            <button type="button" className="ing-add-btn" onClick={add}>add</button>
        </span>
    );
}

// Inline editor for a saved ingredient chip.
function IngredientChipEditor({ item, onSave, onCancel }) {
    const [name, setName] = useState(item.item_name);
    const ref = useRef(null);
    useEffect(() => { ref.current?.focus(); }, []);
    const save = () => onSave(item.id, { itemName: name, notes: item.notes || '' });
    return (
        <span className="ing-chip editing">
            <input ref={ref} className="ing-edit-input" value={name} onChange={e => setName(e.target.value)}
                onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); save(); }
                    else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
                }}
                maxLength={100} aria-label="Edit ingredient" />
            <button className="ing-x" onClick={save} aria-label="save">✓</button>
            <button type="button" className="ing-x" onClick={onCancel} aria-label="cancel">✕</button>
        </span>
    );
}

export default function SummerPlanning() {
    const [token, setToken] = useState(() => { try { return localStorage.getItem('sp_token') || ''; } catch { return ''; } });
    const [myName, setMyName] = useState(() => { try { return localStorage.getItem('sp_name') || ''; } catch { return ''; } });
    const [data, setData] = useState({ items: [], allergies: [], trip: null });
    const [isAdmin, setIsAdmin] = useState(false);
    const [expandedDate, setExpandedDate] = useState(null);
    const [editingId, setEditingId] = useState(null);
    const [expandedGroceries, setExpandedGroceries] = useState(() => new Set());
    const [pendingI, setPendingI] = useState({}); // `${date}|${slot}` -> [{name, quantity}]
    const [toast, setToast] = useState(null); // { msg, isError }
    const toastTimer = useRef(null);

    const [gatePassword, setGatePassword] = useState('');
    const [gateBusy, setGateBusy] = useState(false);
    const [gateError, setGateError] = useState('');
    const [nameInput, setNameInput] = useState('');
    const [nameError, setNameError] = useState('');
    const [allergyInput, setAllergyInput] = useState('');
    const allergyFocused = useRef(false);

    const showToast = useCallback((msg, isError) => {
        setToast({ msg, isError });
        clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), 2500);
    }, []);

    const tokenRef = useRef(token);
    tokenRef.current = token;

    const api = useCallback(async (path, opts = {}) => {
        const res = await fetch(API + path, {
            ...opts,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + tokenRef.current,
                ...(opts.headers || {}),
            },
        });
        if (res.status === 401) {
            try { localStorage.removeItem('sp_token'); } catch {}
            setToken('');
            throw new Error('Password changed. Please re-enter it');
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || ('Request failed (' + res.status + ')'));
        return body;
    }, []);

    const loadData = useCallback(async (name) => {
        const d = await api('/data' + (name ? '?name=' + encodeURIComponent(name) : ''));
        setData(d);
        setIsAdmin(!!d.isAdmin);
        return d;
    }, [api]);

    // Boot / reload whenever auth state changes
    useEffect(() => {
        if (!token) return;
        loadData(myName).catch(err => showToast(err.message, true));
    }, [token, myName, loadData, showToast]);

    // Keep the allergy textarea mirroring the saved value (unless being edited)
    useEffect(() => {
        if (allergyFocused.current) return;
        const mine = data.allergies.find(a => a.name_key === norm(myName));
        setAllergyInput(mine ? mine.allergies : '');
    }, [data, myName]);

    const isMine = name => norm(name) === norm(myName);
    const canModify = it => isMine(it.created_by) || isAdmin;
    const TRIP_DAYS = buildDays(data.trip && data.trip.dates);

    // Wraps a mutation: run it, reload, toast errors.
    const mutate = useCallback(async (fn) => {
        try {
            await fn();
            await loadData(myName);
            return true;
        } catch (err) {
            showToast(err.message, true);
            return false;
        }
    }, [loadData, myName, showToast]);

    // ── Screens ───────────────────────────────────────────────
    const screen = !token ? 'gate' : (!myName ? 'name' : 'main');

    const submitGate = async (e) => {
        e.preventDefault();
        setGateBusy(true);
        setGateError('');
        try {
            const res = await fetch(API + '/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: gatePassword }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.error || 'Something went wrong');
            try { localStorage.setItem('sp_token', body.token); } catch {}
            setGatePassword('');
            setToken(body.token);
        } catch (err) {
            setGateError(err.message);
        } finally {
            setGateBusy(false);
        }
    };

    const pickName = (name) => {
        name = name.trim();
        if (!name || name.length > 40) {
            setNameError('Please enter a first name (max 40 characters)');
            return;
        }
        try { localStorage.setItem('sp_name', name); } catch {}
        setNameError('');
        setMyName(name);
    };

    if (screen === 'gate') {
        return (
            <div className="overlay">
                <form className="overlay-card" onSubmit={submitGate}>
                    <h1>Summer Planning</h1>
                    <div className="sub">Enter your trip's password. It picks which trip you're planning</div>
                    <input type="password" value={gatePassword} onChange={e => setGatePassword(e.target.value)}
                        placeholder="Trip password" autoComplete="current-password" required />
                    <button type="submit" className="btn btn-block" disabled={gateBusy}>Enter</button>
                    <div className="error-msg">{gateError}</div>
                </form>
            </div>
        );
    }

    if (screen === 'name') {
        // Known names from existing items/allergies, as tappable chips.
        const names = new Map(); // norm -> display
        for (const it of data.items) if (!names.has(norm(it.created_by))) names.set(norm(it.created_by), it.created_by.trim());
        for (const a of data.allergies) if (!names.has(a.name_key)) names.set(a.name_key, a.display_name);
        const sorted = [...names.values()].sort((a, b) => a.localeCompare(b));

        return (
            <div className="overlay">
                <form className="overlay-card" onSubmit={e => { e.preventDefault(); pickName(nameInput); }}>
                    <h1>Who are you?</h1>
                    <div className="sub">Your first name is shown next to everything you sign up for</div>
                    {sorted.length > 0 && (
                        <div>
                            <div className="chips-label">Already planning? Tap your name:</div>
                            <div className="name-chips">
                                {sorted.map(display => (
                                    <button key={display} type="button" className="name-chip"
                                        onClick={() => pickName(display)}>{display}</button>
                                ))}
                            </div>
                        </div>
                    )}
                    <input type="text" value={nameInput} onChange={e => setNameInput(e.target.value)}
                        placeholder="First name" maxLength={40} autoComplete="given-name" required />
                    <button type="submit" className="btn btn-block">Let's plan</button>
                    <div className="error-msg">{nameError}</div>
                </form>
            </div>
        );
    }

    // ── Main planner ──────────────────────────────────────────
    const trip = data.trip || {};

    const addItem = (payload) => mutate(() => api('/items', {
        method: 'POST',
        body: JSON.stringify({ ...payload, createdBy: myName }),
    }));

    const removeItem = (id) => mutate(() => api('/items/' + id + '?name=' + encodeURIComponent(myName), { method: 'DELETE' }));

    const saveEdit = (id, { itemName, notes, quantity }) => {
        if (!itemName || !itemName.trim()) { showToast('Name cannot be empty', true); return; }
        const payload = { name: myName, itemName: itemName.trim(), notes: notes || '' };
        if (quantity != null) payload.quantity = quantity;
        mutate(async () => {
            await api('/items/' + id, { method: 'PATCH', body: JSON.stringify(payload) });
            setEditingId(null);
        });
    };

    const addSavedIngredient = (mealId) => (name, quantity) =>
        mutate(() => api('/items/' + mealId + '/ingredients', {
            method: 'POST', body: JSON.stringify({ name: myName, itemName: name, quantity }),
        }));

    const togglePurchased = (itemName, purchased) => mutate(() => api('/groceries/purchased', {
        method: 'PUT', body: JSON.stringify({ name: myName, itemName, purchased }),
    }));

    const saveAllergies = (e) => {
        e.preventDefault();
        const allergies = allergyInput.trim();
        if (!allergies) return showToast('Enter your allergies or dietary restrictions first', true);
        mutate(() => api('/allergies', { method: 'PUT', body: JSON.stringify({ name: myName, allergies }) }));
    };

    const removeAllergy = () => mutate(() => api('/allergies?name=' + encodeURIComponent(myName), { method: 'DELETE' }));

    const stageIngredient = (key) => (rawName, rawQty) => {
        const val = String(rawName || '').trim();
        if (!val) return false;
        if (val.length > 100) { showToast('Ingredient too long (max 100 chars)', true); return false; }
        const list = pendingI[key] || [];
        if (list.length >= 40) { showToast('That’s plenty of ingredients (max 40)', true); return false; }
        setPendingI({ ...pendingI, [key]: [...list, { name: val, quantity: clampQty(rawQty) }] });
        return true;
    };

    const unstageIngredient = (key) => (idx) => {
        const list = [...(pendingI[key] || [])];
        list.splice(idx, 1);
        setPendingI({ ...pendingI, [key]: list });
    };

    const addMeal = (key) => async (payload) => {
        const ok = await addItem(payload);
        if (ok) setPendingI(prev => { const next = { ...prev }; delete next[key]; return next; });
        return ok;
    };

    // ── Sub-renderers ─────────────────────────────────────────
    const removeBtn = (it) => canModify(it) && (
        <button className="remove-btn" onClick={() => removeItem(it.id)}>
            {isMine(it.created_by) ? 'remove' : 'remove (admin)'}
        </button>
    );

    const editBtn = (it) => canModify(it) && (
        <button className="edit-btn" onClick={() => setEditingId(it.id)}>edit</button>
    );

    const itemRow = (it) => editingId === it.id
        ? <EditRow key={it.id} item={it} onSave={saveEdit} onCancel={() => setEditingId(null)} />
        : (
            <li key={it.id}>
                <span className="item-name">{it.item_name}</span>
                <span className="item-notes">{it.notes || ''}</span>
                <span className="item-by">by {it.created_by}</span>
                {editBtn(it)}{removeBtn(it)}
            </li>
        );

    const mealTag = (meal) => {
        const day = TRIP_DAYS.find(d => d.date === meal.trip_date);
        const slot = SLOTS.find(s => s.key === meal.meal_slot);
        const slotName = slot ? slot.label.replace(/^\S+\s/, '') : '';
        return (
            <span key={meal.id} className="grocery-src" title="ingredient for a meal">
                🍳 {meal.item_name}{day ? ` · ${day.dow} ${slotName}` : ''}
            </span>
        );
    };

    const mealRow = (meal) => {
        const canEdit = canModify(meal);
        const ings = data.items.filter(g => g.source_item_id === meal.id);
        const chips = ings.map(g => {
            if (editingId === g.id) {
                return <IngredientChipEditor key={g.id} item={g}
                    onSave={(id, fields) => saveEdit(id, fields)} onCancel={() => setEditingId(null)} />;
            }
            return (
                <span key={g.id} className="ing-chip saved">
                    {g.item_name}{(g.quantity || 1) > 1 ? ` ×${g.quantity}` : ''}
                    {canEdit && (
                        <>
                            <button className="ing-edit" onClick={() => setEditingId(g.id)}
                                aria-label={`edit ${g.item_name}`}>✎</button>
                            <button className="ing-x" onClick={() => removeItem(g.id)}
                                aria-label={`remove ${g.item_name}`}>×</button>
                        </>
                    )}
                </span>
            );
        });

        return (
            <li key={meal.id} className="meal-item">
                <div className="meal-line">
                    <span className="item-name">{meal.item_name}</span>
                    <span className="item-notes">{meal.notes || ''}</span>
                    <span className="item-by">by {meal.created_by}</span>
                    {removeBtn(meal)}
                </div>
                {(chips.length > 0 || canEdit) && (
                    <div className="meal-ings">
                        {chips}
                        {canEdit && <SavedIngredientAdder onAdd={addSavedIngredient(meal.id)} />}
                    </div>
                )}
            </li>
        );
    };

    // ── Grocery grouping (shopping list) ──────────────────────
    const isGroupPurchased = g => g.members.length > 0 && g.members.every(m => m.purchased_by);

    const groups = (() => {
        const map = new Map();
        for (const g of data.items.filter(it => it.category === 'grocery')) {
            const k = norm(g.item_name);
            if (!map.has(k)) map.set(k, { key: k, name: g.item_name, members: [] });
            map.get(k).members.push(g);
        }
        return [...map.values()].sort((a, b) => {
            const ap = isGroupPurchased(a) ? 1 : 0, bp = isGroupPurchased(b) ? 1 : 0;
            return ap - bp || a.name.localeCompare(b.name);
        });
    })();

    const groceryMemberRow = (m) => editingId === m.id
        ? <EditRow key={m.id} item={m} onSave={saveEdit} onCancel={() => setEditingId(null)} />
        : (
            <li key={m.id} className="grocery-member">
                <span className="grocery-qty">{m.quantity || 1}×</span>
                <span className="item-name">{m.item_name}</span>
                {m.source_item_id ? (data.items.filter(x => x.id === m.source_item_id).map(mealTag)) : null}
                {m.notes ? <span className="item-notes">{m.notes}</span> : null}
                <span className="item-by">by {m.created_by}</span>
                {editBtn(m)}{removeBtn(m)}
            </li>
        );

    const toggleGroceryExpand = (key) => {
        setExpandedGroceries(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });
    };

    const groceryGroupRow = (group) => {
        const single = group.members.length === 1;
        if (single && editingId === group.members[0].id) {
            return (
                <li key={group.key} className="grocery-group">
                    <ul className="grocery-members">
                        <EditRow item={group.members[0]} onSave={saveEdit} onCancel={() => setEditingId(null)} />
                    </ul>
                </li>
            );
        }
        const anyEditing = group.members.some(m => m.id === editingId);
        const expanded = expandedGroceries.has(group.key) || anyEditing;
        const purchased = isGroupPurchased(group);
        const totalQty = group.members.reduce((s, m) => s + (m.quantity || 1), 0);
        const mealIds = [...new Set(group.members.filter(m => m.source_item_id).map(m => m.source_item_id))];
        const tags = mealIds.map(id => data.items.find(m => m.id === id)).filter(Boolean).map(mealTag);
        const contributors = [...new Set(group.members.map(m => m.created_by))];
        const purchasedBy = purchased ? group.members.find(m => m.purchased_by)?.purchased_by : null;

        return (
            <li key={group.key} className={'grocery-group' + (purchased ? ' purchased' : '')}>
                <div className="grocery-main">
                    <input type="checkbox" className="purchase-box" checked={purchased}
                        onChange={e => togglePurchased(group.name, e.target.checked)}
                        aria-label={`Mark ${group.name} purchased`} />
                    <span className="grocery-qty">{totalQty}×</span>
                    <span className="item-name">{group.name}</span>
                    {tags}
                    <span className="item-by">by {contributors.join(', ')}</span>
                    {purchasedBy ? <span className="purchased-tag">bought · {purchasedBy}</span> : null}
                    {single && canModify(group.members[0])
                        ? <>{editBtn(group.members[0])}{removeBtn(group.members[0])}</>
                        : (!single && (
                            <button className="manage-btn" onClick={() => toggleGroceryExpand(group.key)}>
                                {expanded ? '▴' : '▾'} {group.members.length} entries
                            </button>
                        ))}
                </div>
                {expanded && !single && (
                    <ul className="grocery-members">{group.members.map(groceryMemberRow)}</ul>
                )}
            </li>
        );
    };

    // ── Calendar ──────────────────────────────────────────────
    const selectedDay = TRIP_DAYS.find(d => d.date === expandedDate);

    const mineAllergy = data.allergies.find(a => a.name_key === norm(myName));

    return (
        <div className="pc-sp">
            <div className="sp-page-header">
                <div>
                    <h1>{(trip.name || 'Trip') + ' Planning'}</h1>
                    <div className="trip-sub">{(trip.datesLabel ? trip.datesLabel + ' · ' : '') + 'Meals, snacks & groceries'}</div>
                </div>
                <div className="user-chip">
                    Planning as <strong>{myName}</strong>
                    {isAdmin && <span className="admin-badge">admin</span>} ·{' '}
                    <button className="link-btn" onClick={() => {
                        try { localStorage.removeItem('sp_name'); } catch {}
                        setMyName('');
                    }}>change</button>
                </div>
            </div>

            <div className="sp-layout">
                <div className="main-col">
                    <div className="sp-card">
                        <h2>📅 Trip Calendar</h2>
                        <div className="day-strip" style={{ gridTemplateColumns: `repeat(${TRIP_DAYS.length || 1}, 1fr)` }}>
                            {TRIP_DAYS.map(d => {
                                const count = data.items.filter(it => it.category === 'meal' && it.trip_date === d.date).length;
                                return (
                                    <div key={d.date}
                                        className={'day-card' + (expandedDate === d.date ? ' selected' : '')}
                                        onClick={() => setExpandedDate(expandedDate === d.date ? null : d.date)}>
                                        <div className="dow">{d.dow}</div>
                                        <div className="dom">{d.dom}</div>
                                        <div className="meal-count">{count ? count + (count === 1 ? ' meal' : ' meals') : ' '}</div>
                                    </div>
                                );
                            })}
                        </div>
                        {selectedDay && (
                            <div className="day-detail">
                                <div className="day-detail-title">{selectedDay.label}</div>
                                {SLOTS.map(slot => {
                                    const meals = data.items.filter(it => it.category === 'meal'
                                        && it.trip_date === selectedDay.date && it.meal_slot === slot.key);
                                    const key = selectedDay.date + '|' + slot.key;
                                    return (
                                        <div key={slot.key} className="slot">
                                            <div className="slot-header">{slot.label}</div>
                                            {meals.length > 0
                                                ? <ul className="item-list">{meals.map(mealRow)}</ul>
                                                : <div className="empty-note">Nothing claimed yet. Be the hero.</div>}
                                            <MealForm
                                                dayDate={selectedDay.date}
                                                slotKey={slot.key}
                                                pending={pendingI[key] || []}
                                                onStageIngredient={stageIngredient(key)}
                                                onUnstageIngredient={unstageIngredient(key)}
                                                onAddMeal={addMeal(key)}
                                            />
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {LISTS.map(list => (
                        <div key={list.key} className="sp-card">
                            <h2>{list.title}</h2>
                            {list.key === 'grocery' ? (
                                <>
                                    {groups.length > 0
                                        ? <ul className="grocery-list">{groups.map(groceryGroupRow)}</ul>
                                        : <div className="empty-note">Nothing here yet.</div>}
                                    <AddItemForm category="grocery" placeholder={list.placeholder} onAdd={addItem} />
                                </>
                            ) : (
                                <>
                                    {data.items.some(it => it.category === list.key)
                                        ? <ul className="item-list">{data.items.filter(it => it.category === list.key).map(itemRow)}</ul>
                                        : <div className="empty-note">Nothing here yet.</div>}
                                    <AddItemForm category={list.key} placeholder={list.placeholder} onAdd={addItem} />
                                </>
                            )}
                        </div>
                    ))}
                </div>

                <aside className="sidebar">
                    <div className="sp-card">
                        <h2>⚠️ Allergies & Dietary Restrictions</h2>
                        <ul className="allergy-list">
                            {data.allergies.length === 0
                                ? <li><span className="a-text empty-note">Nothing recorded yet.</span></li>
                                : data.allergies.map(a => (
                                    <li key={a.name_key}>
                                        <span className="a-name">{a.display_name}:</span>
                                        <span className="a-text">{a.allergies}</span>
                                        {a.name_key === norm(myName) && (
                                            <button className="remove-btn" onClick={removeAllergy}>remove</button>
                                        )}
                                    </li>
                                ))}
                        </ul>
                        <form className="allergy-form" onSubmit={saveAllergies}>
                            <div className="allergy-form-label">
                                {mineAllergy ? 'Update yours:' : 'Add your allergies or dietary needs so cooks can plan:'}
                            </div>
                            <textarea value={allergyInput}
                                onChange={e => setAllergyInput(e.target.value)}
                                onFocus={() => { allergyFocused.current = true; }}
                                onBlur={() => { allergyFocused.current = false; }}
                                maxLength={500}
                                placeholder="e.g. peanuts, shellfish, vegetarian, gluten-free"></textarea>
                            <button type="submit" className="btn btn-sm btn-block">Save mine</button>
                        </form>
                    </div>
                </aside>
            </div>

            {toast && (
                <div className={'sp-toast show' + (toast.isError ? ' error' : '')}>{toast.msg}</div>
            )}
        </div>
    );
}
