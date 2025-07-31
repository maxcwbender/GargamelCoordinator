from dota2.client import Dota2Client
from dota2.protobufs.dota_shared_enums_pb2 import (
    DOTA_GC_TEAM_BAD_GUYS,
    DOTA_GC_TEAM_GOOD_GUYS,
)

DOTA_GAME_MODES = {
    "Ranked All Pick": 22,
    "Captains Mode": 2,
    "Turbo": 23,
    "Single Draft": 4,
    "All Random": 3,  # 🎰
}

from steam.client import SteamClient
from steam.steamid import SteamID
from steam.enums import EFriendRelationship

import json
from threading import Thread
import random

from Master_Bot import Master_Bot
import DBFunctions as DB
import logging

logger = logging.getLogger(__name__)
import asyncio


from enum import IntEnum


class LobbyState(IntEnum):
    UI = 0
    SERVERSETUP = 1
    RUN = 2
    POSTGAME = 3


class GameState(IntEnum):
    INIT = 0
    STARTING = 1
    HERO_SELECTION = 2
    STRATEGY_TIME = 3
    PRE_GAME = 4
    IN_PROGRESS = 5
    POST_GAME = 6


class MatchOutcome(IntEnum):
    UNKNOWN = 0
    RADIANT_WIN = 2
    DIRE_WIN = 3


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

        self.active_clients: dict[int, Dota2Client] = {}
        self.client_creation_lock = threading.Lock()

        logger.info("DotaTalker setup done")

    def make_game(
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

            steamClient = SteamClient()
            dotaClient = Dota2Client(steamClient)

            t = Thread(
                target=self.create_and_launch_client,
                args=(
                    game_id,
                    radiant_steam_ids,
                    dire_steam_ids,
                    password,
                    dotaClient,
                    client_idx,
                ),
                daemon=True,
            )
            t.start()

        return password

    def create_and_launch_client(
        self,
        game_id: int,
        radiant: list[int],
        dire: list[int],
        password: str,
        dotaClient: Dota2Client,
        client_idx: int,
    ):
        steamClient = dotaClient.steam
        self.active_clients[game_id] = dotaClient

        dotaClient.game_id = game_id
        dotaClient.radiant = radiant
        dotaClient.dire = dire
        dotaClient.password = password

        @steamClient.on("logged_on")
        def _():
            logger.info(f"[Game {game_id}] Logged into Steam.")
            dotaClient.launch()

        @dotaClient.on("ready")
        def _():
            logger.info(f"[Game {game_id}] Dota 2 client ready.")
            lobby_config = {
                "game_name": f"Gargamel League Game {game_id}",
                "server_region": 2,
                "game_mode": 22,
                "allow_cheats": self.config["DEBUG_MODE"],
                "allow_spectating": True,
                "leagueid": self.config["league_id"],
            }
            dotaClient.create_practice_lobby(password=password, options=lobby_config)
            logger.info(f"[Game {game_id}] Lobby created with password {password}")

        @steamClient.on("friendlist")
        def _(message):
            logger.info("Friendlist message: " + str(message))
            for steam_id, relationship in steamClient.friends.items():
                if relationship == EFriendRelationship.RequestRecipient:
                    logger.info(f"Received friend request from: {steam_id}")
                    steamClient.friends.add(steam_id)

                    if dotaClient.game_id and steam_id in (
                        dotaClient.radiant + dotaClient.dire
                    ):
                        dotaClient.invite_to_lobby(steam_id)

        @dotaClient.on("lobby_new")
        def _(lobby):
            if dotaClient.game_id is None:
                return

            for sid in dotaClient.radiant + dotaClient.dire:
                if sid not in dotaClient.steam.friends:
                    dotaClient.steam.friends.add(sid)
                dotaClient.invite_to_lobby(sid)
                dotaClient.steam.get_user(sid).send_message(
                    f"Just invited you to a lobby! The lobby name is 'Gargamel League Game {dotaClient.game_id}' and the password is {dotaClient.password}"
                )
                logger.info(
                    f"[Game {dotaClient.game_id}] Inviting {dotaClient.steam.get_user(sid).name}"
                )

        @dotaClient.on("update_lobby_mode")
        def _(game_mode: int):
            if not dotaClient.lobby:
                logger.error(
                    f"tried to update lobby of game {dotaClient.game_id} to mode {game_mode}, but associated client seemingly not in a lobby"
                )
            dotaClient.config_practice_lobby({"game_mode": game_mode})

        @dotaClient.on("shut_down_command")
        def _():
            self.active_clients.pop(game_id, None)
            try:
                dotaClient.leave_practice_lobby()
            except Exception:
                pass
            try:
                dotaClient.abandon_current_game()
            except Exception:
                pass
            try:
                dotaClient.steam.logout()
            except Exception:
                pass

        # Allegedly we cannot access member.name until this event triggers
        # TODO here, I just want to see how long it takes to get them
        @dotaClient.steam.on("persona_state")
        def handle_persona_update(persona):
            logger.info(f"Persona update: {persona.name} (SteamID: {persona.steam_id})")

        @dotaClient.on("lobby_changed")
        def _(message):
            logger.info(f"[Client for game {game_id}] Lobby changed, momentary sleep")
            dotaClient.sleep(1)

            for member in message.all_members:
                try:
                    dotaClient.steam.request_persona_state([member.id])
                except Exception as e:
                    logger.exception(
                        f"Error requesting user persona for member:id: {member.id}, err: {e}"
                    )

                logger.info(
                    f"Member.id: {member.id}, Member.team: {member.team}, Member.name: {member.name}, Member.slot: {member.slot}, Member.channel: {member.channel}"
                )
                if member.id not in dotaClient.steam.friends:
                    dotaClient.steam.friends.add(member.id)

            if message.state == LobbyState.RUN:
                with self.discordBot.pending_matches_lock:
                    is_pending = dotaClient.game_id in self.discordBot.pending_matches
                    # Only add the coroutine if the match is pending start
                if is_pending:
                    logger.info(
                        f"Lobby with game id {dotaClient.game_id} found in running state that is pending creation.  Sending to Master Bot for DB Add."
                    )
                    asyncio.run_coroutine_threadsafe(
                        self.discordBot.on_game_started(dotaClient.game_id, message),
                        self.loop,
                    )
                else:
                    print(
                        f"Found lobby not in pending matches with game id: {dotaClient.game_id}"
                    )

            if message.state == LobbyState.UI:
                correct = 0
                for member in message.all_members:
                    sid32 = SteamID(member.id).as_32
                    if (
                        member.id in dotaClient.radiant
                        and member.team != DOTA_GC_TEAM_GOOD_GUYS
                    ):
                        dotaClient.practice_lobby_kick_from_team(sid32)
                        logger.info(
                            f"[Client for game {game_id}] {member.name}: wrong team (should be Radiant)"
                        )
                    elif (
                        member.id in dotaClient.dire
                        and member.team != DOTA_GC_TEAM_BAD_GUYS
                    ):
                        dotaClient.practice_lobby_kick_from_team(sid32)
                        logger.info(
                            f"[Client for game {game_id}] {member.name}: wrong team (should be Dire)"
                        )
                    elif (
                        member.id in dotaClient.radiant
                        and member.team == DOTA_GC_TEAM_GOOD_GUYS
                    ) or (
                        member.id in dotaClient.dire
                        and member.team == DOTA_GC_TEAM_BAD_GUYS
                    ):
                        correct += 1
                    elif member.team in [DOTA_GC_TEAM_GOOD_GUYS, DOTA_GC_TEAM_BAD_GUYS]:
                        dotaClient.practice_lobby_kick_from_team(sid32)
                        logger.info(
                            f"[Client for game {game_id}] {member.name} not part of current game"
                        )
                    logger.info(
                        f"User found on team: {member.team} (SteamID: {member.id} Member.name: {member.name})"
                    )

                if correct == len(dotaClient.radiant + dotaClient.dire):
                    dotaClient.launch_practice_lobby()
                    logger.info(f"[Client for game {game_id}] Game launched")

            elif (
                message.state == LobbyState.POSTGAME
                or getattr(message, "game_state", None) == GameState.POST_GAME
            ):
                match_id = getattr(message, "match_id", None)
                match_outcome = getattr(message, "match_outcome", MatchOutcome.UNKNOWN)

                logger.info(
                    f"[Client for game {game_id}] Game ended, match ID: {message.match_id}"
                )
                logger.info(f"Match ID: {match_id}, Outcome: {match_outcome}")

                dotaClient.leave_practice_lobby()

                asyncio.run_coroutine_threadsafe(
                    # self.discordBot.on_game_ended(dotaClient.game_id, message.match_outcome, GameState.POSTGAME), self.loop
                    self.discordBot.on_game_ended(dotaClient.game_id, message),
                    self.loop,
                )

                logger.info(f"Past coroutine run")

            else:
                logger.info(f"Message State was: {message.state} ")

        try:
            steamClient.login(
                username=self.config[f"username_{client_idx}"],
                password=self.config[f"password_{client_idx}"],
            )
            steamClient.run_forever()
        except Exception as e:
            logger.exception(f"[Game {game_id}] Client crash or login failed: {e}")
            self.active_clients.pop(game_id, None)

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
            logger.error(f"Tried to change lobby ")
            return

        client.emit("update_lobby_mode", game_mode)
