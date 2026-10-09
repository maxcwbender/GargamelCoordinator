// Register a FAKE user without going through Discord OAuth, to exercise
// referral tracking end to end on the server: the users row is written through
// the same code the real flow uses (so referral_stats is bumped too), and the
// bot is poked over its local pipe exactly as after a real registration. The
// bot should then post "<@id> joined registration queue! (Rating: **3300**) |
// Source: **reddit**" in the mod channel, /list_registration_queue should show
// the fake user with a Source line, and /referral_stats should count it.
//
// Run on the server (repo root, same .env / config.json / allUsers.db as the site):
//
//   node scripts/fake-register.mjs --ref reddit                  # arrived via the ?ref=reddit promo link
//   node scripts/fake-register.mjs --referred-by "Bender"        # regular visitor who picked a player
//   node scripts/fake-register.mjs --ref reddit --rank Divine    # pick a rank (default Legend)
//   node scripts/fake-register.mjs --ref reddit --no-pipe        # write the row, don't notify the bot
//   node scripts/fake-register.mjs --show                        # print the fake user's row
//   node scripts/fake-register.mjs --stats                       # print the referral_stats tally
//   node scripts/fake-register.mjs --remove                      # delete the fake user and undo its tally
//
// --discord-id / --steam-id override the ids. The script refuses to touch a
// Discord id that already has a users row unless --replace is given, so a typo
// can't overwrite a real player's registration. --referred-by skips the live
// member-name check the real flow does (there is no OAuth here), so any name
// works. The fake user is never added to the Discord server, so mods will see
// "User 990000000000000001" instead of a display name — that is expected.
//
// Note: the bot also tries to Steam-friend the fake steam id from its Dota
// clients; that attempt fails harmlessly and is logged as a warning.

import { db } from '../server/db.mjs';
import {
    RANK_TO_RATING, RANKS, normalizeReferralSource, saveRegistration, notifyBotPipe, getRegistration,
    forgetReferralStats, listReferralStats,
} from '../server/services/registration.mjs';

const DEFAULT_DISCORD_ID = '990000000000000001'; // obviously fake, well outside any real snowflake range in use
const DEFAULT_STEAM_ID = '76561198860265729';     // = account id 900000001

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const discordID = String(opt('--discord-id', DEFAULT_DISCORD_ID));
const steamID = String(opt('--steam-id', DEFAULT_STEAM_ID));
const rank = opt('--rank', 'Legend');
const ref = opt('--ref', null);
const referredBy = opt('--referred-by', null);

const selectRow = db.prepare(`
    SELECT CAST(discord_id AS TEXT) AS discord_id, CAST(steam_id AS TEXT) AS steam_id, rating, modsRemaining,
           dateCreated, referred_by, referral_source
    FROM users WHERE CAST(discord_id AS TEXT) = ?
`);

function printRow() {
    const row = selectRow.get(discordID);
    console.log(row ? row : `No users row for ${discordID}`);
    return row;
}

function printStats() {
    const rows = listReferralStats();
    if (!rows.length) return console.log('referral_stats is empty.');
    console.table(rows);
}

if (flag('--help') || args.length === 0) {
    console.log(`usage: node scripts/fake-register.mjs [--ref <tag>] [--referred-by <name>] [--rank <rank>] [--discord-id <id>] [--steam-id <id>] [--replace] [--no-pipe]
       node scripts/fake-register.mjs --show   [--discord-id <id>]
       node scripts/fake-register.mjs --stats
       node scripts/fake-register.mjs --remove [--discord-id <id>]
ranks: ${RANKS.join(', ')}`);
    process.exit(0);
}

if (flag('--show')) {
    printRow();
    process.exit(0);
}

if (flag('--stats')) {
    printStats();
    process.exit(0);
}

if (flag('--remove')) {
    const row = selectRow.get(discordID);
    const notes = db.prepare('DELETE FROM mod_notes WHERE CAST(registrant_id AS TEXT) = ?').run(discordID).changes;
    const users = db.prepare('DELETE FROM users WHERE CAST(discord_id AS TEXT) = ?').run(discordID).changes;
    if (row) forgetReferralStats({ referralSource: row.referral_source, referredBy: row.referred_by });
    console.log(`Removed ${users} users row(s) and ${notes} mod_notes row(s) for ${discordID}; referral tally adjusted.`);
    if (users) console.log('If the bot already announced them, the queue entry is gone; /list_registration_queue will no longer list them.');
    printStats();
    process.exit(0);
}

if (!RANKS.includes(rank)) {
    console.error(`Unknown rank '${rank}'. Choose one of: ${RANKS.join(', ')}`);
    process.exit(1);
}
const referralSource = normalizeReferralSource(ref);
if (ref && !referralSource) {
    console.error(`'${ref}' is not a usable referral tag (lower-case letters, digits, _ and - only).`);
    process.exit(1);
}
if (!referralSource && !referredBy) console.warn('Neither --ref nor --referred-by given: registering with no attribution.');

if (getRegistration(discordID) && !flag('--replace')) {
    console.error(`A users row already exists for ${discordID}. Refusing to overwrite it; pass --replace if you really mean it.`);
    printRow();
    process.exit(1);
}

const rating = RANK_TO_RATING[rank];
const { isNew } = saveRegistration({ discordID, steamID, rating, referralSource, referredBy });
console.log(`Registered fake user ${discordID} (steam ${steamID}, rank ${rank} -> rating ${rating}, `
    + `source ${referralSource || 'none'}, referred by ${referredBy || 'none'})${isNew ? '' : ' — existing row refreshed, tally not bumped'}.`);
printRow();
printStats();

if (flag('--no-pipe')) {
    console.log('Skipped the bot pipe (--no-pipe). Run /list_registration_queue in the mod channel to see the attribution.');
} else {
    notifyBotPipe(discordID);
    console.log('Poked the bot pipe. Watch the mod channel for "joined registration queue!" with the attribution,');
    console.log('then check /list_registration_queue and /referral_stats. Clean up with: node scripts/fake-register.mjs --remove');
}
// The pipe write is asynchronous; give the socket a moment to flush before the process exits.
setTimeout(() => process.exit(0), 500);
