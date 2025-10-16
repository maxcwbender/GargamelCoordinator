# DotaTalker.py
from __future__ import annotations

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


# ----------------------------- #
#    Per-Lobby Client Wrapper   #
# ----------------------------- #
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
    Wraps a SteamClient + Dota2Client for exactly one active lobby (game_id).
    Spins up on demand and tears down when the game ends/cancels.
    """

    def __init__(
        self,
        game_id: int,
        account_idx: int,
        config: dict,
        loop: asyncio.AbstractEventLoop,
        discord_bot: "Master_Bot.Master_Bot",
    ):
        self.game_id = game_id
        self.account_idx = account_idx
        self.config = config
        self.loop = loop
        self.discord_bot = discord_bot

        # State
        self.ready_evt = threading.Event()
        self.shutdown_evt = threading.Event()

        # Teams/password at lobby creation-time
        self.radiant: list[int] = []
        self.dire: list[int] = []
        self.password: Optional[str] = None

        # Core clients
        self.steam = SteamClient()
        self.dota = Dota2Client(self.steam)

        # Book-keeping
        self.thread = threading.Thread(target=self._thread_main, name=f"SteamDota-{game_id}", daemon=True)

        # Wire up event handlers (Steam + Dota)
        self._wire_handlers()

        # Start the background thread (SteamClient.run_forever())
        self.thread.start()

    # ----------- Thread / Lifecycle ----------- #
    def _thread_main(self):
        try:
            uname = self.config.get(f"username_{self.account_idx}")
            pwd = self.config.get(f"password_{self.account_idx}")
            if not uname or not pwd:
                logger.error(f"[Game {self.game_id}] Missing credentials for account index {self.account_idx}")
                return

            logger.info(f"[Game {self.game_id}] Logging into Steam as account index {self.account_idx}")
            self.steam.login(username=uname, password=pwd)
            self.steam.run_forever()  # blocking
        except Exception:
            logger.exception(f"[Game {self.game_id}] Steam/Dota thread crashed")

    def shutdown(self):
        """Gracefully tears down the lobby + logs out the Steam client."""
        if self.shutdown_evt.is_set():
            return
        self.shutdown_evt.set()
        try:
            logger.info(f"[Game {self.game_id}] Shutting down client wrapper")
            try:
                self.dota.leave_practice_lobby()
            except Exception:
                pass
            try:
                # If the library doesn't expose logout, closing the network loop suffices.
                self.steam.disconnect()
            except Exception:
                pass
        except Exception:
            logger.exception(f"[Game {self.game_id}] Error during shutdown")

    # -------------- Public API ---------------- #
    def create_lobby(self, radiant_steam_ids: list[int], dire_steam_ids: list[int], password: str):
        """Called by DotaTalker to actually create the practice lobby (sync)."""
        # Wait until Dota is ready
        self.ready_evt.wait(timeout=60.0)
        if not self.ready_evt.is_set():
            raise RuntimeError(f"[Game {self.game_id}] Dota client not ready in time")

        self.radiant = list(radiant_steam_ids)
        self.dire = list(dire_steam_ids)
        self.password = password

        lobby_cfg = {
            "game_name": f"Gargamel League Game {self.game_id}",
            "server_region": 2,
            "game_mode": int(DOTA_GameMode.DOTA_GAMEMODE_ALL_DRAFT),
            "allow_cheats": bool(self.config.get("DEBUG_MODE", False)),
            "allow_spectating": True,
            # prefer leagueid (field name used by the proto options historically)
            "leagueid": self.config.get("league_id"),
        }

        self.dota.create_practice_lobby(password=password, options=lobby_cfg)
        logger.info(f"[Game {self.game_id}] Created lobby with password {password}")

    async def change_lobby_mode(self, game_mode: int):
        """Async path to change lobby config safely from the Discord loop."""
        try:
            if not getattr(self.dota, "lobby", None):
                return
            opts = self._safe_lobby_snapshot()
            opts["game_mode"] = int(game_mode)
            await self.dota.config_practice_lobby(opts)
        except Exception as e:
            logger.exception(f"[Game {self.game_id}] Failed to apply mode {game_mode}: {e}")

    def update_lobby_teams(self, radiant: list[int], dire: list[int]) -> bool:
        if getattr(self.dota, "lobby", None):
            self.radiant = list(radiant)
            self.dire = list(dire)
            logger.info(f"[Game {self.game_id}] Lobby teams updated")
            return True
        return False

    def swap_players(self, discord_id_1: int, discord_id_2: int) -> bool:
        steam_id_1 = DB.fetch_steam_id(discord_id_1)
        steam_id_2 = DB.fetch_steam_id(discord_id_2)

        if steam_id_1 in self.radiant and steam_id_2 in self.dire:
            self.radiant.remove(steam_id_1)
            self.dire.remove(steam_id_2)
            self.radiant.append(steam_id_2)
            self.dire.append(steam_id_1)
            logger.info(f"[Game {self.game_id}] Swapped {steam_id_1} <-> {steam_id_2}")
            return True
        elif steam_id_2 in self.radiant and steam_id_1 in self.dire:
            self.radiant.remove(steam_id_2)
            self.dire.remove(steam_id_1)
            self.radiant.append(steam_id_1)
            self.dire.append(steam_id_2)
            logger.info(f"[Game {self.game_id}] Swapped {steam_id_1} <-> {steam_id_2}")
            return True
        else:
            logger.error(f"[Game {self.game_id}] Swap failed: users not on opposing teams")
            return False

    def get_password(self) -> str:
        return self.password or "-1"

    # -------------- Internals ----------------- #
    ALLOWED_LOBBY_KEYS = {
        "game_name", "server_region", "game_mode", "visibility", "pass_key",
        "cm_pick", "series_type", "dota_tv_delay",
        "allow_cheats", "fill_with_bots", "intro_mode", "start_game_setup",
        "pause_setting", "league_id", "leagueid", "bot_difficulty",
        "allow_spectating", "allchat",
    }

    def _safe_lobby_snapshot(self) -> Dict[str, Any]:
        lob = getattr(self.dota, "lobby", None)
        if lob is None:
            raise RuntimeError("Not currently in a lobby")
        snap = MessageToDict(
            lob,
            preserving_proto_field_name=True,
            including_default_value_fields=True,
            use_integers_for_enums=True,
        )
        filtered = {k: v for k, v in snap.items() if k in self.ALLOWED_LOBBY_KEYS}
        # Coerce obvious numeric/bool fields
        for key in ("server_region", "game_mode", "cm_pick", "series_type", "dota_tv_delay",
                    "start_game_setup", "pause_setting", "visibility",
                    "league_id", "bot_difficulty"):
            if key in filtered:
                try:
                    filtered[key] = int(filtered[key])
                except Exception:
                    pass
        for key in ("allow_cheats", "fill_with_bots", "intro_mode", "allow_spectating", "allchat"):
            if key in filtered:
                filtered[key] = bool(filtered[key])
        return filtered

    def _wire_handlers(self):
        # ---- Steam ---- #
        @self.steam.on("logged_on")
        def _on_logged_on():
            logger.info(f"[Game {self.game_id}] Logged on to Steam (acct idx {self.account_idx})")
            try:
                self.dota.launch()
            except Exception:
                logger.exception(f"[Game {self.game_id}] Failed to launch Dota client")

        @self.steam.on("friendlist")
        def _on_friendlist(_msg):
            # Auto-accept friend requests and invite users in our teams.
            for steam_id, relationship in self.steam.friends.items():
                if relationship == EFriendRelationship.RequestRecipient:
                    self.steam.friends.add(steam_id)
                    if steam_id in (self.radiant + self.dire):
                        try:
                            self.dota.invite_to_lobby(steam_id)
                        except Exception:
                            logger.exception(f"[Game {self.game_id}] Invite failed for {steam_id}")

        # ---- Dota ---- #
        @self.dota.on("ready")
        def _on_dota_ready():
            logger.info(f"[Game {self.game_id}] Dota client ready")
            try:
                self.dota.abandon_current_game()
            except Exception:
                pass
            try:
                self.dota.leave_practice_lobby()
            except Exception:
                pass
            self.ready_evt.set()

        @self.dota.on("lobby_new")
        def _on_lobby_new(_lobby):
            if self.password is None:
                return
            # Invite both teams and DM lobby info over Steam
            for sid in self.radiant + self.dire:
                try:
                    if sid not in self.dota.steam.friends:
                        self.dota.steam.friends.add(sid)
                    self.dota.invite_to_lobby(sid)
                    self.dota.steam.get_user(sid).send_message(
                        f"Invited you to 'Gargamel League Game {self.game_id}'. Password: {self.password}"
                    )
                except Exception:
                    logger.exception(f"[Game {self.game_id}] Failed inviting {sid}")

        @self.dota.steam.on("persona_state")
        def _on_persona_state(persona):
            # Helpful logging; optional
            logger.info(f"[Game {self.game_id}] Persona update: {persona.name} ({persona.steam_id})")

        @self.dota.on("lobby_changed")
        def _on_lobby_changed(message):
            logger.info(f"[Game {self.game_id}] Lobby changed: state={getattr(message, 'state', None)}")

            # keep friends list updated and kick non-members to correct teams
            for member in message.all_members:
                try:
                    self.dota.steam.request_persona_state([member.id])
                except Exception:
                    logger.exception(f"[Game {self.game_id}] Persona request failed for {member.id}")

                # Ensure we friend everyone present
                try:
                    if member.id not in self.dota.steam.friends:
                        self.dota.steam.friends.add(member.id)
                except Exception:
                    pass

            if message.state == LobbyState.RUN:
                # Only notify once when we expected this lobby to run
                try:
                    if self.game_id in self.discord_bot.pending_matches:
                        logger.info(f"[Game {self.game_id}] Lobby running; notifying Master_Bot.on_game_started")
                        asyncio.run_coroutine_threadsafe(
                            self.discord_bot.on_game_started(self.game_id, message),
                            self.loop
                        )
                except Exception:
                    logger.exception(f"[Game {self.game_id}] on_game_started scheduling failed")

            elif message.state == LobbyState.UI:
                # Enforce teams: kick any wrong-team member to pool and auto-launch when correct
                correct = 0
                target_total = len(self.radiant) + len(self.dire)
                for member in message.all_members:
                    sid32 = SteamID(member.id).as_32
                    try:
                        if member.id in self.radiant and member.team != DOTA_GC_TEAM_GOOD_GUYS:
                            self.dota.practice_lobby_kick_from_team(sid32)
                        elif member.id in self.dire and member.team != DOTA_GC_TEAM_BAD_GUYS:
                            self.dota.practice_lobby_kick_from_team(sid32)
                        elif (member.id in self.radiant and member.team == DOTA_GC_TEAM_GOOD_GUYS) or \
                             (member.id in self.dire and member.team == DOTA_GC_TEAM_BAD_GUYS):
                            correct += 1
                        elif member.team in [DOTA_GC_TEAM_GOOD_GUYS, DOTA_GC_TEAM_BAD_GUYS]:
                            # in some team but not ours
                            self.dota.practice_lobby_kick_from_team(sid32)
                    except Exception:
                        logger.exception(f"[Game {self.game_id}] Team enforcement failed for {member.id}")

                if correct == target_total and target_total > 0:
                    try:
                        self.dota.launch_practice_lobby()
                        logger.info(f"[Game {self.game_id}] Launched Dota lobby")
                    except Exception:
                        logger.exception(f"[Game {self.game_id}] Failed to launch lobby")

            elif message.state == LobbyState.POSTGAME or getattr(message, 'game_state', None) == GameState.POST_GAME:
                # End-of-game handling
                try:
                    asyncio.run_coroutine_threadsafe(
                        self.discord_bot.on_game_ended(self.game_id, message),
                        self.loop
                    )
                except Exception:
                    logger.exception(f"[Game {self.game_id}] on_game_ended scheduling failed")

                # teardown right after we schedule the callback
                self.shutdown()

            # else: other states are informative only


# ----------------------------- #
#         DotaTalker            #
# ----------------------------- #
class DotaTalker:
    """
    On-demand lobby manager.
    - Spawns a ClientWrapper (Steam+Dota) per active lobby.
    - Tears down wrapper when the game ends/cancels.
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
            "All Pick": int(DOTA_GameMode.DOTA_GAMEMODE_AP),
            "Ranked All Pick": int(DOTA_GameMode.DOTA_GAMEMODE_ALL_DRAFT),  # 22
            "Captains Mode": int(DOTA_GameMode.DOTA_GAMEMODE_CM),
            "Random Draft": int(DOTA_GameMode.DOTA_GAMEMODE_RD),
            "Single Draft": int(DOTA_GameMode.DOTA_GAMEMODE_SD),
            "All Random": int(DOTA_GameMode.DOTA_GAMEMODE_AR),
            "Reverse Captains Mode": int(DOTA_GameMode.DOTA_GAMEMODE_REVERSE_CM),
            "Mid Only": int(DOTA_GameMode.DOTA_GAMEMODE_MO),
            "Least Played": int(DOTA_GameMode.DOTA_GAMEMODE_LP),
            "Captains Draft": int(DOTA_GameMode.DOTA_GAMEMODE_CD),
            "Ability Draft": int(DOTA_GameMode.DOTA_GAMEMODE_ABILITY_DRAFT),
            "All Random Deathmatch": int(DOTA_GameMode.DOTA_GAMEMODE_ARDM),
            "Turbo": int(DOTA_GameMode.DOTA_GAMEMODE_TURBO),
        }

        logger.info("DotaTalker ready — on-demand client per lobby")

    # -------------- Public API ---------------- #
    def make_game(self, gameID: int, radiant_discord_ids: list[int], dire_discord_ids: list[int]) -> str:
        """
        Creates (spawns) a per-lobby Steam+Dota client and sets up lobby.
        Returns the lobby password or "-1" if no accounts are free.
        """
        # allocate a free account index
        idx = self.accounts.next_free()
        if idx is None:
            logger.error("[DotaTalker] No free Steam accounts available.")
            return "-1"

        try:
            wrapper = ClientWrapper(
                game_id=gameID,
                account_idx=idx,
                config=self.config,
                loop=self.loop,
                discord_bot=self.discordBot,
            )
            self.lobby_clients[gameID] = wrapper

            # Map Discord -> Steam IDs
            radiant_steam_ids = [DB.fetch_steam_id(did) for did in radiant_discord_ids]
            dire_steam_ids = [DB.fetch_steam_id(did) for did in dire_discord_ids]

            password = str(random.randint(1000, 9999))
            wrapper.create_lobby(radiant_steam_ids, dire_steam_ids, password)
            return password
        except Exception:
            logger.exception(f"[Game {gameID}] Failed to spin up lobby")
            # release the account if setup failed
            self.accounts.release(idx)
            # cleanup wrapper if partially created
            w = self.lobby_clients.pop(gameID, None)
            if w:
                w.shutdown()
            return "-1"

    def teardown_lobby(self, game_id: int):
        """
        Call this when a lobby is canceled or after on_game_ended. Safe to call multiple times.
        """
        wrapper = self.lobby_clients.pop(game_id, None)
        if not wrapper:
            return
        try:
            wrapper.shutdown()
        finally:
            # always release the Steam account index
            self.accounts.release(wrapper.account_idx)

    def get_password(self, game_id: int) -> str:
        wrapper = self.lobby_clients.get(game_id)
        return wrapper.get_password() if wrapper else "-1"

    def swap_players_in_game(self, game_id: int, discord_id_1: int, discord_id_2: int) -> bool:
        wrapper = self.lobby_clients.get(game_id)
        if not wrapper:
            logger.error(f"No lobby wrapper for game {game_id}")
            return False
        return wrapper.swap_players(discord_id_1, discord_id_2)

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
