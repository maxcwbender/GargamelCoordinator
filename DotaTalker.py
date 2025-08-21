from dota2.client import Dota2Client
from dota2.protobufs.dota_shared_enums_pb2 import (
    DOTA_GC_TEAM_BAD_GUYS,
    DOTA_GC_TEAM_GOOD_GUYS,
)
from dota2.proto_enums import GCConnectionStatus

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

from typing import Any, Dict
from google.protobuf.json_format import MessageToDict

from enum import IntEnum

import time

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

class DOTA_GameMode(IntEnum):
    DOTA_GAMEMODE_NONE = 0
    DOTA_GAMEMODE_AP = 1
    DOTA_GAMEMODE_CM = 2
    DOTA_GAMEMODE_RD = 3
    DOTA_GAMEMODE_SD = 4
    DOTA_GAMEMODE_AR = 5
    # DOTA_GAMEMODE_INTRO = 6
    # DOTA_GAMEMODE_HW = 7
    DOTA_GAMEMODE_REVERSE_CM = 8
    # DOTA_GAMEMODE_XMAS = 9
    # DOTA_GAMEMODE_TUTORIAL = 10
    DOTA_GAMEMODE_MO = 11
    DOTA_GAMEMODE_LP = 12
    # DOTA_GAMEMODE_POOL1 = 13
    # DOTA_GAMEMODE_FH = 14
    # DOTA_GAMEMODE_CUSTOM = 15
    DOTA_GAMEMODE_CD = 16
    # DOTA_GAMEMODE_BD = 17
    DOTA_GAMEMODE_ABILITY_DRAFT = 18
    # DOTA_GAMEMODE_EVENT = 19
    DOTA_GAMEMODE_ARDM = 20
    # DOTA_GAMEMODE_1V1MID = 21
    DOTA_GAMEMODE_ALL_DRAFT = 22 # Ranked All Pick
    DOTA_GAMEMODE_TURBO = 23
    # DOTA_GAMEMODE_MUTATION = 24
    # DOTA_GAMEMODE_COACHES_CHALLENGE = 25


class DotaTalker:
    def __init__(self, discordBot: 'Master_Bot.Master_Bot', loop: asyncio.AbstractEventLoop):
        """
        Initializes the DotaTalker instance and starts client threads.

        Args:
            discordBot (Master_Bot.Master_Bot): The Discord bot instance to communicate with.
        """
        self.discordBot: 'Master_Bot.Master_Bot' = discordBot
        self.loop = loop
        with open("config.json") as configFile:
            self.config: dict = json.load(configFile)

        self.threads: list[Thread] = []
        self.dotaClients: list[Dota2Client] = [None] * self.config["numClients"]
        self.client_ready: dict[int, bool] = {}
        self.gameBacklog: list[list[int]] = []
        self.pending_matches = []
        self.mode_map = {
            "All Pick" : 1,
            "Ranked All Pick" : 22, # Ranked All Pick
            "Captains Mode" : 2,
            "Random Draft" : 3,
            "Single Draft" : 4,
            "All Random" : 5,
            "Reverse Captains Mode" : 8,
            "Mid Only" : 11,
            "Least Played" : 12,
            "Captains Draft" : 16,
            "Ability Draft" : 18,
            "All Random Deathmatch" : 20,
            "Turbo" : 23
        }

        self.ALLOWED_LOBBY_KEYS = {
            # core
            "game_name",
            "server_region",
            "game_mode",
            "visibility",          # public/friends/passworded
            "pass_key",            # lobby password
            # captains/series/tv
            "cm_pick",
            "series_type",
            "dota_tv_delay",
            # toggles
            "allow_cheats",
            "fill_with_bots",
            "intro_mode",
            "start_game_setup",
            "pause_setting",
            # optional/extras (include only if you use them)
            "league_id",
            "leagueid",
            "bot_difficulty",
            "allow_spectating",
            "allchat",             # sometimes exposed as a toggle
        }

        # self._gc_last_msg = time.monotonic()
        self._gc_watchdogs: dict[int, asyncio.Future] = {}  # game_id -> Future/Task

        for i in range(self.config["numClients"]):
            t = Thread(target=self.setupClient, args=(i,), daemon=True)
            t.start()
            self.threads.append(t)

        logger.info("DotaTalker setup done")

    # def _touch_gc(self):
    #     self._gc_last_msg = time.monotonic()
    def _current_practice_lobby_exists(self, client) -> bool:
        """
        Returns True if our current lobby_id is present in GC's practice lobby list.
        Uses the lobby password (unique per game for you) to narrow the search.
        """
        try:
            my_lobby = getattr(client, "lobby", None)
            my_lobby_id = getattr(my_lobby, "lobby_id", None)
            if not my_lobby_id:
                return False

            pw = getattr(client, "password", "") or ""
            entries = client.get_practice_lobby_list(password=pw)  # <- correct API
            if not entries:
                return False

            return any(getattr(e, "lobby_id", None) == my_lobby_id for e in entries)
        except Exception:
            return False

    def _start_gc_watchdog(self, client, game_id: int):
        """
        Watchdog that keeps long games alive by nudging/re-handshaking the GC if it goes quiet.
        Uses client.get_practice_lobby_list(...) to "refresh" instead of any request_* APIs.
        Exports client._gc_touch() so your GC event handlers can bump liveness.

        Start this when the lobby transitions to RUN. Stop it on POSTGAME or any manual clear.
        """
        import time, asyncio, logging
        soft = 120  # 2 min of silence -> light nudge (refresh lobby list)
        hard = 300  # 5 min of silence -> relaunch GC + refresh
        tick = 15  # watchdog tick cadence
        max_game = 3 * 3600  # 3h absolute cutoff to avoid zombies (tune as needed)
        max_no_lobby = 6  # ~90s (6 * 15s) of "can't find our lobby" before synth end

        logger = logging.getLogger(__name__)

        # Cancel any prior watchdog for this game_id
        old = self._gc_watchdogs.pop(game_id, None)
        if old and not old.done():
            old.cancel()

        last_seen = time.monotonic()
        no_lobby_streak = 0

        def _touch():
            nonlocal last_seen, no_lobby_streak
            last_seen = time.monotonic()
            no_lobby_streak = 0

        # Export the toucher so handlers like lobby_changed can call it:
        client._gc_touch = _touch

        def _lobby_still_exists() -> bool:
            """
            Returns True if our current practice lobby is visible in GC's list.
            Uses the lobby password (unique per game for you) to narrow the search.
            """
            try:
                my = getattr(client, "lobby", None)
                my_id = getattr(my, "lobby_id", None)
            except Exception:
                my_id = None

            pw = getattr(client, "password", "") or ""
            try:
                entries = client.get_practice_lobby_list(password=pw) or []
            except Exception as e:
                logger.error(f"[Game {game_id}] Error requesting lobby list: {e}")
                return False

            if not my_id:
                # If we don't have a lobby_id locally, treat as missing.
                return False

            for entry in entries:
                # Be tolerant of structure differences
                lid = getattr(entry, "lobby_id", None)
                if lid is None:
                    lid = getattr(entry, "id", None)
                if lid == my_id:
                    return True
            return False

        async def _watch():
            try:
                started_at = self._game_started_at.get(game_id, time.monotonic())
                while client.gameID == game_id:
                    await asyncio.sleep(tick)
                    idle = time.monotonic() - last_seen

                    # 1) Hard cutoff on max game duration to avoid zombies
                    if (time.monotonic() - started_at) >= max_game:
                        logger.warning(f"[Game {game_id}] Max runtime reached; synthesizing POSTGAME")
                        await self._synthesize_game_end(client, game_id)
                        return

                    # 2) Quiet GC handling
                    if idle >= hard:
                        logger.warning(f"[Game {game_id}] GC silent {int(idle)}s — relaunching GC")
                        try:
                            client.launch()  # non-destructive GC re-handshake
                        except Exception:
                            logger.exception("[GC] relaunch failed")

                        exists = _lobby_still_exists()
                        if not exists:
                            no_lobby_streak += 1
                            logger.info(f"[Game {game_id}] no_lobby_streak={no_lobby_streak}")
                            if no_lobby_streak >= max_no_lobby:
                                logger.warning(f"[Game {game_id}] Lobby absent repeatedly; synthesizing POSTGAME")
                                await self._synthesize_game_end(client, game_id)
                                return
                        else:
                            no_lobby_streak = 0

                        _touch()  # reset timer after hard action
                    elif idle >= soft:
                        exists = _lobby_still_exists()
                        if not exists:
                            no_lobby_streak += 1
                            logger.info(f"[Game {game_id}] no_lobby_streak={no_lobby_streak}")
                            if no_lobby_streak >= max_no_lobby:
                                logger.warning(f"[Game {game_id}] Lobby absent repeatedly; synthesizing POSTGAME")
                                await self._synthesize_game_end(client, game_id)
                                return
                        else:
                            no_lobby_streak = 0
            except asyncio.CancelledError:
                return

        fut = asyncio.run_coroutine_threadsafe(_watch(), self.loop)
        self._gc_watchdogs[game_id] = fut

    def _stop_gc_watchdog(self, client, game_id: int):
        fut = self._gc_watchdogs.pop(game_id, None)
        if fut and not fut.done():
            try:
                fut.cancel()
            except:
                pass
        # Remove the exported toucher hook if present
        if hasattr(client, "_gc_touch"):
            try:
                delattr(client, "_gc_touch")
            except:
                pass

    def _safe_lobby_snapshot(self, client) -> Dict[str, Any]:
        """
        Take the current lobby proto, convert to dict, then filter out fields that
        config_practice_lobby doesn't accept (like 'state', team rosters, ids, etc.).
        """
        lob = getattr(client, "lobby", None)
        if lob is None:
            raise RuntimeError("Not currently in a lobby")

        snap = MessageToDict(
            lob,
            preserving_proto_field_name=True,
            including_default_value_fields=True,
            use_integers_for_enums=True,
        )

        # Keep only keys we know config_practice_lobby will accept:
        filtered = {k: v for k, v in snap.items() if k in self.ALLOWED_LOBBY_KEYS}

        # Optional: coerce some values to int/bool if they came back as strings
        for key in ("server_region", "game_mode", "cm_pick", "series_type",
                    "dota_tv_delay", "start_game_setup", "pause_setting", "visibility",
                    "league_id", "bot_difficulty"):
            if key in filtered:
                try:
                    filtered[key] = int(filtered[key])
                except Exception:
                    pass
        for key in ("allow_cheats", "fill_with_bots", "intro_mode",
                    "allow_spectating", "allchat"):
            if key in filtered:
                filtered[key] = bool(filtered[key])

        return filtered

    def is_ready(self, i: int) -> bool:
        """
        Checks if the client at index i is ready.

        Args:
            i (int): Index of the client.

        Returns:
            bool: True if the client is ready, False otherwise.
        """
        return self.client_ready.get(i, False)

    def set_ready(self, i: int, value: bool):
        """
        Sets the readiness of the client at index i.

        Args:
            i (int): Index of the client.
            value (bool): Readiness value to set.
        """
        self.client_ready[i] = value

    def make_game(self, gameID: int, radiant_discord_ids: list[int], dire_discord_ids: list[int]) -> str:
        """
        Attempts to create a game using available Dota2 clients.

        Args:
            gameID (int): The game ID to assign.
            radiant_discord_ids (list[int]): Discord IDs for Radiant team.
            dire_discord_ids (list[int]): Discord IDs for Dire team.

        Returns:
            str: Password of the created lobby or "-1" if no client is available.
        """

        radiant_steam_ids = [DB.fetch_steam_id(did) for did in radiant_discord_ids]
        dire_steam_ids = [DB.fetch_steam_id(did) for did in dire_discord_ids]


        for i in range(self.config["numClients"]):
            client = self.dotaClients[i]
            if client.gameID is None and self.is_ready(i):
                self.set_ready(i, False)
                password = str(random.randint(1000, 9999))
                self.make_lobby(i, gameID, radiant_steam_ids, dire_steam_ids, password)
                return password
        return "-1"

    def make_lobby(self, clientIdx: int, gameID: int, radiant: list[int], dire: list[int], password: str):
        """
        Creates a new Dota 2 lobby using the specified client.

        Args:
            clientIdx (int): Index of the client.
            gameID (int): Game ID.
            radiant (list[int]): List of Radiant team Steam IDs.
            dire (list[int]): List of Dire team Steam IDs.
            password (str): Lobby password.
        """
        logger.info(f"[Client {clientIdx}] Looking for game")
        dotaClient = self.dotaClients[clientIdx]
        dotaClient.gameID = gameID
        dotaClient.radiant = radiant
        dotaClient.dire = dire
        dotaClient.password = password

        lobbyConfig = {
            "game_name": f"Gargamel League Game {gameID}",
            "server_region": 2,
            "game_mode": 22,
            "allow_cheats": self.config["DEBUG_MODE"],
            "allow_spectating": True,
            "leagueid": self.config["league_id"],
        }

        dotaClient.create_practice_lobby(password=password, options=lobbyConfig)
        logger.info(f"[Client {clientIdx}] Created lobby for game {gameID} with password {dotaClient.password}")

    def get_password(self, game_id: str) -> str:
        for i in range(self.config["numClients"]):
            client = self.dotaClients[i]
            if client.gameID == game_id:
                return client.password
            
        return "-1"
    
    def swap_players_in_game(self, game_id: int, discord_id_1: int, discord_id_2: int) -> bool:
        """
        Swaps two players between teams in the lobby for the given game ID.

        Args:
            game_id (int): ID of the game.
            discord_id_1 (int): Discord ID of the first player.
            discord_id_2 (int): Discord ID of the second player.

        Returns:
            bool: True if successful, False if the swap couldn't be performed.
        """

        steam_id_1 = DB.fetch_steam_id(discord_id_1)
        steam_id_2 = DB.fetch_steam_id(discord_id_2)

        for client in self.dotaClients:
            if client and client.gameID == game_id:
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
                    logger.error(f"[Game {game_id}] One or both users not found on opposing teams")
                    return False
        logger.error(f"No lobby found with game ID {game_id}")
        return False

    async def change_lobby_mode(self, game_id, game_mode):
        try:
            for client in self.dotaClients:
                if client and client.gameID == game_id and client.lobby:
                    opts = self._safe_lobby_snapshot(client)
                    opts["game_mode"] = game_mode
                    await client.config_practice_lobby(opts)
        except Exception as e:
            print(f"Failed to apply mode {game_mode}: {e}")

    def update_lobby_teams(self, gameID: int, radiant: list[int], dire: list[int]) -> bool:
        """
        Updates the Radiant and Dire teams in an existing lobby.

        Args:
            gameID (int): Game ID to match with a lobby.
            radiant (list[int]): Updated Radiant team Steam IDs.
            dire (list[int]): Updated Dire team Steam IDs.

        Returns:
            bool: True if updated successfully, False if no matching lobby found.
        """
        for client in self.dotaClients:
            if client and client.gameID == gameID and client.lobby:
                client.radiant = radiant
                client.dire = dire
                logger.info(f"[Game {gameID}] Lobby teams updated")
                return True
        return False

    def setupClient(self, i: int):
        """
        Initializes and connects a Steam/Dota2 client.

        Args:
            i (int): Index of the client.
        """
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
            logger.info(f"[Client {i}] Logged on to Steam")
            dotaClient.launch()

        @steamClient.on("friendlist")
        def _(message):
            logger.info("Friendlist message: " + str(message))
            for steam_id, relationship in steamClient.friends.items():
                if relationship == EFriendRelationship.RequestRecipient:
                    logger.info(f"Received friend request from: {steam_id}")
                    steamClient.friends.add(steam_id)

                    if dotaClient.gameID and steam_id in (dotaClient.radiant + dotaClient.dire):
                        dotaClient.invite_to_lobby(steam_id)

        @steamClient.on("disconnected")
        def _disconnected():
            logger.warning(f"[Client {i}] Steam disconnected; attempting reconnect…")

        @steamClient.on("reconnect")
        def _reconnect(delay):
            logger.warning(f"[Client {i}] Steam scheduling reconnect in {delay}s")

        @steamClient.on("connected")
        def _connected():
            logger.info(f"[Client {i}] Steam TCP connected")

        @dotaClient.on("connection_status")
        def _on_gc_conn_status(status):
            if status == GCConnectionStatus.HAVE_SESSION:
                logger.info(f"[Client {i}] Connection status HAVE_SESSION detected: {status}")
                if hasattr(dotaClient, "_gc_touch") and callable(dotaClient._gc_touch):
                    dotaClient._gc_touch()
            else:
                logger.error(f"[Client {i}] Connection status HAVE_SESION not detected: {status}")
            # status is an int enum from GC; log it verbosely
            logger.warning(f"[GC] connection_status={status}")

        @dotaClient.on("ready")
        def _():
            # Count this as GC activity for the watchdog (if exported)
            if hasattr(dotaClient, "_gc_touch") and callable(dotaClient._gc_touch):
                dotaClient._gc_touch()

            logger.info(f"[Client {i}] Dota 2 client ready")
            if dotaClient.gameID is None:
                try:
                    dotaClient.abandon_current_game()
                    dotaClient.leave_practice_lobby()
                except Exception:
                    pass
            else:
                logger.info(f"[Client {i}] Game Coordinator ready during active game {dotaClient.gameID}, preserving state")
                # Instead, re-request snapshot to re-sync
                try:
                    dotaClient.request_lobby_info()
                except Exception:
                    pass

            self.set_ready(i, True)

        @dotaClient.on("notready")
        def _gc_notready():
            # GC session lost (this happens on CM rotation); relaunch it
            logger.warning(f"[Client {i}] Dota Game Coordinator not ready; relaunching GC")
            try:
                dotaClient.launch()
            except Exception:
                logger.exception(f"[Client {i}] Failed to relaunch GC")

        @dotaClient.on("lobby_new")
        def _(lobby):
            # Touch watchdog (proof GC is talking)
            if hasattr(dotaClient, "_gc_touch") and callable(dotaClient._gc_touch):
                dotaClient._gc_touch()

            if dotaClient.gameID is None:
                return

            for sid in dotaClient.radiant + dotaClient.dire:
                if sid not in dotaClient.steam.friends:
                    dotaClient.steam.friends.add(sid)
                dotaClient.invite_to_lobby(sid)
                dotaClient.steam.get_user(sid).send_message(
                    f"Just invited you to a lobby! The lobby name is 'Gargamel League Game {dotaClient.gameID}' and the password is {dotaClient.password}"
                )
                logger.info(f"[Game {dotaClient.gameID}] Inviting {dotaClient.steam.get_user(sid).name}")

        # Allegedly we cannot access member.name until this event triggers
        # TODO here, I just want to see how long it takes to get them
        @dotaClient.steam.on("persona_state")
        def handle_persona_update(persona):
            logger.info(f"Persona update: {persona.name} (SteamID: {persona.steam_id})")

        @dotaClient.on("lobby_changed")
        def _(message):
            logger.info(f"[Client {i}] Lobby changed")

            # Touch watchdog (every GC diff proves life)
            if hasattr(dotaClient, "_gc_touch") and callable(dotaClient._gc_touch):
                dotaClient._gc_touch()

            for member in message.all_members:
                try:
                    dotaClient.steam.request_persona_state([member.id])
                except Exception as e:
                    logger.exception(f"Error requesting user persona for member:id: {member.id}, err: {e}")

                logger.info(f"Member.id: {member.id}, Member.team: {member.team}, Member.name: {member.name}, Member.slot: {member.slot}, Member.channel: {member.channel}")
                if member.id not in dotaClient.steam.friends:
                    dotaClient.steam.friends.add(member.id)

            if message.state == LobbyState.RUN:
                # Only add the coroutine if the match is pending start
                if dotaClient.gameID in self.discordBot.pending_matches:
                    logger.info(f"Lobby with gameId {dotaClient.gameID} found in running state that is pending creation.  Sending to Master Bot for DB Add.")
                    asyncio.run_coroutine_threadsafe(
                        self.discordBot.on_game_started(dotaClient.gameID, message),
                        self.loop
                    )
                else:
                    print(f"Found lobby not in pending matches with gameID: {dotaClient.gameID}")

                # Start the GC watchdog now that the game is live
                try:
                    self._start_gc_watchdog(dotaClient, dotaClient.gameID)
                except Exception:
                    logger.exception("Failed to start GC watchdog")

            if message.state == LobbyState.UI:
                correct = 0
                for member in message.all_members:
                    sid32 = SteamID(member.id).as_32
                    if member.id in dotaClient.radiant and member.team != DOTA_GC_TEAM_GOOD_GUYS:
                        dotaClient.practice_lobby_kick_from_team(sid32)
                        logger.info(f"[Client {i}] {member.name}: wrong team (should be Radiant)")
                    elif member.id in dotaClient.dire and member.team != DOTA_GC_TEAM_BAD_GUYS:
                        dotaClient.practice_lobby_kick_from_team(sid32)
                        logger.info(f"[Client {i}] {member.name}: wrong team (should be Dire)")
                    elif (member.id in dotaClient.radiant and member.team == DOTA_GC_TEAM_GOOD_GUYS) or \
                         (member.id in dotaClient.dire and member.team == DOTA_GC_TEAM_BAD_GUYS):
                        correct += 1
                    elif member.team in [DOTA_GC_TEAM_GOOD_GUYS, DOTA_GC_TEAM_BAD_GUYS]:
                        dotaClient.practice_lobby_kick_from_team(sid32)
                        logger.info(f"[Client {i}] {member.name} not part of current game")
                    logger.info(f"User found on team: {member.team} (SteamID: {member.id} Member.name: {member.name})")

                if correct == len(dotaClient.radiant + dotaClient.dire):
                    dotaClient.launch_practice_lobby()
                    logger.info(f"[Client {i}] Game launched")

            elif message.state == LobbyState.POSTGAME or getattr(message, 'game_state', None) == GameState.POST_GAME:
                match_id = getattr(message, 'match_id', None)
                match_outcome = getattr(message, 'match_outcome', MatchOutcome.UNKNOWN)

                logger.info(f"[Client {i}] Game ended, match ID: {message.match_id}")
                logger.info(f"Match ID: {match_id}, Outcome: {match_outcome}")

                # Stop watchdog for this game
                try:
                    self._stop_gc_watchdog(dotaClient.gameID)
                except Exception as e:
                    logger.exception(f"Failed to stop GC watchdog for gameID: {dotaClient.gameID} with exception: {e}")

                try:
                    dotaClient.leave_practice_lobby()
                except Exception as e:
                    logger.exception(f"Error leaving practice lobby: {e}")

                asyncio.run_coroutine_threadsafe(
                    self.discordBot.on_game_ended(dotaClient.gameID, message),
                    self.loop
                )

                logger.info(f"Past coroutine run")

                # Reset Client State
                dotaClient.gameID = None
                dotaClient.radiant = None
                dotaClient.dire = None
                dotaClient.password = None

                self.set_ready(i, True)

            else:
                logger.info(f"Message State was: {message.state} ")

        steamClient.login(
            username=self.config.get(f"username_{i}"),
            password=self.config.get(f"password_{i}"),
        )
        steamClient.run_forever()
