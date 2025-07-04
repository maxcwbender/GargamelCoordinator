import fetch from 'node-fetch';
import sqlite3 from 'sqlite3';
import express from 'express';
import net from 'net';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let config = JSON.parse(readFileSync(path.join(__dirname, '../config.json')));

const server = express();
server.use(express.json());
server.use(express.static(path.join(__dirname, '../public')));

// Serve static files from node_modules
server.use('/node_modules', express.static('node_modules'));


// Optional: Add CORS if needed for browsers
server.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');  // Allow all for testing
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

let db = new sqlite3.Database('../allUsers.db');

server.get('/', (request, response) => {
    console.log('GET: ' + request.url);
    console.log('------------------------------------------');
    return response.sendFile(path.join(__dirname, '../public/index.html'));
});

server.put('/', async (req, res) => {
    console.log('PUT: ' + JSON.stringify(req.body));
    console.log('------------------------------------------');

    const { tokenType, accessToken } = req.body;

    if (!tokenType || !accessToken) {
        return res.status(400).json({ result: 'Missing token information' });
    }

    try {
        const [userRes, connRes] = await Promise.all([
            fetch('https://discord.com/api/users/@me', {
                headers: { authorization: `${tokenType} ${accessToken}` },
            }),
            fetch('https://discord.com/api/users/@me/connections', {
                headers: { authorization: `${tokenType} ${accessToken}` },
            }),
        ]);

        const user = await userRes.json();
        const connections = await connRes.json();

        if (!user.id) {
            console.error('Invalid Discord token or user not found');
            return res.status(400).json({ result: 'Invalid Discord credentials' });
        }

        const discordID = user.id;
        let steamID = null;
        let steamName = null;

        for (const conn of connections) {
            if (conn.type === 'steam') {
                steamID = conn.id;
                steamName = conn.name;
                break;
            }
        }

        if (!steamID) {
            return res.status(202).json({ result: 'No Steam ID linked' });
        }

        // Insert user into database
        const stmt = db.prepare(`
            INSERT INTO users (discord_id, steam_id, dateCreated, modsRemaining, timesVouched) 
            VALUES (?, ?, datetime('now'), ?, 0)
            ON CONFLICT(discord_id) DO UPDATE SET 
                steam_id = excluded.steam_id
        `);
        await new Promise((resolve, reject) => {
            stmt.run(discordID, steamID, config.MOD_ASSIGNMENT, err => {
                if (err) console.error('DB upsert error:', err.message);
                else resolve();
            });
        });
        stmt.finalize();

        // Notify local pipe
        try {
            const socketPipe = new net.Socket();
            socketPipe.on('error', err => {
                console.error('Pipe connection error:', err);
            });
            socketPipe.connect(config.pipePort, '127.0.0.1', function () {
                socketPipe.write(`${discordID}`);
                socketPipe.end();
            });
        } catch (pipeErr) {
            console.error('Pipe error:', pipeErr);
        }

        // Add member to guild
        fetch(`https://discord.com/api/guilds/${config.GUILD_ID}/members/${discordID}`, {
            method: 'PUT',
            body: JSON.stringify({ access_token: accessToken }),
            headers: {
                'Authorization': `Bot ${config.BOT_TOKEN}`,
                'Content-Type': 'application/json',
            },
        }).then(res => {
            if (!res.ok) {
                return res.text().then(text => {
                    console.error(`Failed to add user to guild: ${res.status} ${text}`);
                });
            } else {
                console.log(`Successfully added ${discordID} to guild.`);
            }
        }).catch(err => {
            console.error('Guild add error:', err);
        });

        console.log(`Registered: ${discordID} with Steam ${steamName} (${steamID})`);
        return res.status(201).json({ result: steamName });
    } catch (err) {
        console.error('Unhandled server error:', err);
        return res.status(500).json({ result: 'Server error occurred' });
    }
});

server.listen(80, '0.0.0.0', () => console.log(`Server listening at http://localhost:80`));
