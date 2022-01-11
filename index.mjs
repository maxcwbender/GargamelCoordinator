import fetch from 'node-fetch';
import sqlite3 from 'sqlite3';
import express from 'express';
import net from 'net';
import { readFileSync } from 'fs';

let config = JSON.parse(readFileSync('./config.json'))

const server = express();
server.use(express.json());

const socketTest = new net.Socket();
socketTest.connect(config.pipePort, '127.0.0.1', function() {
    console.log('Connected');
});
socketTest.destroy()

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
            } if(discordID == -1){
                console.log('Big Error: ' + discordID);
                response.status(400).send({result: 'Big Error'});
            } else if (steamID == -1){
                response.status(202).send({result: 'No Steam ID'});
            } else {
                response.status(201).send({result: 'All good!'});
                let command = `INSERT INTO users 
                    (discord_id, steam_id, dateCreated, modsRemaining, timesVouched) 
                    VALUES (${discordID}, ${steamID}, datetime('now'), ${config.MOD_ASSIGNMENT}, 0)`;
                console.log(command);
                let socketPipe = new net.Socket();
                socketPipe.connect(config.pipePort, '127.0.0.1', function() {
                    socketPipe.write(`${discordID}`);
                    socketPipe.end()
                }); 
                try {
                    db.exec(command);
                } catch (error) {
                    console.log(error)
                }
                fetch(`https://discord.com/api/guilds/${config.GUILD_ID}/members/${discordID}`, {
                    method: 'PUT',
                    body: JSON.stringify({"access_token": `${accessToken}`}),
                    headers: {
                        "access_token": `${accessToken}`, 
                        "Authorization": `Bot ${config.BOT_TOKEN}`, 
                        "Content-Type": 'application/json'
                    }
                });
            }
        });
    });
});

server.listen(80, () => console.log(`Server listening at http://localhost:80`));