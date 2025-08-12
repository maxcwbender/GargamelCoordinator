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

from steam.client import SteamClient
from steam.steamid import SteamID
from steam.enums import EFriendRelationship

import sys
import os
import json

import gevent.monkey
gevent.monkey.patch_all()
from gevent import socket
from gevent import spawn

from steam.client import SteamClient
from dota2.client import Dota2Client

import logging

logger = logging.getLogger(__name__)

def main():
    if len(sys.argv) != 2:
        logging.error("Usage: dota_client_runner.py '<json_payload>'", file=sys.stderr)
        sys.exit(1)

    game_config = json.loads(sys.argv[1])
    
    with open("config.json") as configFile:
        sys_config: dict = json.load(configFile)

    game_id = game_config["game_id"]
    username = game_config["username"]
    password = game_config["password"]

    def handle_command(command: dict):
        action = command.get("action")
        if action == "set_mode":
            mode = command.get("mode")
            return {"status": "ok", "set_mode": mode}
        elif action == "get_status":
            return {"status": "running", "client": "dota2"}
        elif action == "shutdown":
            os._exit(0)
        return {"status": "error", "reason": "Unknown action"}

    def command_listener(socket_path):
        if os.path.exists(socket_path):
            os.remove(socket_path)

        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(socket_path)
        server.listen(1)

        logger.info(f"[DotaClient] Listening on socket {socket_path}", flush=True)

        while True:
            conn, _ = server.accept()
            with conn:
                buffer = b""
                while True:
                    data = conn.recv(4096)
                    if not data:
                        break
                    buffer += data
                try:
                    command = json.loads(buffer.decode())
                    result = handle_command(command)
                    conn.sendall(json.dumps(result).encode())
                except Exception as e:
                    error = {"status": "error", "reason": str(e)}
                    conn.sendall(json.dumps(error).encode())
    
    socket_path = f"/tmp/dotatalker-{game_id}.sock"
    spawn(command_listener, socket_path)

    steamClient = SteamClient()
    dotaClient = Dota2Client(steamClient)

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
            "allow_cheats": sys_config["DEBUG_MODE"],
            "allow_spectating": True,
            "leagueid": sys_config["league_id"],
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
            return
        dotaClient.config_practice_lobby({"game_mode": game_mode})

    @dotaClient.on("shut_down_command")
    def _():
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
            pass
            # TODO
            # with self.discordBot.pending_matches_lock:
            #     is_pending = dotaClient.game_id in self.discordBot.pending_matches
            #     # Only add the coroutine if the match is pending start
            # if is_pending:
            #     logger.info(
            #         f"Lobby with game id {dotaClient.game_id} found in running state that is pending creation.  Sending to Master Bot for DB Add."
            #     )
            #     asyncio.run_coroutine_threadsafe(
            #         self.discordBot.on_game_started(dotaClient.game_id, message),
            #         self.loop,
            #     )
            # else:
            #     print(
            #         f"Found lobby not in pending matches with game id: {dotaClient.game_id}"
            #     )

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
            username=username,
            password=password,
        )
        steamClient.run_forever()
    except Exception as e:
        logger.exception(f"[Game {game_id}] Client crash or login failed: {e}")

if __name__ == "__main__":
    main()