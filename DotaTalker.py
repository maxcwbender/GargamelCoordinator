# DotaTalker.py
from __future__ import annotations

import gevent.monkey
gevent.monkey.patch_all()

import asyncio
import json
import logging
import random
import threading
from dataclasses import dataclass
from enum import IntEnum
from typing import Any, Dict, Optional

from google.protobuf.json_format import MessageToDict
from steam.client import SteamClient
from steam.enums import EFriendRelationship
from steam.steamid import SteamID
from dota2.client import Dota2Client
from dota2.protobufs.dota_shared_enums_pb2 import (
    DOTA_GC_TEAM_BAD_GUYS,
    DOTA_GC_TEAM_GOOD_GUYS,
)

import DBFunctions as DB
from threading import Thread
from Master_Bot import Master_Bot
from enum import IntEnum

logger = logging.getLogger(__name__)


# ----------------------------- #
#         Game Enums            #
# ----------------------------- #
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
    DOTA_GAMEMODE_REVERSE_CM = 8
    DOTA_GAMEMODE_MO = 11
    DOTA_GAMEMODE_LP = 12
    DOTA_GAMEMODE_CD = 16
    DOTA_GAMEMODE_ABILITY_DRAFT = 18
    DOTA_GAMEMODE_ARDM = 20
    DOTA_GAMEMODE_ALL_DRAFT = 22  # Ranked All Pick
    DOTA_GAMEMODE_TURBO = 23



@dataclass
class ClientAccounts:
    """Allocates one username/password per active lobby."""
    total: int
    in_use: set[int]

    def next_free(self) -> Optional[int]:
        for i in range(self.total):
            if i not in self.in_use:
                self.in_use.add(i)
                return i
        return None

    def release(self, idx: int) -> None:
        self.in_use.discard(idx)


class ClientWrapper:
    """
    Owns exactly one Steam/Dota client (one account) living in its own thread.
    Async entrypoints (`create_lobby`, `shutdown`) never block the asyncio loop.
    """

    def __init__(
        self,
        *,
        game_id: int,
        config: dict,
        loop: asyncio.AbstractEventLoop,
        discord_bot: "Master_Bot.Master_Bot",
        account_index: int,
        logger: Optional[logging.Logger] = None,
    ):
        self.game_id = game_id
        self.config = config
        self.loop = loop
        self.discord_bot = discord_bot
        self.account_index = account_index

        self.logger = logger or logging.getLogger("DotaTalker")

        # Threading primitives
        self._thread: Optional[threading.Thread] = None
        self._stop_evt = threading.Event()
        self._ready_evt = threading.Event()   # set when dota client is 'ready'

        # Steam/Dota objects (only touch on the wrapper thread!)
        self.steam: Optional[SteamClient] = None
        self.dota: Optional[Dota2Client] = None

        # Lobby state
        self.password: Optional[str] = None
        self.radiant: list[int] = []
        self.dire: list[int] = []

    # ---------------- Thread lifecycle ----------------

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._thread_main, name=f"steam-dota-{self.game_id}", daemon=True)
        self._thread.start()

    def shutdown(self):
        self._stop_evt.set()
        if self.dota:
            try:
                self.dota.leave_practice_lobby()
            except Exception:
                pass
        if self.steam:
            try:
                self.steam.logout()
                self.steam.disconnect()
            except Exception:
                pass
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=10.0)

    def swap_players(self, discord_id_1: int, discord_id_2: int) -> bool:
        """Swap two players between radiant/dire lists. Kicks them so they re-seat correctly."""
        s1 = DB.fetch_steam_id(str(discord_id_1))
        s2 = DB.fetch_steam_id(str(discord_id_2))
        if not s1 or not s2:
            self.logger.error(f"[Game {self.game_id}] swap failed: missing steam ids")
            return False

        # must be on opposite teams
        if s1 in self.radiant and s2 in self.dire:
            self.radiant.remove(s1)
            self.dire.remove(s2)
            self.radiant.append(s2)
            self.dire.append(s1)
        elif s2 in self.radiant and s1 in self.dire:
            self.radiant.remove(s2)
            self.dire.remove(s1)
            self.radiant.append(s1)
            self.dire.append(s2)
        else:
            self.logger.error(f"[Game {self.game_id}] swap failed: not on opposite teams")
            return False

        # If a lobby exists, kick both so they can seat on the new sides
        if self.dota and getattr(self.dota, "lobby", None):
            try:
                self.dota.practice_lobby_kick_from_team(SteamID(s1).as_32)
            except Exception:
                self.logger.exception(f"Error kicking player from Team")
            try:
                self.dota.practice_lobby_kick_from_team(SteamID(s2).as_32)
            except Exception:
                self.logger.exception(f"Error kicking player from Team")

        self.logger.info(f"[Game {self.game_id}] swapped {s1} <-> {s2}")
        # self.update_lobby_teams(self.radiant, self.dire)
        return True

    def replace_player(self, old_player_id : int, new_player_id : int) -> bool:
        old_player_sid = DB.fetch_steam_id(str(old_player_id))
        new_player_sid = DB.fetch_steam_id(str(new_player_id))
        if not old_player_sid or not new_player_sid:
            self.logger.error(f"[Game {self.game_id}] swap failed: missing steam ids")
            return False
        # New Player cannot be in the game
        if new_player_sid in self.radiant or new_player_sid in self.dire:
            self.logger.error(f"[Game {self.game_id}] Replace Player failed: Replacement is already in game.")
            return False
        elif old_player_sid in self.radiant:
            self.radiant.remove(old_player_sid)
            self.radiant.append(new_player_sid)
        elif old_player_sid in self.dire:
            self.dire.remove(old_player_sid)
            self.dire.append(new_player_sid)
        else:
            self.logger.error(f"[Game {self.game_id}] Replace Player failed: Old Player wasn't on either team.")

        # If a lobby exists, kick both so they can seat on the new sides
        if self.dota and getattr(self.dota, "lobby", None):
            try:
                self.dota.practice_lobby_kick_from_team(SteamID(old_player_sid).as_32)
            except Exception:
                self.logger.exception(f"Error kicking player from Team")

        self.logger.info(f"[Game {self.game_id}] Replaced Player {old_player_sid} with {new_player_sid}")
        return True

    async def change_lobby_mode(self, game_mode: int) -> None:
        """Change lobby game mode without blocking the asyncio loop."""
        if not self.dota:
            return

        def _do_change():
            try:
                # minimal config patch; dota2 library accepts partial opts
                self.dota.config_practice_lobby({"game_mode": int(game_mode)})
                self.logger.info(f"[Game {self.game_id}] lobby mode set to {game_mode}")
            except Exception:
                self.logger.exception(f"[Game {self.game_id}] failed to set mode {game_mode}")

        await asyncio.to_thread(_do_change)

    def update_lobby_teams(self, radiant: list[int], dire: list[int]) -> bool:
        """Replace the intended team lists; if a lobby exists, kick mis-seated players to re-seat."""
        self.radiant = list(radiant)
        self.dire = list(dire)

        if self.dota and getattr(self.dota, "lobby", None):
            try:
                # kick anyone currently in teams but not in our intended lists to force re-seat
                for m in getattr(self.dota.lobby, "all_members", []):
                    sid64 = m.id
                    on_team = m.team in (DOTA_GC_TEAM_GOOD_GUYS, DOTA_GC_TEAM_BAD_GUYS)
                    should_be = (sid64 in self.radiant) or (sid64 in self.dire)
                    if on_team and not should_be:
                        self.dota.practice_lobby_kick_from_team(SteamID(sid64).as_32)
            except Exception:
                self.logger.exception(f"[Game {self.game_id}] update_lobby_teams kick failed")
        return True

    # ---------------- Async entrypoints ----------------

    async def create_lobby(self, radiant_steam_ids: list[int], dire_steam_ids: list[int], password: str) -> None:
        """
        Async-safe. Waits for the wrapper thread to bring up Steam+Dota, then creates the lobby.
        Never blocks the asyncio event loop.
        """
        self.radiant = radiant_steam_ids
        self.dire = dire_steam_ids
        self.password = password

        # Wait for dota 'ready' without blocking asyncio
        ready = await asyncio.to_thread(self._ready_evt.wait, 60.0)
        if not ready:
            raise RuntimeError(f"[Game {self.game_id}] Dota client did not become ready within 60s")

        # Create lobby in the wrapper thread (blocking), but do it via to_thread to avoid blocking asyncio
        await asyncio.to_thread(self._thread_create_lobby)

    # ---------------- Internals (run in wrapper thread) ----------------

    def _thread_main(self):
        """
        Runs in a dedicated OS thread. Owns SteamClient + Dota2Client and all gevent work.
        """
        try:
            uname = self.config.get(f"username_{self.account_index}")
            pwd = self.config.get(f"password_{self.account_index}")
            if not uname or not pwd:
                self.logger.error(f"[Game {self.game_id}] Missing credentials for account index {self.account_index}")
                self._ready_evt.set()  # unblock caller so we error fast
                return

            self.logger.info(f"[Game {self.game_id}] Logging into Steam as account index {self.account_index}")

            self.steam = SteamClient()
            self.dota = Dota2Client(self.steam)
            dota = self.dota
            steam = self.steam

            # track lobby ownership
            dota.gameID = self.game_id
            # dota.radiant = []
            # dota.dire = []
            dota.password = None

            # event handlers (thread context!)
            @steam.on("logged_on")
            def _on_logged_on():
                self.logger.info(f"[Game {self.game_id}] Steam logged on; launching Dota 2 client")
                dota.launch()

            @steam.on("friendlist")
            def _on_friendlist(_message):
                for sid, rel in steam.friends.items():
                    if rel == EFriendRelationship.RequestRecipient:
                        steam.friends.add(sid)
                        # If lobby exists, auto-invite
                        if dota.gameID and sid in (set(self.radiant) | set(self.dire)):
                            dota.invite_to_lobby(sid)

            @dota.on("ready")
            def _on_dota_ready():
                try:
                    self.logger.info(f"[Game {self.game_id}] Dota client ready")
                    dota.abandon_current_game()
                    dota.leave_practice_lobby()
                except Exception:
                    pass
                finally:
                    self._ready_evt.set()

            @dota.steam.on("persona_state")
            def _persona_update(persona):
                # lightweight visibility; avoid heavy logging spam
                self.logger.debug(f"[Game {self.game_id}] Persona: {persona.name} ({persona.steam_id})")

            @dota.on("lobby_new")
            def _on_lobby_new(lobby):
                # Invite all designated players
                for sid in (self.radiant + self.dire):
                    try:
                        if sid not in steam.friends:
                            steam.friends.add(sid)
                        dota.invite_to_lobby(sid)
                        user = steam.get_user(sid)
                        if user:
                            user.send_message(
                                f"Invited to 'Gargamel League Game {self.game_id}'. Password: {dota.password}"
                            )
                    except Exception:
                        self.logger.exception(f"[Game {self.game_id}] Failed invite/send to {sid}")

            # import enums from your module
            from dota2.protobufs.dota_shared_enums_pb2 import (
                DOTA_GC_TEAM_BAD_GUYS,
                DOTA_GC_TEAM_GOOD_GUYS,
            )
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

            @dota.on("lobby_changed")
            def _on_lobby_changed(message):
                try:
                    # Ask steam for names (non-blocking in this thread)
                    for m in getattr(message, "all_members", []):
                        try:
                            steam.request_persona_state([m.id])
                        except Exception:
                            pass

                    state = getattr(message, "state", None)
                    if state == LobbyState.RUN:
                        # Notify Discord side when we see the lobby in RUN
                        if self.game_id in self.discord_bot.pending_matches:
                            asyncio.run_coroutine_threadsafe(
                                self.discord_bot.on_game_started(self.game_id, message),
                                self.loop,
                            )
                    if message.state == LobbyState.UI:
                        correct = 0
                        for member in message.all_members:
                            sid32 = SteamID(member.id).as_32
                            if member.id not in self.radiant and member.team == DOTA_GC_TEAM_GOOD_GUYS:
                                dota.practice_lobby_kick_from_team(sid32)
                                logger.info(f"[Client {i}] {member.name}: wrong team (should not be Radiant)")
                            if member.id not in self.dire and member.team == DOTA_GC_TEAM_BAD_GUYS:
                                dota.practice_lobby_kick_from_team(sid32)
                                logger.info(f"[Client {i}] {member.name}: wrong team (should not be Dire)")
                            if (member.id in self.radiant and member.team == DOTA_GC_TEAM_GOOD_GUYS) or \
                                    (member.id in self.dire and member.team == DOTA_GC_TEAM_BAD_GUYS):
                                correct += 1
                            logger.info(
                                f"User found on team: {member.team} (SteamID: {member.id} Member.name: {member.name})")

                        if correct == len(self.radiant + self.dire):
                            dota.launch_practice_lobby()
                            logger.info(f"[Client {i}] Game launched")
                    # elif state == LobbyState.UI:
                    #     # keep only assigned players on correct teams; kick others to let them rejoin properly
                    #     correct = 0
                    #     for member in message.all_members:
                    #         try:
                    #             steam_id_64 = member.id
                    #             team = member.team
                    #             sid32 = SteamID(steam_id_64).as_32
                    #             if (steam_id_64 in self.radiant and team != DOTA_GC_TEAM_GOOD_GUYS) or \
                    #                (steam_id_64 in self.dire    and team != DOTA_GC_TEAM_BAD_GUYS) or \
                    #                (steam_id_64 not in (self.radiant + self.dire) and team in (DOTA_GC_TEAM_GOOD_GUYS, DOTA_GC_TEAM_BAD_GUYS)):
                    #                 dota.practice_lobby_kick_from_team(sid32)
                    #             else:
                    #                 if (steam_id_64 in self.radiant and team == DOTA_GC_TEAM_GOOD_GUYS) or \
                    #                    (steam_id_64 in self.dire    and team == DOTA_GC_TEAM_BAD_GUYS):
                    #                     correct += 1
                    #         except Exception:
                    #             pass
                    #     if correct == len(self.radiant + self.dire):
                    #         dota.launch_practice_lobby()
                    elif (state == LobbyState.POSTGAME) or (getattr(message, "game_state", None) == GameState.POST_GAME):
                        try:
                            asyncio.run_coroutine_threadsafe(
                                self.discord_bot.on_game_ended(self.game_id, message),
                                self.loop,
                            )
                        finally:
                            try:
                                dota.leave_practice_lobby()
                            except Exception:
                                pass
                            # allow outer manager to recycle account
                            self._stop_evt.set()
                except Exception:
                    self.logger.exception(f"[Game {self.game_id}] Error in lobby_changed handler")

            # ---- login & loop ----
            try:
                steam.login(username=uname, password=pwd)
            except Exception as e:
                self.logger.exception(f"[Game {self.game_id}] Steam login failed: {e}")
                self._ready_evt.set()  # unblock waiter so it can error fast
                return

            # Gevent loop (in this thread). Run until stop requested.
            try:
                steam.run_forever()
            except Exception as e:
                self.logger.exception(f"[Game {self.game_id}] Steam/Dota thread crashed: {e}")
            finally:
                try:
                    steam.logout()
                    steam.disconnect()
                except Exception:
                    pass

        except Exception:
            self.logger.exception(f"[Game {self.game_id}] Unhandled error in wrapper thread")
        finally:
            self._ready_evt.set()  # ensure anyone waiting can proceed/raise

    def _thread_create_lobby(self):
        """
        Called via asyncio.to_thread. Runs on wrapper thread. Creates the lobby.
        """
        if not self.dota:
            raise RuntimeError("Dota client not initialized")
        # configure default options
        options = {
            "game_name": f"Gargamel League Game {self.game_id}",
            "server_region": 2,
            "game_mode": 22,
            "allow_cheats": bool(self.config.get("DEBUG_MODE", False)),
            "allow_spectating": True,
            "leagueid": self.config.get("league_id", 0),
        }
        # self.dota.radiant = list(self.radiant)
        # self.dota.dire = list(self.dire)
        self.dota.password = self.password
        self.dota.create_practice_lobby(password=self.password, options=options)
        self.logger.info(f"[Game {self.game_id}] Created lobby with password {self.password}")


class DotaTalker:
    """
    On-demand lobby manager.
    - Spawns a ClientWrapper (Steam+Dota) per active lobby.
    - Tears down wrapper when the game ends/cancels.
    - Also should tear down in the signal interruptions to close the bot.
    """

    def __init__(self, discordBot: "Master_Bot.Master_Bot", loop: asyncio.AbstractEventLoop):
        self.discordBot = discordBot
        self.loop = loop

        with open("config.json") as f:
            self.config: dict = json.load(f)

        # account allocator (based on config["numClients"] + username_i/password_i)
        self.accounts = ClientAccounts(
            total=int(self.config.get("numClients", 1)),
            in_use=set()
        )

        # active game_id -> wrapper
        self.lobby_clients: dict[int, ClientWrapper] = {}

        self.mode_map = {
            # "All Pick": int(DOTA_GameMode.DOTA_GAMEMODE_AP),
            "Ranked All Pick": int(DOTA_GameMode.DOTA_GAMEMODE_ALL_DRAFT),  # 22
            "Captains Mode": int(DOTA_GameMode.DOTA_GAMEMODE_CM),
            "Random Draft": int(DOTA_GameMode.DOTA_GAMEMODE_RD),
            "Single Draft": int(DOTA_GameMode.DOTA_GAMEMODE_SD),
            "All Random": int(DOTA_GameMode.DOTA_GAMEMODE_AR),
            "Reverse Captains Mode": int(DOTA_GameMode.DOTA_GAMEMODE_REVERSE_CM),
            # "Mid Only": int(DOTA_GameMode.DOTA_GAMEMODE_MO),
            "Least Played": int(DOTA_GameMode.DOTA_GAMEMODE_LP),
            "Captains Draft": int(DOTA_GameMode.DOTA_GAMEMODE_CD),
            # "Ability Draft": int(DOTA_GameMode.DOTA_GAMEMODE_ABILITY_DRAFT),
            # "All Random Deathmatch": int(DOTA_GameMode.DOTA_GAMEMODE_ARDM),
            # "Turbo": int(DOTA_GameMode.DOTA_GAMEMODE_TURBO),
        }

        logger.info("DotaTalker ready — on-demand client per lobby")

    def _allocate_account(self) -> int:
        idx = self.accounts.next_free()
        if idx is None:
            raise RuntimeError("No free Steam accounts")
        return idx

    def _release_account(self, idx: int) -> None:
        self.accounts.release(idx)

    # -------------- Public API ---------------- #
    async def make_game(self, gameID: int, radiant_discord_ids: list[int], dire_discord_ids: list[int]) -> str:
        """
        Async: spins up a per-lobby client (in a thread), waits for 'ready',
        creates the lobby, and returns the lobby password.
        """
        radiant_steam_ids = [DB.fetch_steam_id(did) for did in radiant_discord_ids]
        dire_steam_ids = [DB.fetch_steam_id(did) for did in dire_discord_ids]

        # Pick a free account (using your allocator if you added one)
        try:
            account_index = self._allocate_account() if hasattr(self, "_allocate_account") else 0
        except Exception as e:
            logging.exception(f"[Game {gameID}] No free Steam accounts: {e}")
            return "-1"

        password = str(random.randint(1000, 9999))

        wrapper = ClientWrapper(
            game_id=gameID,
            config=self.config,
            loop=self.loop,
            discord_bot=self.discordBot,
            account_index=account_index,
            logger=logging.getLogger("DotaTalker"),
        )
        if not hasattr(self, "lobby_clients"):
            self.lobby_clients: dict[int, ClientWrapper] = {}
        self.lobby_clients[gameID] = wrapper

        wrapper.start()
        try:
            await wrapper.create_lobby(radiant_steam_ids, dire_steam_ids, password)
            return password
        except Exception as e:
            logging.exception(f"[Game {gameID}] Failed to create lobby: {e}")
            # cleanup & release account
            try:
                wrapper.shutdown()
            finally:
                if hasattr(self, "_release_account"):
                    self._release_account(account_index)
            return "-1"

    def teardown_lobby(self, game_id: int):
        wrapper = getattr(self, "lobby_clients", {}).pop(game_id, None)
        if wrapper:
            acct = getattr(wrapper, "account_index", None)
            try:
                wrapper.shutdown()
            finally:
                if hasattr(self, "_release_account") and acct is not None:
                    self._release_account(acct)

    def get_password(self, game_id: int) -> str:
        wrapper = self.lobby_clients.get(game_id)
        return wrapper.password if wrapper and wrapper.password else "-1"

    def swap_players_in_game(self, game_id: int, discord_id_1: int, discord_id_2: int) -> bool:
        wrapper = self.lobby_clients.get(game_id)
        if not wrapper:
            logger.error(f"No lobby wrapper for game {game_id}")
            return False
        return wrapper.swap_players(discord_id_1, discord_id_2)

    def replace_player_in_game(self, game_id:int, discord_id_1: int, discord_id_2: int) -> bool:
        wrapper = self.lobby_clients.get(game_id)
        if not wrapper:
            logger.error(f"No lobby wrapper for game {game_id}")
            return False
        return wrapper.replace_player(discord_id_1, discord_id_2)

    async def change_lobby_mode(self, game_id: int, game_mode: int):
        wrapper = self.lobby_clients.get(game_id)
        if not wrapper:
            return
        await wrapper.change_lobby_mode(game_mode)

    def update_lobby_teams(self, gameID: int, radiant: list[int], dire: list[int]) -> bool:
        wrapper = self.lobby_clients.get(gameID)
        if not wrapper:
            return False
        return wrapper.update_lobby_teams(radiant, dire)
