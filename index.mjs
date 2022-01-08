import fetch from 'node-fetch';
import sqlite3 from 'sqlite3';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const config = require('./config.json');

const server = express();
server.use(express.json());

let db = new sqlite3.Database('allUsers.db');

server.get('/', (request, response) => {
    console.log('GET: '+request.url);
    console.log('------------------------------------------');
	return response.sendFile('index.html', { root: '.' });
});

server.put('/', (request, response) => {
    response.status(102)
    console.log('PUT: '+JSON.stringify(request.body));
    let tokenType = request.body.tokenType;
    let accessToken = request.body.accessToken;
    let discordID = -1;
    let steamID = -1;
    console.log('------------------------------------------');
    let result1 = fetch('https://discord.com/api/users/@me', {
        headers: {
            authorization: `${tokenType} ${accessToken}`,
        }
    }); let result2 = fetch('https://discord.com/api/users/@me/connections', {
        headers: {
            authorization: `${tokenType} ${accessToken}`,
        }
    }); 
    Promise.all([result1, result2]).then( values => {
        let json1 = values[0].json();
        let json2 = values[1].json();
        Promise.all([json1, json2]).then( values2 => {
            discordID = values2[0].id;
            console.log('discordID: '+discordID);
            for (const obj in values2[1]) {
                if(values2[1][obj].type == 'steam'){
                    steamID = values2[1][obj].id;
                    console.log('SteamID: '+steamID);
                } 
            }if(discordID == -1){
                console.log('Big Error: ' + discordID);
                response.status(400).send({result: 'Big Error'})
            } else if (steamID == -1){
                response.status(202).send({result: 'No Steam ID'})
                let command = `INSERT OR REPLACE INTO users 
                    (discord_id, steam_id, rating) VALUES (${discordID}, NULL, 0)`;
                console.log(command)
                db.exec(command)
            } else {
                response.status(201).send({result: 'All good!'})
                let command = `INSERT OR REPLACE INTO users 
                    (discord_id, steam_id, rating) VALUES (${discordID}, ${steamID}, 0)`;
                console.log(command)
                db.exec(command)
            }
        });
    });
});

server.listen(config.port, config.IPAddress, () => console.log(`Server listening at http://localhost:80`));