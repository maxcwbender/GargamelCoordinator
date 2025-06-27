from dota2.client import Dota2Client
from dota2.protobufs.dota_shared_enums_pb2 import (
    DOTA_GC_TEAM_BAD_GUYS,
    DOTA_GC_TEAM_GOOD_GUYS,
)

from steam.client import SteamClient
from steam.steamid import SteamID
from steam.enums import EFriendRelationship

import json
from threading import Thread
import random
import sqlite3
import Master_Bot


class DotATalker:
    def __init__(self, discordBot: Master_Bot.Master_Bot):
        self.discordBot = discordBot
        with open("config.json") as configFile:
            self.config: dict = json.load(configFile)

        self.threads: list[Thread] = []
        self.dotaClients: list[Dota2Client] = [None] * self.config["numClients"]
        self.client_ready: dict[int, bool] = {}
        self.gameBacklog: list[list[int]] = []

        for i in range(self.config["numClients"]):
            t = Thread(target=self.setupClient, args=(i,), daemon=True)
            t.start()
            self.threads.append(t)

        print("DotATalker setup done")

    def is_ready(self, i: int) -> bool:
        return self.client_ready.get(i, False)

    def set_ready(self, i: int, value: bool):
        self.client_ready[i] = value

    def make_game(self, gameID: int, radiant_discord_ids: list[int], dire_discord_ids: list[int]) -> str:
        conn = sqlite3.connect("allUsers.db")
        cur = conn.cursor()

        def fetch_steam_id(discord_id):
            result = cur.execute(
                "SELECT steam_id FROM users WHERE discord_id = ?",
                (discord_id,)
            ).fetchone()
            return result[0] if result else None

        radiant_steam_ids = [fetch_steam_id(did) for did in radiant_discord_ids]
        dire_steam_ids = [fetch_steam_id(did) for did in dire_discord_ids]
        cur.close()

        for i in range(self.config["numClients"]):
            client = self.dotaClients[i]
            if client.gameID is None and self.is_ready(i):
                self.set_ready(i, False)
                password = str(random.randint(1000, 9999))
                self.make_lobby(i, gameID, radiant_steam_ids, dire_steam_ids, password)
                return password
        return "-1"

    def make_lobby(self, clientIdx: int, gameID: int, radiant: list[int], dire: list[int], password: str):
        print(f"[Client {clientIdx}] Looking for game")
        dotaClient = self.dotaClients[clientIdx]
        dotaClient.gameID = gameID
        dotaClient.radiant = radiant
        dotaClient.dire = dire
        dotaClient.password = password

        lobbyConfig = {
            "game_name": f"Gargamel League Game {gameID}",
            "server_region": 2,
            "game_mode": 22,
            "allow_cheats": False,
            "allow_spectating": True,
            "leagueid": self.config["league_id"],
        }

        dotaClient.create_practice_lobby(password=password, options=lobbyConfig)
        print(f"[Client {clientIdx}] Created lobby for game {gameID} with password {dotaClient.password}")

    def setupClient(self, i: int):
        steamClient = SteamClient()
        dotaClient = Dota2Client(steamClient)
        dotaClient.gameID = None
        dotaClient.radiant = None
        dotaClient.dire = None
        dotaClient.password = None
        self.dotaClients[i] = dotaClient
        self.set_ready(i, False)

        @steamClient.on("logged_on")
        def _():
            print(f"[Client {i}] Logged on to Steam")
            dotaClient.launch()

            current_friends = set(str(friend.steam_id) for friend in steamClient.friends)

            conn = sqlite3.connect("allUsers.db")
            cursor = conn.cursor()
            cursor.execute("SELECT steam_id FROM users")
            steam_ids = {str(row[0]) for row in cursor.fetchall()}
            conn.close()

            for sid in steam_ids:
                if sid not in current_friends:
                    steamClient.friends.add(SteamID(sid))
                    print(f"[Client {i}] Sent friend request to {sid}")

        @steamClient.on("friendlist")
        def _(message):
            print("Friendlist message: " + str(message))
            for steam_id, relationship in steamClient.friends.items():
                if relationship == EFriendRelationship.RequestRecipient:
                    print(f"Received friend request from: {steam_id}")
                    steamClient.friends.add(steam_id)

                    if dotaClient.gameID and steam_id in (dotaClient.radiant + dotaClient.dire):
                        dotaClient.invite_to_lobby(steam_id)

        @dotaClient.on("ready")
        def _():
            print(f"[Client {i}] Dota 2 client ready")
            dotaClient.abandon_current_game()
            dotaClient.leave_practice_lobby()
            self.set_ready(i, True)

        @dotaClient.on("lobby_new")
        def _(lobby):
            if dotaClient.gameID is None:
                return

            for sid in dotaClient.radiant + dotaClient.dire:
                if sid not in dotaClient.steam.friends:
                    dotaClient.steam.friends.add(sid)
                dotaClient.invite_to_lobby(sid)
                dotaClient.steam.get_user(sid).send_message(
                    f"Just invited you to a lobby! The lobby name is 'Gargamel League Game {dotaClient.gameID}' and the password is {dotaClient.password}"
                )
                print(f"[Game {dotaClient.gameID}] Inviting {dotaClient.steam.get_user(sid).name}")

        @dotaClient.on("lobby_changed")
        def _(message):
            print(f"[Client {i}] Lobby changed")

            for member in message.all_members:
                print(member.id, member.team, member.name, member.slot, member.channel)
                if member.id not in dotaClient.steam.friends:
                    dotaClient.steam.friends.add(member.id)

            if message.state == 0:
                correct = 0
                for member in message.all_members:
                    sid32 = SteamID(member.id).as_32
                    if member.id in dotaClient.radiant and member.team != DOTA_GC_TEAM_GOOD_GUYS:
                        dotaClient.practice_lobby_kick_from_team(sid32)
                        print(f"[Client {i}] {member.name}: wrong team (should be Radiant)")
                    elif member.id in dotaClient.dire and member.team != DOTA_GC_TEAM_BAD_GUYS:
                        dotaClient.practice_lobby_kick_from_team(sid32)
                        print(f"[Client {i}] {member.name}: wrong team (should be Dire)")
                    elif (member.id in dotaClient.radiant and member.team == DOTA_GC_TEAM_GOOD_GUYS) or \
                         (member.id in dotaClient.dire and member.team == DOTA_GC_TEAM_BAD_GUYS):
                        correct += 1
                    elif member.team in [DOTA_GC_TEAM_GOOD_GUYS, DOTA_GC_TEAM_BAD_GUYS]:
                        dotaClient.practice_lobby_kick_from_team(sid32)
                        print(f"[Client {i}] {member.name} not part of current game")

                if correct == len(dotaClient.radiant + dotaClient.dire):
                    dotaClient.launch_practice_lobby()
                    print(f"[Client {i}] Game launched")

            elif message.state == 3:
                print(f"[Client {i}] Game ended, match ID: {message.match_id}")
                dotaClient.leave_practice_lobby()
                self.discordBot.dispatch("game_ended", dotaClient.gameID, message.match_outcome)
                dotaClient.gameID = None
                dotaClient.radiant = None
                dotaClient.dire = None
                dotaClient.password = None
                self.set_ready(i, True)

        steamClient.login(
            username=self.config.get(f"username_{i}"),
            password=self.config.get(f"password_{i}"),
        )
        steamClient.run_forever()
