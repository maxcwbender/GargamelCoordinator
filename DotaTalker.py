import json
from threading import Thread
import random

from Master_Bot import Master_Bot
import DBFunctions as DB
import logging
import sys
import os

logger = logging.getLogger(__name__)
import asyncio
import threading

class DotaTalker:
    def __init__(
        self, discordBot: "Master_Bot.Master_Bot", loop: asyncio.AbstractEventLoop
    ):
        """
        Initializes the DotaTalker instance and starts client threads.

        Args:
            discordBot (Master_Bot.Master_Bot): The Discord bot instance to communicate with.
        """
        self.discordBot: "Master_Bot.Master_Bot" = discordBot
        self.loop = loop
        with open("config.json") as configFile:
            self.config: dict = json.load(configFile)

        self.client_creation_lock = threading.Lock()

        logger.info("DotaTalker setup done")
        self.passwords: dict[int, str] = {}

    async def make_game(
        self, game_id: int, radiant_discord_ids: list[int], dire_discord_ids: list[int]
    ) -> str:
        """
        Attempts to create a game using available Dota2 clients.

        Args:
            game_id (int): The game ID to assign.
            radiant_discord_ids (list[int]): Discord IDs for Radiant team.
            dire_discord_ids (list[int]): Discord IDs for Dire team.

        Returns:
            str: Password of the created lobby or "-1" if no client is available.
        """

        with self.client_creation_lock:
            client_idx = len(self.active_clients)
            if client_idx >= self.config["numClients"]:
                logger.warning(
                    f"Unable to make game {game_id}: too many clients running"
                )
                return "-1"

            radiant_steam_ids = [DB.fetch_steam_id(id) for id in radiant_discord_ids]
            dire_steam_ids = [DB.fetch_steam_id(id) for id in dire_discord_ids]
            password = str(random.randint(1000, 9999))
            self.passwords[game_id] = password

            await self.launch_dota_subprocess(game_id, client_idx, radiant_steam_ids, dire_steam_ids)
            return password

    async def launch_dota_subprocess(self, game_id, client_idx, radiant_steam_ids, dire_steam_ids):
        payload = json.dumps({
            "game_id": game_id,
            "username": self.config[f"username_{client_idx}"],
            "password": self.config[f"password_{client_idx}"],
            "radiant_ids": str(radiant_steam_ids),
            "dire_ids": str(dire_steam_ids) 
        })

        process = await asyncio.create_subprocess_exec(
            sys.executable, "dota_client_runner.py", payload,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        async def read_output(stream: asyncio.StreamReader, label):
            while True:
                line = await stream.readline()
                if not line:
                    break
                print(f"[{label}] {line.decode().rstrip()}")

        asyncio.create_task(read_output(process.stdout, f"Game {game_id}"))
        asyncio.create_task(read_output(process.stderr, f"Game {game_id} ERR"))

        return process
    
    async def send_command_to_client(self, game_id: int, command: dict) -> dict:
        socket_path = f"/tmp/dotatalker-{game_id}.sock"
        if not os.path.exists(socket_path):
            raise FileNotFoundError(f"Socket {socket_path} does not exist")

        try:
            reader, writer = await asyncio.open_connection(socket_path)
            payload = json.dumps(command).encode()
            writer.write(payload)
            await writer.drain()

            # Read the response
            response_data = await reader.read()  # assumes whole JSON fits in one chunk
            writer.close()
            await writer.wait_closed()

            return json.loads(response_data.decode())
        except Exception as e:
            return {"status": "error", "reason": str(e)}

    def get_password(self, game_id: int) -> str:
        if game_id in self.active_clients:
            return self.active_clients.get(game_id).password
        else:
            return "-1"

    def swap_players_in_game(
        self, game_id: int, discord_id_1: int, discord_id_2: int
    ) -> bool:
        """
        Swaps two players between teams in the lobby for the given game ID.

        Args:
            game_id (int): ID of the game.
            discord_id_1 (int): Discord ID of the first player.
            discord_id_2 (int): Discord ID of the second player.

        Returns:
            bool: True if successful, False if the swap couldn't be performed.
        """
        client = self.active_clients.get(game_id, None)
        if not client:
            logger.error(f"No lobby found with game ID {game_id}")
            return False

        steam_id_1 = DB.fetch_steam_id(discord_id_1)
        steam_id_2 = DB.fetch_steam_id(discord_id_2)

        if steam_id_1 in client.radiant and steam_id_2 in client.dire:
            client.radiant.remove(steam_id_1)
            client.dire.remove(steam_id_2)
            client.radiant.append(steam_id_2)
            client.dire.append(steam_id_1)
            logger.info(f"[Game {game_id}] Swapped {steam_id_1} and {steam_id_2}")
            return True
        elif steam_id_1 in client.dire and steam_id_2 in client.radiant:
            client.radiant.remove(steam_id_2)
            client.dire.remove(steam_id_1)
            client.radiant.append(steam_id_1)
            client.dire.append(steam_id_2)
            logger.info(f"[Game {game_id}] Swapped {steam_id_1} and {steam_id_2}")
            return True
        else:
            logger.error(
                f"[Game {game_id}] One or both users not found on opposing teams"
            )
            return False

    def update_lobby_teams(
        self, game_id: int, radiant: list[int], dire: list[int]
    ) -> bool:
        """
        Updates the Radiant and Dire teams in an existing lobby.

        Args:
            game_id (int): Game ID to match with a lobby.
            radiant (list[int]): Updated Radiant team Steam IDs.
            dire (list[int]): Updated Dire team Steam IDs.

        Returns:
            bool: True if updated successfully, False if no matching lobby found.
        """
        client = self.active_clients.get(game_id, None)
        if not client:
            logger.error(f"No client found with game ID {game_id}")
            return False
        if client.game_id == game_id and client.lobby:
            client.radiant = radiant
            client.dire = dire
            logger.info(f"[Game {game_id}] Lobby teams updated")
            return True
        return False

    def cancel_game(self, game_id: int) -> bool:
        """
        Forcefully cancels any game or lobby associated with game_id.

        Args:
            game_id (int): The game ID of the game to cancel.

        Returns:
            bool: True if action taken, False if no matching client found.
        """
        logger.info(f"Cancel game called on game id {game_id}. Forcing exit.")
        client = self.active_clients.get(game_id, None)
        if not client:
            logger.error(f"No client found with game ID {game_id}")
            return False

        client.emit("shut_down_command")

        logger.info(f"Game {game_id} forcibly canceled.")
        return True

    def change_lobby_mode(self, game_id: int, game_mode: int):
        logger.info(f"Trying to change game mode of {game_id} to {game_mode}")
        client = self.active_clients.get(game_id, None)

        if not client:
            logger.error(f"Tried to change lobby for game id {game_id}, but no client found")
            return

        client.emit("update_lobby_mode", game_mode)
