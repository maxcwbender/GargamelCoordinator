# main_bot.py
from typing import Tuple, Dict, Optional
import DotaTalker
import TheCoordinator as TC
import json
import math
import sqlite3
import asyncio
import discord
import os
from discord import app_commands
from discord.ext import commands
import random
import signal
import csv
import re
from pathlib import Path

import DBFunctions as DB
from logger import setup_logging
import logging

import threading
"""
Main bot script for Discord MasterBot managing Dota 2 community interactions.

Features:
- Moderation queue with mod assignment and decision recording
- User vouching and rating system with role assignments
- Game queueing and matchmaking integration with DotaTalker and TheCoordinator
- TCP server to receive SteamID notifications from localhost
- Uses discord.py app_commands (slash commands) for interaction
- SQLite DB backend for persistent user and mod data

Author: mbender and crowedev
"""

setup_logging()
logger = logging.getLogger(__name__)

class Master_Bot(commands.Bot):
    """
    Discord bot subclass managing all interactions and game coordination.

    Attributes:
        config (dict): Configuration loaded from JSON file.
        con (sqlite3.Connection): Database connection to 'allUsers.db'.
        coordinator (TheCoordinator): Manages matchmaking and queue logic.
        dota_talker (DotaTalker): Handles Dota 2 client interactions.
        the_guild (discord.Guild): The main Discord guild the bot operates in.
        game_counter (int): Incremental ID for tracking created games.
        game_channels (dict): Maps game_id to tuple of (radiant voice channel, dire voice channel).
        game_map (dict): Maps player discord_id to their current game_id.
        game_map_inverse (dict): Maps game_id to set of player discord_ids.
    """

    def __init__(self, config_path="config.json"):
        """
        Initialize the bot with config, intents, DB connection, and key state variables.

        Loads bot token and other settings from config_path JSON file. Sets up default
        discord.Intents plus members intent for member-related events.

        Args:
            config_path (str): Path to JSON configuration file.
        """

        with open(config_path) as f:
            self.config = json.load(f)

        intents = discord.Intents.default()
        intents.members = True
        intents.message_content = True
        super().__init__(command_prefix="!", intents=intents)

        self.con = sqlite3.connect("allUsers.db")
        self.coordinator = TC.TheCoordinator()

        self.the_guild: discord.Guild = None
        self.game_channels: dict[
            int, Tuple[discord.VoiceChannel, discord.VoiceChannel]
        ] = {}
        self.game_map: dict[int, int] = {}
        self.game_map_inverse: dict[int, tuple[set[int], set[int]]] = {}
        self.queue_status_msg: discord.Message = None
        self.pending_game_task: asyncio.Task | None = None
        self.lobby_messages: dict[int, discord.Message] = {}
        self.dota_talker: DotaTalker.DotaTalker = None
        self.pending_matches = set()
        self.ready_check_lock = asyncio.Lock()
        self.ready_check_status = False

        self.deadleague_channel_id = int(self.config.get("GENERAL_CHANNEL_ID", 0))
        self.deadleague_cooldown = int(self.config.get("DEAD_LEAGUE_COOLDOWN", 15))
        self.deadleague_csv_path = self.config.get("DEAD_LEAGUE_CSV_PATH", "dead_league_responses.csv")
        self._deadleague_last_ts: float = 0.0
        self._deadleague_trigger = re.compile(r"\bdead\s*league\b", re.IGNORECASE)

        def _load_deadleague_responses(csv_path: str) -> list[str]:
            p = Path(csv_path)
            if p.exists():
                with p.open(newline="", encoding="utf-8") as f:
                    reader = csv.DictReader(f)
                    out = [row.get("response", "").strip() for row in reader if row.get("response", "").strip()]
                    if out:
                        logger.info(f"Loaded {len(out)} Dead League responses from CSV.")
                        return out
            logger.warning("Dead League CSV not found or empty. Falling back to a small built-in list.")
            return [
                "Ah yes, spoken like a true spectator.",
                "Bold words from someone not even on the scoreboard.",
                "League’s alive — unlike your MMR.",
                "You’re right, it’s dead… just like you in most games.",
                "Thanks for the league prediction, Oracle."
            ]

        self._deadleague_responses = _load_deadleague_responses(self.deadleague_csv_path)

    async def setup_hook(self):
        # Overriding discord bot.py setup_hook to register commands so they can be globally used by gui and slash
        # commands outside of the on_ready.  Better approach so GUI can share functionality, but also
        # recommended by discord documentation.
        # TODO: Pull out more than just the queueing
        @app_commands.command(name="queue", description="Join the game queue")
        async def queue(interaction: discord.Interaction):
            await self.queue_user(interaction)

        @app_commands.command(name="leave", description="Leave the game queue")
        async def leave(interaction: discord.Interaction):
            await self.leave_queue(interaction)

        self.tree.add_command(queue)
        self.tree.add_command(leave)

        # Global Sync is slow, TODO: consider conditionally doing this.
        # TODO: Sync is happening on on_ready right now, once we pull them out add it here and remove it from there.
        # await self.tree.sync()  # global sync
        # await self.tree.sync(guild=self.the_guild)  # optional: sync for specific guild

    def handle_exit_signals(self, signum, frame):
        logger.info(f"Received exit signal {signum}, cleaning up bot creations.")


        # Clean up all remaining Steam/Dota clients for games
        if hasattr(self, "dota_talker") and self.dota_talker:
            try:
                for gid in list(self.dota_talker.lobby_clients.keys()):
                    self.dota_talker.teardown_lobby(gid)
                logger.info("[handle_exit_signals] All Dota clients torn down.")
            except Exception:
                logger.exception("[handle_exit_signals] Error tearing down Dota clients")

        # Clean up Discord Voice and Text Channels, Clear the Bot Channel
        # TODO: Clean up Dota Lobbies that are empty if we bailed at the wrong time.
        loop = asyncio.get_event_loop()

        async def shutdown_sequence():
            try:
                await self.clean_up_on_exit_helper()
            except Exception as e:
                logger.exception(f"Cleanup failed with exception: {e}")

        loop.create_task(shutdown_sequence())
    async def clean_up_voice_channels(self):
        # Cleaning up channels is async, but signal catcher requires sync, setting up a job to
        # clean them up and just assume it's fine.
        general_channel = self.get_channel(int(self.config["GENERAL_V_CHANNEL_ID"]))

        move_tasks = []
        delete_tasks = []

        for channel in self.the_guild.voice_channels:
            if channel.name.startswith("Game"):
                logger.info(f"Found Game channel: {channel.name}")
                # Queue up move tasks for all members in the Game channel
                for member in channel.members:
                    if member.voice and member.voice.channel == channel:
                        logger.info(
                            f"[clean_up_on_exit_helper] Moving Member: {member} from leftover voice channel added to queued tasks.")
                        move_tasks.append(member.move_to(general_channel))

                # Queue up deletion of the Game channel
                logger.info(f"[clean_up_on_exit_helper] Deleting channel:'{channel}' added to queued tasks.")
                delete_tasks.append(channel.delete())

        if move_tasks:
            logger.info(
                f"[clean_up_on_exit_helper] Running async task to move all players from leftover Game Voice channels.")
            await asyncio.gather(*move_tasks)


        logger.info(
            f"[clean_up_on_exit_helper] Running async task to delete leftover Game Voice channels.")
        await asyncio.gather(*delete_tasks)

    async def clean_up_on_exit_helper(self):
        # Cleaning up channels is async, but signal catcher requires sync, setting up a job to
        # clean them up and just assume it's fine.

        await self.clean_up_voice_channels()

        lobby_channel = self.get_channel(int(self.config["LOBBY_CHANNEL_ID"]))

        if lobby_channel:
            purge_task = self.get_channel(int(self.config["LOBBY_CHANNEL_ID"])).purge(
                limit=100
            )

            await asyncio.gather(purge_task)


        if hasattr(bot, "tcp_server") and bot.tcp_server:
            bot.tcp_server.close()
            await bot.tcp_server.wait_closed()

        await self.close()

        pending = [t for t in asyncio.all_tasks() if not t.done()]
        logger.debug(f"🔍 Pending tasks after self.close: {len(pending)}")

        for task in pending:
            logger.debug(f" - {task}")

    async def queue_user(self, interaction: discord.Interaction, respond=True):

        if interaction and not interaction.response.is_done():
            try:
                await interaction.response.defer(thinking=False, ephemeral=True)
            except Exception:
                pass


        if self.coordinator.in_queue(interaction.user.id):
            await interaction.followup.send(
                "You're already in the queue, bozo.", ephemeral=True
            )
            return False

        rating = DB.fetch_rating(interaction.user.id)
        if not rating:
            logger.info(f"User with ID: {interaction.user.id} doesn't have a rating")
            await interaction.followup.send(
                "You don't have a rating yet. Talk to an Administrator to get started.",
                ephemeral=True,
            )
            return False

        pool_size = self.coordinator.add_player(interaction.user.id, rating)
        await self.update_queue_status_message()

        if pool_size >= self.config["TEAM_SIZE"] * 2:
            if self.pending_game_task is None or self.pending_game_task.done():

                start_game_timer = 60
                if self.config["DEBUG_MODE"]:
                    start_game_timer = 15

                self.pending_game_task = asyncio.create_task(self._start_game_loop(start_game_timer))

        # Slash command requires a response for success
        if respond:
            await interaction.followup.send(
                f"You're now queueing with rating {rating}.", ephemeral=True
            )

        return True  # success

    async def leave_queue(self, interaction: discord.Interaction, respond=True):

        if interaction and not interaction.response.is_done():
            try:
                await interaction.response.defer(thinking=True, ephemeral=True)
            except Exception:
                pass

        if not self.coordinator.in_queue(interaction.user.id):
            await interaction.followup.send(
                "You're not in the queue, bozo, how are you gonna leave?",
                ephemeral=True,
            )
            return False
        self.coordinator.remove_player(interaction.user.id)
        await interaction.followup.send(
            "You have left the queue.", ephemeral=True
        )
        await self.update_queue_status_message()

    def _has_role(self, member: discord.abc.User, role_name: str) -> bool:
        roles = getattr(member, "roles", [])
        return any(getattr(r, "name", None) == role_name for r in roles)

    async def start_ready_check(self, interaction: discord.Interaction, sleep_time: int = 60):
        # Only Mods are allowed to start ready checks
        if not self._has_role(interaction.user, "Mod"):
            logger.warning(f"User {interaction.user.id} has no mod role and tried to start a ready check.")
            return await interaction.response.send_message("Only authorized users can start a ready check.",
                                                           ephemeral=True)
        else:
            await interaction.response.send_message(
                "Initiating ready check", ephemeral=True
            )
        logger.info("Initiated ready check")
        if self.ready_check_status:
            if interaction and not interaction.response.is_done():
                logger.info("Ready check detected as already in progress, aborting.")
                await interaction.response.send_message("Ready check already in progress!", ephemeral=True)
            return

        if interaction and not interaction.response.is_done():
            try:
                await interaction.response.defer(thinking=True, ephemeral=True)
            except Exception:
                pass

        self.ready_check_status = True

        try:
            await self.update_queue_status_message(new_message=True, content="Ready check in progress!")

            queue_snapshot: set[int] = set(self.coordinator.queue.keys())
            confirmed = set()
            removed = set()
            blocked = set()
            message_tasks = []

            def make_view(user_id):
                view = discord.ui.View(timeout=60)

                async def confirm_callback(inner_interaction: discord.Interaction, user_id=user_id):
                    await inner_interaction.response.send_message(
                        "Marked ready!", ephemeral=True
                    )
                    logger.info(
                        f"Ready check confirmation from {inner_interaction.user.name}: ready"
                    )
                    confirmed.add(user_id)
                    await inner_interaction.message.delete()

                async def reject_callback(inner_interaction: discord.Interaction, user_id=user_id):
                    await inner_interaction.response.send_message(
                        "Removing from queue!", ephemeral=True
                    )
                    self.coordinator.remove_player(user_id)
                    logger.info(
                        f"Ready check confirmation from {inner_interaction.user.name}: remove"
                    )
                    removed.add(user_id)
                    await inner_interaction.message.delete()

                confirm_button = discord.ui.Button(
                    label="✅ I'm Ready!", style=discord.ButtonStyle.primary
                )
                reject_button = discord.ui.Button(
                    label="❌ I'm out", style=discord.ButtonStyle.danger
                )

                confirm_button.callback = confirm_callback
                reject_button.callback = reject_callback

                view.add_item(confirm_button)
                view.add_item(reject_button)

                return view

            sem = asyncio.Semaphore(5)
            async def send_message(member: discord.Member, view):
                async with sem:
                    try:
                        await member.send(
                            "Are you still ready to play? Click below:", view=view
                        )
                    except discord.Forbidden:
                        logger.warning(
                            f"Couldn't DM {member.name}>. Assuming not ready."
                        )

            for user_id in queue_snapshot:
                member = self.the_guild.get_member(user_id)
                if not member:
                    logger.warning(
                        f"Tried to get ready check confirmation from user {user_id}, but it seems they're no longer in the server"
                    )
                    blocked.add(member)
                    continue

                view = make_view(user_id)

                message_tasks.append(send_message(member, view))

            await asyncio.gather(*message_tasks)
            time_slept = 0
            while time_slept < sleep_time and len(confirmed) + len(removed) + len(blocked) < len(queue_snapshot):
                await self.update_queue_status_message(
                    content=f"Ready check in progress", readied=confirmed
                )
                await asyncio.sleep(2)
                print(f"time_slept: {time_slept}")
                time_slept += 2


            to_remove = queue_snapshot - (confirmed | removed | blocked)

            removed_due_to_decline = len(removed)  # clicked ❌
            auto_removed_after_timeout = len(to_remove)  # timed out / no response
            # couldnt_reach = len(blocked)  # DMs failed or not in guild

            for user_id in to_remove:
                self.coordinator.remove_player(user_id)

            if interaction:
                await interaction.followup.send(f"Ready check complete.", ephemeral=True)

            await self.update_queue_status_message(
                new_message=True,
                content=(
                    "Ready check complete. "
                    f"{len(confirmed)} confirmed, "
                    f"{removed_due_to_decline + auto_removed_after_timeout} removed from queue "
                ),
            )
        finally:
            self.ready_check_status = False

    # GUI Views
    class QueueButtonView(discord.ui.View):
        def __init__(self, parent):
            super().__init__(timeout=None)
            self.parent = parent

        @discord.ui.button(label="Join Queue", style=discord.ButtonStyle.primary)
        async def join_queue(
            self, interaction: discord.Interaction, button: discord.ui.Button
        ):
            await self.parent.queue_user(interaction)

        @discord.ui.button(label="Leave Queue", style=discord.ButtonStyle.danger)
        async def leave_queue(
            self, interaction: discord.Interaction, button: discord.ui.Button
        ):
            await self.parent.leave_queue(interaction)

        @discord.ui.button(label="Initiate Ready Check✅ ", style=discord.ButtonStyle.success)
        async def ready_check(
            self, interaction: discord.Interaction, button: discord.ui.Button
        ):
            async with self.parent.ready_check_lock:
                if self.parent.ready_check_status:
                    await interaction.response.send_message(
                        "Ready check already in progress!", ephemeral=True
                    )
            await self.parent.start_ready_check(interaction)

    class GameModePoll(discord.ui.View):
        def __init__(
                self,
                parent: "Master_Bot",
                *,
                game_id: int,
                mode_name_to_enum: dict[str, int],
                duration_sec: int = 60,
                allowed_role: Optional[str] = None,  # e.g. "Mod" to gate Start/End
        ):
            super().__init__(timeout=None)
            self.parent = parent
            self.game_id = game_id
            self.duration_sec = duration_sec
            self.mode_name_to_enum = mode_name_to_enum
            self.allowed_role = allowed_role

            # voting state
            self.votes_by_user: Dict[int, str] = {}
            self._closed = False
            self._started = False
            self._lock = asyncio.Lock()

            # Build options, but keep select disabled until Start is pressed
            options = self.build_mode_options()
            self.select = self.GameModeSelect(self, placeholder="Choose a game mode…", options=options)
            self.select.disabled = True
            self.add_item(self.select)

            # Controls
            self.add_item(self.StartPollButton(self))
            self.add_item(self.EndPollButton(self))
            self._auto_task: Optional[asyncio.Task] = None

        # Helper Functions
        def _has_role(self, member: discord.abc.User, role_name: str) -> bool:
            roles = getattr(member, "roles", [])
            return any(getattr(r, "name", None) == role_name for r in roles)

        def _options_in_order(self) -> list[str]:
            return [opt.label for opt in self.select.options]

        def build_mode_options(self):
            # Easter egg game mode option
            # Turns 'Single Draft' to 'Low Quality Game Mode' 5% of the time.
            easter_egg_active = random.random() < 0.95

            options = []
            for name in self.parent.dota_talker.mode_map.keys():
                if name == "Low Quality Game Mode":
                    continue
                label = name

                if easter_egg_active and name == "Single Draft":
                    label = "Low Quality Game Mode"

                options.append(discord.SelectOption(label=label, value=name))

            return options

        # UI Components
        class GameModeSelect(discord.ui.Select):
            def __init__(self, outer: "GameModePoll", placeholder: str, options: list[discord.SelectOption]):
                super().__init__(placeholder=placeholder, min_values=1, max_values=1, options=options)
                self.outer = outer

            async def callback(self, interaction: discord.Interaction):

                if not interaction.response.is_done():
                    await interaction.response.defer(ephemeral=True)

                async with self.outer._lock:
                    if self.outer._closed or not self.outer._started:
                        try:
                            await interaction.followup.send("Poll isn’t active.", ephemeral=True)
                        except Exception as e:
                            logger.exception(f"[Game {self.outer.game_id}] Poll not active: {e}")
                        return

                    choice = self.values[0]
                    self.outer.votes_by_user[interaction.user.id] = choice

                    # Determine if voter is a player or spectator
                    current_sets = self.outer.parent.game_map_inverse.get(self.outer.game_id, (set(), set()))
                    current_player_ids = current_sets[0] | current_sets[1]
                    is_spectator = interaction.user.id not in current_player_ids

                    if is_spectator:
                        msg = f"You voted **{choice}**. *(Spectator votes only count during tiebreakers.)*"
                    else:
                        msg = f"You voted **{choice}**."

                await self.outer._update_poll_embed(interaction, transient_notice=msg)

        class StartPollButton(discord.ui.Button):
            def __init__(self, outer: "GameModePoll"):
                super().__init__(label="Start Poll", style=discord.ButtonStyle.primary)
                self.outer = outer

            async def callback(self, interaction: discord.Interaction):
                # Permission check
                if self.outer.allowed_role and not self.outer._has_role(interaction.user, self.outer.allowed_role):
                    return await interaction.response.send_message("Only authorized users can start the poll.",
                                                                   ephemeral=True)

                # Always defer immediately to prevent timeouts
                if not interaction.response.is_done():
                    await interaction.response.defer(ephemeral=True)

                # Delegate to reusable helper
                await self.outer.start_poll(interaction)

        class EndPollButton(discord.ui.Button):
            def __init__(self, outer: "GameModePoll"):
                super().__init__(label="End Poll", style=discord.ButtonStyle.danger)
                self.outer = outer

            async def callback(self, interaction: discord.Interaction):
                if self.outer.allowed_role and not self.outer._has_role(interaction.user, self.outer.allowed_role):
                    return await interaction.response.send_message("Only authorized users can end the poll.",
                                                                   ephemeral=True)

                if not interaction.response.is_done():
                    await interaction.response.defer(ephemeral=True)

                await self.outer._end_poll(interaction, manual=True)

        # Polling Lifecycle
        async def _auto_close_task(self, message: discord.Message):
            try:
                logger.info(f"[Game_ID:{self.game_id}] Setting sleep timer for 60 seconds.")
                await asyncio.sleep(self.duration_sec)
                # If we hit End manually, avoid a double trigger
                if not self._closed:
                    logger.info(f"Self_closed was false, going to end poll automatically")
                    await self._end_poll(None)
            except asyncio.CancelledError as err:
                logger.info(f"[Game_ID:{self.game_id}] Auto-close task cancelled - poll likely ended early.")
                # Task was cancelled because poll ended early
                return
            except Exception as e:
                logger.exception(f"Poll auto-close error: {e}")

        async def start_poll(self, triggered_by: Optional[discord.Interaction] = None):
            """Start the poll manually or programmatically."""
            logger.info(f"[Game_ID:{self.game_id}] Starting game mode poll.")
            async with self._lock:
                logger.info(f"[Game_ID:{self.game_id}] Lock acquired for game mode poll.")
                if self._started:
                    logger.info(f"[Game_ID:{self.game_id}] Poll already in progress detected.")
                    if triggered_by:
                        await triggered_by.followup.send("Poll already started.", ephemeral=True)
                    return
                self._started = True
                self.select.disabled = False

            message = self.parent.lobby_messages.get(self.game_id)
            if not message:
                logger.info(f"[Game_ID:{self.game_id}] No message was found to edit.  Abandoning start of poll.")
                if triggered_by:
                    await triggered_by.followup.send("Lobby message not found.", ephemeral=True)
                return

            embed = message.embeds[0]
            idx = next((i for i, f in enumerate(embed.fields)
                        if f.name.startswith("🗳️ Game Mode Voting")), None)

            voting_text = (
                "Select a mode from the dropdown below.\n\n"
                f"Poll ends in **{self.duration_sec} seconds**."
            )

            if idx is not None:
                embed.set_field_at(idx, name="🗳️ Game Mode Voting", value=voting_text, inline=False)
            else:
                embed.add_field(name="🗳️ Game Mode Voting", value=voting_text, inline=False)

            await message.edit(embed=embed, view=self)

            # Alert game-side and start timer
            await self.parent.dota_talker.alert_game_polling_started(self.game_id)
            # Cancel any leftover auto task before starting new one
            if self._auto_task and not self._auto_task.done():
                logger.info(f"[Game_ID:{self.game_id}] Found an auto task and it wasn't done.  Cancelling older poll.")
                self._auto_task.cancel()
                self._auto_task = None

            # Start a new auto-close timer
            self._auto_task = asyncio.create_task(self._auto_close_task(message))

            if triggered_by:
                await triggered_by.followup.send("Polling started!", ephemeral=True)

        async def _end_poll(self, interaction: Optional[discord.Interaction], manual: bool = False):
            logger.info(f"End poll {self.game_id}")
            async with self._lock:
                logger.info(f"Using lock for ending poll {self.game_id}")
                if self._closed:
                    logger.info(f"Self closed was true")
                    if interaction and not interaction.response.is_done():
                        await interaction.response.send_message("Poll already closed.", ephemeral=True)
                    return
                logger.info(f"Setting self closed to true")
                self._closed = True

                # Cancel any pending auto-close timer
                if (
                        hasattr(self, "_auto_task")
                        and self._auto_task
                        and not self._auto_task.done()
                        and asyncio.current_task() is not self._auto_task  # <-- add this line
                ):
                    logger.info(f"Cancelling auto task and setting auto task to None")
                    self._auto_task.cancel()
                    self._auto_task = None

                # Freeze UI
                logger.info(f"Freezing the UI")
                for item in self.children:
                    if isinstance(item, (discord.ui.Select, discord.ui.Button)):
                        item.disabled = True

            # Tally votes
            current_sets = self.parent.game_map_inverse.get(self.game_id, (set(), set()))
            current_player_ids = current_sets[0] | current_sets[1]

            tally_in: dict[str, int] = {}
            tally_spec: dict[str, int] = {}

            for user_id, choice in self.votes_by_user.items():
                if user_id in current_player_ids:
                    tally_in[choice] = tally_in.get(choice, 0) + 1
                else:
                    tally_spec[choice] = tally_spec.get(choice, 0) + 1

            winner: Optional[str] = None
            reason = ""

            # Determine winner
            if tally_in:
                max_in = max(tally_in.values())
                winners_in = [mode for mode, v in tally_in.items() if v == max_in]

                if len(winners_in) == 1:
                    winner = winners_in[0]
                    reason = f"Winner by {max_in} in-game vote{'s' if max_in != 1 else ''}."
                else:
                    spec_for_tied = {mode: tally_spec.get(mode, 0) for mode in winners_in}
                    max_spec = max(spec_for_tied.values())
                    winners_spec = [mode for mode, v in spec_for_tied.items() if v == max_spec]

                    if max_spec > 0 and len(winners_spec) == 1:
                        winner = winners_spec[0]
                        reason = f"Tie among players resolved by {max_spec} spectator vote{'s' if max_spec != 1 else ''}."
                    else:
                        winner = random.choice(winners_in)
                        reason = f"Tie among players (spectators did not tiebreak) — randomly chose **{winner}**."
            else:
                winner = None
                reason = "No in-game votes — mode unchanged."

            # Apply winning mode
            if winner is not None:
                try:
                    mode_enum = self.mode_name_to_enum[winner]
                    await self.parent.dota_talker.change_lobby_mode(self.game_id, mode_enum)

                    wrapper = self.parent.dota_talker.lobby_clients.get(self.game_id)
                    if wrapper:
                        await wrapper.notify_polling_complete()
                except Exception as e:
                    logger.exception(f"[Game {self.game_id}] Failed to apply mode {winner}: {e}")

            # Build results for embed
            options_in_order = self._options_in_order()

            summary_lines_in = [
                                   f"- {name}: **{tally_in.get(name, 0)}**"
                                   for name in options_in_order if tally_in.get(name, 0) > 0
                               ] or ["*No in-game votes*"]
            summary_in = "\n".join(summary_lines_in)

            # Only show spectators if any actually voted
            spectator_voted = any(v > 0 for v in tally_spec.values())
            summary_spec = ""
            if spectator_voted:
                summary_lines_spec = [
                    f"- {name}: **{tally_spec.get(name, 0)}**"
                    for name in options_in_order if tally_spec.get(name, 0) > 0
                ]
                summary_spec = "\n\n**Spectator votes:**\n" + "\n".join(summary_lines_spec)

            # Update poll embed
            message = self.parent.lobby_messages.get(self.game_id)
            if message:
                logger.info(f"Got the message we're updating")
                embed = message.embeds[0]
                idx = next((i for i, f in enumerate(embed.fields) if f.name.startswith("🗳️ Game Mode Voting")), None)

                result_text = (
                    f"**Poll closed ({'manually' if manual else 'automatically'}).**\n"
                    f"{('Winner: **' + winner + '**' if winner else 'Mode unchanged.')}"
                    f"{(' — ' + reason) if reason else ''}\n\n"
                    f"**In-game votes:**\n{summary_in}"
                    f"{summary_spec}"  # only added if spectators voted
                )

                if idx is not None:
                    embed.set_field_at(
                        idx,
                        name="🗳️ Game Mode Voting — Results",
                        value=result_text,
                        inline=False,
                    )
                else:
                    embed.add_field(
                        name="🗳️ Game Mode Voting — Results",
                        value=result_text,
                        inline=False,
                    )
                await message.edit(embed=embed, view=self)
                logger.info(f"Edited message with results ")

            # --- Reset state for next poll ---
            logger.info(f"Setting started to False, Closed to False, and clearing votes by user")
            self._started = False
            self._closed = False
            self.votes_by_user.clear()

            for item in self.children:
                if isinstance(item, discord.ui.Select):
                    item.disabled = True  # Keep dropdown disabled until next Start
                elif isinstance(item, discord.ui.Button):
                    item.disabled = False  # Re-enable Start/End buttons

            if message:
                logger.info(f"Editing message (with empty contents I think)")
                await message.edit(view=self)

            # --- Notify interaction ---
            if interaction:
                try:
                    if not interaction.response.is_done():
                        await interaction.response.send_message("Poll closed.", ephemeral=True)
                    else:
                        await interaction.followup.send("Poll closed.", ephemeral=True)
                except Exception as e:
                    logger.exception(f"[Game {self.game_id}] Failed to send end-poll response: {e}")

        async def _update_poll_embed(self, interaction: discord.Interaction, transient_notice: str = ""):
            message = self.parent.lobby_messages.get(self.game_id)
            if not message:
                try:
                    await interaction.followup.send("Lobby message not found.", ephemeral=True)
                except Exception:
                    pass
                return

            if not self._started or self._closed:
                try:
                    await interaction.followup.send(transient_notice or "Poll isn’t active.", ephemeral=True)
                except Exception:
                    pass
                return

            # Identify players and spectators
            current_sets = self.parent.game_map_inverse.get(self.game_id, (set(), set()))
            current_player_ids = current_sets[0] | current_sets[1]

            tally_in: dict[str, int] = {}
            tally_spec: dict[str, int] = {}

            for user_id, choice in self.votes_by_user.items():
                if user_id in current_player_ids:
                    tally_in[choice] = tally_in.get(choice, 0) + 1
                else:
                    tally_spec[choice] = tally_spec.get(choice, 0) + 1

            options_in_order = self._options_in_order()

            # Build in-game status
            voted_in = [n for n in options_in_order if tally_in.get(n, 0) > 0]
            top_in = sorted(voted_in, key=lambda n: (-tally_in[n], options_in_order.index(n)))[:3]
            status_in = ", ".join(f"{n} ({tally_in[n]})" for n in top_in) or "No in-game votes yet"

            # Build spectator status **only** if there are spectator votes
            voted_spec = [n for n in options_in_order if tally_spec.get(n, 0) > 0]
            status_spec = None
            if voted_spec:
                top_spec = sorted(voted_spec, key=lambda n: (-tally_spec[n], options_in_order.index(n)))[:3]
                status_spec = ", ".join(f"{n} ({tally_spec[n]})" for n in top_spec)

            embed = message.embeds[0]
            idx = next((i for i, f in enumerate(embed.fields) if f.name.startswith("🗳️ Game Mode Voting")), None)
            if idx is not None:
                base = embed.fields[idx].value.split("\n\n")[0]
                # Build new value
                new_val = f"{base}\n\n**In-game votes:** {status_in}"
                if status_spec is not None:
                    new_val += f"\n**Spectator votes:** {status_spec}"
                embed.set_field_at(idx, name=embed.fields[idx].name, value=new_val, inline=False)
            else:
                # field not found: add new
                new_val = f"**In-game votes:** {status_in}"
                if status_spec is not None:
                    new_val += f"\n**Spectator votes:** {status_spec}"
                embed.add_field(name="🗳️ Game Mode Voting", value=new_val, inline=False)

            await message.edit(embed=embed, view=self)

            try:
                await interaction.followup.send(transient_notice, ephemeral=True)
            except (discord.errors.InteractionResponded, discord.errors.NotFound):
                pass

    async def trigger_gamemode_poll(self, game_id: int):
        """Automatically create and start a game mode poll for a lobby."""
        try:
            message = self.lobby_messages.get(game_id)
            if not message:
                logger.warning(f"[Game {game_id}] No lobby message found — cannot start poll.")
                return

            # Get the wrapper
            wrapper = self.dota_talker.lobby_clients.get(game_id)
            if not wrapper:
                logger.warning(f"[Game {game_id}] No DotaTalker wrapper found — skipping poll trigger.")
                return

            # Prevent duplicates
            if wrapper.polling_done:
                logger.info(f"[Game {game_id}] Poll already finished, skipping.")
                return
            if wrapper.polling_active:
                logger.info(f"[Game {game_id}] Poll already active, skipping duplicate trigger.")
                return

            # Mark it active immediately
            wrapper.polling_active = True

            # Create the poll view
            view = self.GameModePoll(
                parent=self,
                game_id=game_id,
                mode_name_to_enum=self.dota_talker.mode_map,
                duration_sec=60,
                allowed_role="Mod",  # lock to Mod role
            )

            # Attach it to the existing lobby message
            await message.edit(view=view)

            # Start it programmatically
            await view.start_poll()

            logger.info(f"[Game {game_id}] Game mode poll auto-started successfully.")
        except Exception as e:
            logger.exception(f"[Game {game_id}] Failed to trigger game mode poll: {e}")

    def run(self):
        """
        Start the bot using the token loaded from config file.
        Overrides commands.Bot.run for clarity and encapsulation.
        """
        super().run(self.config["BOT_TOKEN"])

    async def _start_tcp_server(self):
        """
        Internal TCP server listening on localhost for SteamID messages.
        Only accepts connections from 127.0.0.1.
        Dispatches 'steam_id_found' event when SteamID received.
        Runs asynchronously alongside bot event loop.
        """

        async def handle(reader, writer):
            addr = writer.get_extra_info("peername")
            if addr[0] != "127.0.0.1":
                logger.debug(f"Blocked non-local request: {addr}")
                writer.close()
                return

            data = await reader.read(1024)
            message = data.decode().strip()
            logger.info(f"steam_id found: {message}")
            self.dispatch("steam_id_found", int(message))
            writer.close()

        self.tcp_server = await asyncio.start_server(
            handle, "127.0.0.1", self.config["pipePort"]
        )
        asyncio.create_task(self.tcp_server.serve_forever())

    def build_game_embed(self, game_id: int, radiant_ids: list[int], dire_ids: list[int], password: str = None) -> discord.Embed:
        """
        Builds a Discord embed showing game info, teams, and ratings.

        Args:
            game_id (int): The game ID.
            radiant_ids (list[int]): List of player Discord IDs on Radiant.
            dire_ids (list[int]): List of player Discord IDs on Dire.
            password (str, optional): Game password to include. Defaults to None.

        Returns:
            discord.Embed: The constructed embed message.
        """
        radiant_ratings = [DB.fetch_rating(pid) for pid in radiant_ids]
        dire_ratings = [DB.fetch_rating(pid) for pid in dire_ids]

        r_radiant = DB.power_mean(radiant_ratings, 5)
        r_dire = DB.power_mean(dire_ratings, 5)

        embed = discord.Embed(
            title=f"<:dota2:1389234828003770458> Gargamel League Game {game_id} <:dota2:1389234828003770458>",
            color=discord.Color.red(),
        )


        embed.add_field(
            name=f"🌞 Radiant ({int(r_radiant)})",
            value="\n".join(
                f"`{rating}`<@{uid}>" for uid, rating in zip(radiant_ids, radiant_ratings)
            ) or "*Empty*",
            inline=True,
        )

        embed.add_field(
            name=f"🌚 Dire ({int(r_dire)})",
            value="\n".join(
                f"`{rating}`<@{uid}>" for uid, rating in zip(dire_ids, dire_ratings)
            ) or "*Empty*",
            inline=True,
        )

        embed.add_field(
            name="Password",
            value=f"{password}",
            inline=False
        )

        return embed

    async def update_queue_status_message(
            self, new_message: bool = False, content=None, readied: set[int] | None = None
    ):
        readied = readied or set()
        """
        Updates or creates the queue status message listing all queued users and their ratings.
        """
        lobby_channel = self.get_channel(int(self.config["LOBBY_CHANNEL_ID"]))
        full_queue = list(self.coordinator.get_queue())  # [(discord_id, rating)]
        queued_ids = {user_id for user_id, _ in full_queue}

        team_size = self.config["TEAM_SIZE"]
        embed = discord.Embed(
            title="🎮 Gargamel League Queue 🎮", color=discord.Color.dark_gold()
        )

        if not full_queue:
            embed.description = "*No Players are currently queueing.*"

            if self.config["DEBUG_MODE"]:
                embed.description += f"\n\n <:BrokenRobot:1394750222940377218>*Gargamel Bot is currently set to DEBUG mode. <:BrokenRobot:1394750222940377218>*"

        else:
            player_lines = "\n".join(
                f"{"✅ " if user_id in readied else ""}<@{user_id}>"
                for user_id, rating in full_queue
            )
            # Add list of Players in General Voice Channel who are not in Queue Here
            # Make new embed underneath the Players in Queue to help see who hasn't clicked the button.
            voice_channel = self.get_channel(int(self.config["GENERAL_V_CHANNEL_ID"]))
            voice_members = voice_channel.members

            not_queued_but_in_general_voice_members = [
                member for member in voice_members if member.id not in queued_ids
            ]

            embed.add_field(
                name=f"**Players in queue ({len(full_queue)}):**",  # invisible character to avoid numbering
                value=player_lines,
                inline=False,
            )

            if not_queued_but_in_general_voice_members:
                not_queued_lines = ", ".join(f"<@{member.id}>" for member in not_queued_but_in_general_voice_members)
                embed.add_field(
                    name=f"**Shamefully in General Channel but not in Queue ({len(not_queued_but_in_general_voice_members)}):**",
                    value=not_queued_lines,
                    inline=False,
                )

            # Check to see if game is about to be launched for status display
            if len(full_queue) >= team_size * 2:
                embed.add_field(
                    name="\u200b",
                    value=f"\n@here Enough players! Game will start in **1 minute** ⏳",
                    inline=False,
                )

        # Allowing custom messages to be added to the queue pane after details
        name = "\u200b"
        value = "\u200b"
        inline = False
        if content:
            if isinstance(content, str):
                value = content
            elif isinstance(content, dict):
                name = content.get("name", "\u200b")
                value = content.get("value", "\u200b")
                inline = content.get("inline", False)  # or whatever default you prefer

            embed.add_field(name=name, value=value, inline=inline)

        view = self.QueueButtonView(parent=self)

        # If the message exists, try to edit it
        try:
            if self.queue_status_msg and not new_message:
                try:
                    await self.queue_status_msg.edit(embed=embed, view=view)
                except discord.HTTPException as e:
                    if e.code == 30046:
                        logger.warning("Too many edits to an old message, replacing.")
                        await self.queue_status_msg.delete()
                        self.queue_status_msg = await lobby_channel.send(embed=embed, view=view)
                    else:
                        raise
            else:
                if self.queue_status_msg:
                    await self.queue_status_msg.delete()
                self.queue_status_msg = await lobby_channel.send(embed=embed, view=view)
        except discord.NotFound:
            # If message was deleted, reset and recreate
            self.queue_status_msg = await lobby_channel.send(embed=embed, view=view)

    async def _mod_decision(
        self,
        interaction: discord.Interaction,
        result: bool,
        notes: str,
        rating: int = 3000,
    ):
        """
        Handle moderator's approval or rejection of assigned registrant.

        Ensures command used in mod channel and mod has an assigned registrant.
        Updates mod_notes and user rating in the database.
        Applies 'Contender' role if approval threshold reached.
        Notifies user if rejected by enough mods.

        Args:
            interaction (discord.Interaction): Interaction invoking the command.
            result (bool): True for approval, False for rejection.
            notes (str): Moderator notes on the decision.
            rating (int, optional): Player rating to set on approval. Defaults to 3000.
        """
        mod_id = interaction.user.id
        chan_id = int(self.config["MOD_CHANNEL_ID"])
        if interaction.channel_id != chan_id:
            return await interaction.response.send_message(
                f"<@{mod_id}>: please use <#{chan_id}>", ephemeral=True
            )

        registrant_id = DB.fetch_one(
            "SELECT assignedRegistrant FROM users WHERE discord_id = ?", (mod_id,)
        )

        if not registrant_id:
            return await interaction.response.send_message(
                f"<@{mod_id}>: no registrant assigned. Use /poll_registration.",
                ephemeral=True,
            )

        DB.execute(
            """
            UPDATE mod_notes
            SET notes = ?, result = ?, resultMessage_id = ?
            WHERE mod_id = ? AND registrant_id = ?
            """,
            (notes, int(result), interaction.id, mod_id, registrant_id),
        )

        DB.execute(
            "UPDATE users SET assignedRegistrant = NULL WHERE discord_id = ?",
            (mod_id,),
        )

        DB.execute(
            "UPDATE users SET rating = ? WHERE discord_id = ?", (rating, registrant_id)
        )

        A, D, W = DB.query_mod_results(registrant_id)
        threshold = math.ceil(self.config["MOD_ASSIGNMENT"] / 2)
        try:
            member = await self.the_guild.fetch_member(registrant_id)
        except discord.NotFound:
            member = None
        if member:
            if result and A >= threshold:
                contender = discord.utils.get(self.the_guild.roles, name="Contender")
                await member.add_roles(contender)
                general = self.get_channel(int(self.config["GENERAL_CHANNEL_ID"]))
                await general.send(f"<@{registrant_id}> is now a Contender🎉")
            elif not result and D >= threshold:
                bender = int(self.config["BENDER_ID"])
                await member.send(
                    f"In review for the Gargamel League Server you were flagged by {D} mods. Contact <@{bender}>."
                )

        await interaction.response.send_message(
            "Thanks, moderation recorded.", ephemeral=True
        )

    # ----------------- #
    # Event Listeners   #
    # ----------------- #

    async def _start_game_loop(self, seconds: int):
        """
        Starts a countdown, creates a game, and repeats if enough players remain.
        Only exits when player count drops below threshold.
        """
        try:
            while len(self.coordinator.queue) >= TC.TEAM_SIZE * 2:
                await asyncio.sleep(seconds)

                if len(self.coordinator.queue) < TC.TEAM_SIZE * 2:
                    await self.update_queue_status_message(
                        new_message=True,
                        content="Not enough players anymore. Game cancelled. ❌"
                    )
                    break

                radiant, dire, cut_players = self.coordinator.make_game()
                teams = [radiant, dire]
                random.shuffle(teams)
                radiant, dire = teams

                await self.make_game(radiant, dire, cut_players)

                if len(self.coordinator.queue) >= TC.TEAM_SIZE * 2:
                    await self.update_queue_status_message(
                        content="@here Still enough players! Starting another game in **15 seconds** ⏳"
                    )
                    seconds = 15  # Shorter delay for repeat games
                else:
                    break
        except asyncio.CancelledError:
            pass
        finally:
            self.pending_game_task = None

    async def on_message(self, message: discord.Message):
        # ignore DMs & self
        if message.author == self.user or message.guild is None:
            return

        # keep other channels untouched
        if self.deadleague_channel_id and message.channel.id == self.deadleague_channel_id:
            if self._deadleague_trigger.search(message.content or ""):
                now = discord.utils.utcnow().timestamp()
                if now - self._deadleague_last_ts >= self.deadleague_cooldown:
                    self._deadleague_last_ts = now
                    try:
                        await message.reply(random.choice(self._deadleague_responses), mention_author=False,
                                            suppress_embeds=True)
                    except Exception as e:
                        logger.exception(f"Failed to send Dead League reply: {e}")

        # ensure normal command processing continues
        await self.process_commands(message)

    async def on_ready(self):
        """
        Called when the bot is ready and connected.

        Starts internal TCP server. Caches the primary guild. Registers and syncs all
        slash commands with Discord.

        All slash command handlers are defined as nested async functions here.
        """
        logger.info(f"Logged in as {self.user}")

        self.dota_talker = DotaTalker.DotaTalker(self, asyncio.get_event_loop())
        await self._start_tcp_server()
        self.the_guild = self.guilds[0]

        # Cleanup all messages in the Bot Channel
        lobby_channel = self.get_channel(int(self.config["LOBBY_CHANNEL_ID"]))
        await lobby_channel.purge()

        # Purging any leftover voice channels on boot, moving all members to General.
        await self.clean_up_voice_channels()
        await self.update_queue_status_message(new_message=True)

        # --------------- #
        # Slash Commands  #
        # --------------- #

        @app_commands.command(
            name="poll_registration", description="Assign a registrant for moderation"
        )
        async def poll_registration(interaction: discord.Interaction):
            """
            Assigns the mod who invoked the command a new registrant to moderate.

            Conditions:
            - Command must be used in mod channel.
            - Mod must not already have an assigned registrant pending.
            - Picks registrants with remaining mod reviews and not already reviewed by this mod.

            Args:
                interaction (discord.Interaction): Interaction invoking the command.
            """
            mod_id = interaction.user.id
            chan_id = int(self.config["MOD_CHANNEL_ID"])
            if interaction.channel_id != chan_id:
                return await interaction.response.send_message(
                    f"<@{mod_id}>: please use <#{chan_id}>", ephemeral=True
                )

            prev_registrant_id = DB.fetch_one(
                f"SELECT assignedRegistrant FROM users WHERE discord_id = ?", (mod_id,)
            )
            if prev_registrant_id:
                return await interaction.response.send_message(
                    f"<@{mod_id}>: you already have <@{prev_registrant_id}> assigned. Approve/reject first.",
                    ephemeral=True,
                )

            new_registrant = DB.fetch_one(
                """
                SELECT discord_id FROM users
                WHERE modsRemaining > 0
                AND NOT EXISTS(SELECT 1 FROM mod_notes
                WHERE mod_id = ? AND registrant_id = discord_id)
                ORDER BY dateCreated ASC
                LIMIT 1
                """,
                (mod_id,),
            )
            if not new_registrant:
                return await interaction.response.send_message(
                    f"<@{mod_id}>: no registrants available or all previously moderated.",
                    ephemeral=True,
                )

            DB.execute(
                "UPDATE users SET modsRemaining = modsRemaining - 1 WHERE discord_id = ?",
                (new_registrant,),
            )
            DB.execute(
                "UPDATE users SET assignedRegistrant = ? WHERE discord_id = ?",
                (
                    new_registrant,
                    mod_id,
                ),
            )
            DB.execute(
                "INSERT INTO mod_notes (request_id, mod_id, registrant_id) VALUES (?, ?, ?)",
                (interaction.id, mod_id, new_registrant),
            )
            await interaction.response.send_message(
                f"<@{mod_id}>: assigned <@{new_registrant}>", ephemeral=True
            )

        @app_commands.command(
            name="approve", description="Approve your assigned registrant"
        )
        @app_commands.describe(
            notes="Notes about your decision",
            rating="Player rating (e.g. 3000)",
        )
        async def approve(
            interaction: discord.Interaction, notes: str = "", rating: int = 3000
        ):
            """
            Records an approval decision for the assigned registrant.

            Validates rating as integer; otherwise sends error message.

            Args:
                interaction (discord.Interaction): Interaction invoking the command.
                notes (str, optional): Notes about the decision. Defaults to "".
                rating (int, optional): Player rating. Defaults to None.
            """
            await self._mod_decision(
                interaction, result=True, notes=notes, rating=rating
            )

        @app_commands.command(
            name="reject", description="Reject your assigned registrant"
        )
        @app_commands.describe(notes="Notes about your decision")
        async def reject(interaction: discord.Interaction, notes: str = ""):
            """
            Records a rejection decision for the assigned registrant.

            Args:
                interaction (discord.Interaction): Interaction invoking the command.
                notes (str, optional): Notes about the decision. Defaults to "".
            """
            await self._mod_decision(interaction, notes=notes, result=False)

        @app_commands.command(name="vouch", description="Vouch for a user")
        @app_commands.describe(user="User to vouch for", note="Why do you vouch?")
        async def vouch(
            interaction: discord.Interaction, user: discord.Member, note: str
        ):
            """
            Allows a user to vouch for another user with a note.

            Validates command channel and prevents self-vouching.
            Updates vouch records and increments vouch counts.
            Auto-assigns 'Vouched' role when threshold reached.

            Args:
                interaction (discord.Interaction): Interaction invoking the command.
                user (discord.Member): User to vouch for.
                note (str): Reason for vouching.
            """
            vouch_channel = int(self.config["VOUCH_CHANNEL_ID"])
            if interaction.channel_id != vouch_channel:
                return await interaction.response.send_message(
                    f"<@{interaction.user.id}>: please use <#{vouch_channel}>",
                    ephemeral=True,
                )

            if user.id == interaction.user.id:
                return await interaction.response.send_message(
                    "You can't vouch for yourself!", ephemeral=True
                )

            if not self.exists_in("users", "discord_id = ?", (user.id,)):
                return await interaction.response.send_message(
                    "User hasn't registered the bot yet.", ephemeral=True
                )

            already_vouched = self.exists_in(
                "vouches",
                "voucher_id = ? AND vouchee_id = ?",
                (
                    interaction.user.id,
                    user.id,
                ),
            )
            if already_vouched:
                DB.execute(
                    f"UPDATE vouches SET notes=? WHERE voucher_id={interaction.user.id} AND vouchee_id={user.id}",
                    (note,),
                )
                msg = f"Updated your vouch for {user.mention}."
            else:
                # New vouch
                DB.execute(
                    f"UPDATE users SET timesVouched = timesVouched + 1 WHERE discord_id = {user.id}"
                )
                DB.execute(
                    f"INSERT INTO vouches (vouch_id, vouchee_id, voucher_id, notes) VALUES ({interaction.id}, {user.id}, {interaction.user.id}, ?)",
                    (note,),
                )
                msg = f"Thanks for vouching for {user.mention}."

                # Auto-assign Vouched role if threshold reached
                count = DB.fetch_one(
                    f"SELECT timesVouched FROM users WHERE discord_id = {user.id}"
                )
                if count == self.config["VOUCH_REQUIREMENT"]:
                    vouched_role = discord.utils.get(
                        self.the_guild.roles, name="Vouched"
                    )
                    await user.add_roles(vouched_role)
                    contender = self.get_role(int(self.config["CONTENDER_ROLE_ID"]))
                    if contender not in user.roles:
                        await user.send(
                            "You've been vouched for and granted access to queue. 🎉"
                        )
            await interaction.response.send_message(msg, ephemeral=True)

        @app_commands.command(name="set_rating", description="Set rating for a user")
        @app_commands.describe(user="User", rating="New rating (int)")
        async def set_rating(
            interaction: discord.Interaction, user: discord.Member, rating: int
        ):
            """
            Allows mods to set a player's rating.

            Must be used in mod channel. Validates rating is an integer.

            Args:
                interaction (discord.Interaction): Interaction invoking the command.
                user (discord.Member): User whose rating is being set.
                rating (int): New rating value.
            """
            mod_channel = int(self.config["MOD_CHANNEL_ID"])
            if interaction.channel_id != mod_channel:
                return await interaction.response.send_message(
                    f"Use <#{mod_channel}>", ephemeral=True
                )

            DB.execute(f"UPDATE users SET rating={rating} WHERE discord_id={user.id}")
            await interaction.response.send_message(
                f"Set {user.display_name}'s rating to {rating}.", ephemeral=True
            )

        @app_commands.command(
            name="force_start",
            description="Immediately start a game if enough players are in queue.",
        )
        async def force_start(interaction: discord.Interaction):
            """
            Skips the countdown and starts a game immediately if enough players are in queue.

            Args:
                interaction (discord.Interaction): The command invoker.
            """
            if len(self.coordinator.queue) < TC.TEAM_SIZE * 2:
                return await interaction.response.send_message(
                    "Not enough players to start a game.", ephemeral=True
                )

            # Cancel any ongoing countdown
            if self.pending_game_task and not self.pending_game_task.done():
                self.pending_game_task.cancel()
                self.pending_game_task = None

            await interaction.response.send_message(
                "Force-starting game now!", ephemeral=True
            )

            # Immediately start the loop, with short countdown
            await self.update_queue_status_message(
                content="@here ⚡ Force-start requested — game beginning in **5 seconds**!"
            )
            self.pending_game_task = asyncio.create_task(self._start_game_loop(5))

        @app_commands.command(
            name="force_swap",
            description="Force swap two players between Radiant and Dire",
        )
        async def force_swap(
            interaction: discord.Interaction,
            game_id: int,
            user1: discord.Member,
            user2: discord.Member,
        ):
            """
            Slash command to force-swap two players and update the lobby message.
            """
            await interaction.response.defer(thinking=True)
            success = self.dota_talker.swap_players_in_game(game_id, user1.id, user2.id)

            if not success:
                await interaction.followup.send(
                    f"⚠️ Could not swap <@{user1.id}> and <@{user2.id}>. They may not be on opposite teams."
                )
                return

            # Swap them in internal mapping
            if game_id not in self.game_map_inverse:
                await interaction.followup.send(
                    f"⚠️ Game {game_id} not found in internal records."
                )
                return

            radiant_set, dire_set = self.game_map_inverse[game_id]
            if user1.id in radiant_set and user2.id in dire_set:
                radiant_set.remove(user1.id)
                dire_set.remove(user2.id)
                radiant_set.add(user2.id)
                dire_set.add(user1.id)
            elif user2.id in radiant_set and user1.id in dire_set:
                radiant_set.remove(user2.id)
                dire_set.remove(user1.id)
                radiant_set.add(user1.id)
                dire_set.add(user2.id)
            else:
                await interaction.followup.send(
                    "⚠️ One or both players are not on expected teams internally."
                )
                return

            # Update player->game_id mapping
            self.game_map[user1.id], self.game_map[user2.id] = game_id, game_id

            # Recalculate ratings
            radiant = list(radiant_set)
            dire = list(dire_set)
            # Edit original lobby message
            lobby_msg = self.lobby_messages.get(game_id)

            embed = self.build_game_embed(game_id, radiant, dire, self.dota_talker.get_password(game_id))

            if lobby_msg:
                await lobby_msg.edit(embed=embed)

            await interaction.followup.send(
                f"✅ Swapped <@{user1.id}> and <@{user2.id}> in game {game_id} and updated lobby message."
            )

        @app_commands.command(
            name="cancel_game",
            description="Cancel an active game by ID (or most recent)",
        )
        @app_commands.describe(
            game_id="The ID of the game to cancel (leave blank for most recent)"
        )
        async def cancel_game(interaction: discord.Interaction, game_id: int = None):
            """
            Cancel a currently running but unfinished game.

            Args:
                interaction (discord.Interaction): The slash command context.
                game_id (int, optional): ID of the game to cancel. Defaults to most recent.
            """

            await interaction.response.defer(thinking=True, ephemeral=True)
            # Find the most recent game if no ID provided
            if game_id is None:
                if not self.game_map_inverse:
                    return await interaction.followup.send(
                        "No active games to cancel.", ephemeral=True
                    )
                game_id = max(self.game_map_inverse.keys())

            if game_id not in self.game_map_inverse:
                return await interaction.followup.send(
                    f"No active game with ID {game_id}.", ephemeral=True
                )

            try:
                await self.clear_game(game_id)
            except Exception as e:
                logger.exception(f"[cancel_game] Failed to clear internal game {game_id}")

            # Tearing down steam/dota client for game
            try:
                self.dota_talker.teardown_lobby(game_id)
                logger.info(f"[cancel_game] Torn down Dota client for canceled game {game_id}")
            except Exception:
                logger.exception(f"[cancel_game] Failed to teardown Dota client for game {game_id}")

            await interaction.followup.send(
                f"Game {game_id} has been cancelled. ❌", ephemeral=True
            )

        @app_commands.command(
            name="force_replace",
            description="Force replace a player in an active game.",
        )
        @app_commands.describe(
            game_id="Game ID to modify",
            old_member="Member to remove from the game",
            new_member="Member to add to the game",
        )
        async def force_replace(
            interaction: discord.Interaction,
            game_id: int,
            old_member: discord.Member,
            new_member: discord.Member,
        ):
            """
            Replaces one player with another in an active game.

            Args:
                interaction (discord.Interaction): The command context.
                game_id (int): ID of the game.
                old_member (discord.Member): Player to remove.
                new_member (discord.Member): Player to add.
            """
            await interaction.response.defer(thinking=True)
            success = self.dota_talker.replace_player_in_game(game_id, old_member.id, new_member.id)

            if not success:
                await interaction.followup.send(
                    f"⚠️ Could not replace <@{old_member.id}> with <@{new_member.id}>.",
                    ephemeral=True,
                )
                return

            if game_id not in self.game_map_inverse:
                return await interaction.followup.send(
                    f"No active game with ID {game_id}.", ephemeral=True
                )

            radiant, dire = self.game_map_inverse[game_id]

            if old_member.id not in radiant and old_member.id not in dire:
                return await interaction.followup.send(
                    f"{old_member.display_name} is not in game {game_id}.",
                    ephemeral=True,
                )
            if new_member.id in radiant or new_member.id in dire:
                return await interaction.followup.send(
                    f"{new_member.display_name} is already in game {game_id}.",
                    ephemeral=True,
                )

            radiant_channel, dire_channel = self.game_channels.get(game_id)

            # Update game map structures
            if old_member.id in radiant:
                radiant.remove(old_member.id)
                radiant.add(new_member.id)
                try:
                    await new_member.move_to(radiant_channel)
                except (discord.HTTPException, discord.ClientException):
                    logger.exception(
                        f"[WARN] Couldn't move {new_member.display_name} — not connected to voice."
                    )
            else:
                dire.remove(old_member.id)
                dire.add(new_member.id)
                try:
                    await new_member.move_to(dire_channel)
                except (discord.HTTPException, discord.ClientException):
                    logger.exception(
                        f"[WARN] Couldn't move {new_member.display_name} — not connected to voice."
                    )
            self.game_map.pop(old_member.id, None)
            self.game_map[new_member.id] = game_id

            # Edit original lobby message
            lobby_msg = self.lobby_messages.get(game_id)

            embed = self.build_game_embed(game_id, radiant, dire, self.dota_talker.get_password(game_id))

            if lobby_msg:
                await lobby_msg.edit(embed=embed)

            await interaction.followup.send(
                f"Replaced {old_member.mention} with {new_member.mention} in game {game_id}.",
                ephemeral=True,
            )

            try:
                await old_member.send(f"You've been removed from game {game_id}.")
            except discord.Forbidden:
                pass

        @app_commands.command(name="ping", description="Ping the bot")
        async def ping(interaction: discord.Interaction):
            """
            Simple test command to check if bot is responsive.

            Args:
                interaction (discord.Interaction): Interaction invoking the command.
            """
            await interaction.response.send_message("Pong!")

        @app_commands.command(name="clear_queue", description="Clear out the Game Queue")
        async def clear_queue(interaction: discord.Interaction):
            """
            Clear out the Coordinator's Game queue and update the GUI

            """
            self.coordinator.clear_queue()
            await self.update_queue_status_message()

            return await interaction.response.send_message(
                f"The queue has been cleared.", ephemeral=True
            )

        @app_commands.command(name="remove_from_queue", description="Remove Specific Player from Queue")
        @app_commands.describe(
            user="User to remove from the Queue"
        )
        async def remove_from_queue(
            interaction: discord.Interaction,
            user: discord.User,
        ):
            """
            Clear out the Coordinator's Game queue and update the GUI

            """
            removed = self.coordinator.remove_player(user.id)
            await self.update_queue_status_message()

            if removed:
                await interaction.response.send_message(f"Removed {user.mention} from the queue.", ephemeral=True)
            else:
                await interaction.response.send_message(f"{user.mention} was not in the queue.", ephemeral=True)

        @app_commands.command(name="mmr", description="Check the MMR of a specific player")
        async def check_mmr(
            interaction: discord.Interaction,
            user: discord.User,
        ):
            if interaction and not interaction.response.is_done():
                try:
                    await interaction.response.defer(thinking=True, ephemeral=True)
                except Exception as e:
                    logger.exception(f"Error with interaction response for mmr check for user with error: {e}")
            try:
                mmr = DB.fetch_rating(user.id)
                await interaction.followup.send(
                    f"User: {user} currently has a rating of: {mmr}", ephemeral=True
                )
            except Exception as e:
                logger.exception(f"Error retrieving MMR from database for user: {e}")
                await interaction.followup.send(
                    f"Error retrieving MMR for User: {user}", ephemeral=True
                )

        @app_commands.command(name="restart_bot", description="Restart the Gargamel Coordinator")
        @app_commands.checks.has_role("Mod")
        async def restart_bot(
            interaction: discord.Interaction,
        ):
            if interaction and not interaction.response.is_done():
                try:
                    await interaction.response.defer(thinking=True, ephemeral=True)
                except Exception as e:
                    logger.exception(f"Error restarting Gargamel Coordinator with err: {e}")

            logger.info(f"Received command to Restart Gargamel Coordinator. Terminating instance.")
            await interaction.followup.send(f"Success.  Gargamel Coordinator beginning restart.", ephemeral=True)
            os.system("supervisorctl restart gargamel")

        @app_commands.command(name="set_debug_mode", description="Restart the Gargamel Coordinator")
        @app_commands.checks.has_role("Mod")
        @app_commands.describe(
            debug_mode="True or False"
        )
        async def set_debug_mode(
            interaction: discord.Interaction,
            debug_mode: bool,
        ):
            if interaction and not interaction.response.is_done():
                try:
                    await interaction.response.defer(thinking=True, ephemeral=True)
                except Exception as e:
                    logger.exception(f"Error setting debug mode: {e}")

            with open("config.json", "r") as f:
                config = json.load(f)
                if debug_mode:
                    config["TEAM_SIZE"] = 1
                    config["DEBUG_MODE"] = True
                else:
                    config["TEAM_SIZE"] = 5
                    config["DEBUG_MODE"] = False

                with open("config.json", "w") as file:
                    json.dump(config, file, indent=4)


            logger.info(f"Setting Gargamel Coordinator debug mode to {debug_mode}. Terminating instance.")
            await interaction.followup.send(f"Success.  Gargamel Coordinator debug mode set to {debug_mode}. Restarting Coordinator", ephemeral=True)
            os.system("supervisorctl restart gargamel")

        @app_commands.command(name="scan_for_unfinished_matches", description="Scan the database for unfinished matches and update accordingly")
        @app_commands.checks.has_role("Mod")
        async def scan_for_unfinished_matches(
                interaction: discord.Interaction,
        ):
            if interaction and not interaction.response.is_done():
                try:
                    await interaction.response.defer(thinking=True, ephemeral=True)
                except Exception as e:
                    logger.exception(f"Error scanning for unfinished matches: {e}")
            try:

                unfinished = self.get_unfinished_matches()
                for match in unfinished:
                    logger.info(f"Match found: {match}")
                    all_players = self.get_players_by_match_id(match[0])
                    columns = ["match_id", "discord_id", "steam_id", "rating", "team", "mmr", "role"]
                    players = [dict(zip(columns, p)) for p in all_players]
                    # logger.info(f"Players: {players}")
                    radiant = [p for p in players if p["team"] == 0]
                    dire = [p for p in players if p["team"] == 1]
                    # for player in radiant:
                    #     logging.info(f"Radiant player: {player}")
                    # for player in dire:
                    #     logging.info(f"Dire Player: {player}")
            except Exception as e:
                logger.exception(f"Error scanning for unfinished matches: {e}")



        @app_commands.command(name="update_match_results",
                              description="Update a match and all MMRs of players in the match to the new result historically.")
        @app_commands.checks.has_role("Mod")
        @app_commands.describe(
            winning_team="Radiant or Dire"
        )
        async def update_match_results(
                interaction: discord.Interaction,
                winning_team: str
        ):
            if interaction and not interaction.response.is_done():
                try:
                    await interaction.response.defer(thinking=True, ephemeral=True)
                except Exception as e:
                    logger.exception(f"Error setting debug mode: {e}")



        @restart_bot.error
        @set_debug_mode.error
        @scan_for_unfinished_matches.error
        @update_match_results.error
        async def permissions_error(interaction: discord.Interaction, error):
            if isinstance(error, app_commands.MissingRole):
                await interaction.response.send_message(
                    "You do not have permission to run this command (Mod role required).",
                    ephemeral=True
                )
            else:
                # Re-raise other unexpected errors so they're logged
                raise error

        # Add explicitly
        self.tree.add_command(poll_registration)
        self.tree.add_command(approve)
        self.tree.add_command(reject)
        self.tree.add_command(vouch)
        self.tree.add_command(set_rating)
        self.tree.add_command(force_start)
        self.tree.add_command(force_swap)
        self.tree.add_command(force_replace)
        self.tree.add_command(cancel_game)
        self.tree.add_command(ping)
        self.tree.add_command(clear_queue)
        self.tree.add_command(remove_from_queue)
        self.tree.add_command(check_mmr)
        self.tree.add_command(restart_bot)
        self.tree.add_command(set_debug_mode)
        self.tree.add_command(scan_for_unfinished_matches)
        self.tree.add_command(update_match_results)

        # if not self.config["DEBUG_MODE"]:
        await self.tree.sync()  # Clears global commands from Discord
        await self.tree.sync(guild=self.the_guild)

    async def on_game_started(self, game_id, game_info):

        print(f"Entering on_game_started.")
        match_id = getattr(game_info, "match_id", None)
        lobby_id = getattr(game_info, "lobby_id", None)
        state = getattr(game_info, "state", None)
        game_mode = getattr(game_info, "game_mode", None)
        server_region = getattr(game_info, "server_region", None)
        lobby_type = getattr(game_info, "lobby_type", None)
        league_id = getattr(game_info, "league_id", None)

        logger.info(f"League id: <{league_id}>")

        if game_id not in self.pending_matches:
            logger.debug(f"Ignoring running lobby message for  ID: {lobby_id} - not in pending matches.")
            return

        try:
            # Insert match into DB
            DB.execute(
                """
                INSERT OR IGNORE INTO matches (
                    match_id, lobby_id, state,
                    game_mode, server_region, lobby_type, league_id
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    match_id, lobby_id, state,
                    game_mode, server_region, lobby_type, league_id
                ),
            )

            #Adding players to player_matches
            # Radiant = team 0, Dire = team 1
            radiant_ids, dire_ids = self.game_map_inverse.get(game_id, (set(), set()))
            for discord_id in radiant_ids:
                mmr = DB.fetch_rating(discord_id)
                logger.info(f"Adding Radiant player: discord_id {discord_id} to database for match_id: {match_id} with mmr: {mmr}")
                DB.execute(
                    """
                    INSERT INTO match_players (match_id, discord_id, team, mmr)
                    VALUES (?, ?, ?, ?)
                    """,
                    (match_id, discord_id, 0, mmr)  # 0 = Radiant
                )


            for discord_id in dire_ids:
                mmr = DB.fetch_rating(discord_id)
                logger.info(
                    f"Adding Dire player: discord_id {discord_id} to database for match_id: {match_id} with mmr: {mmr}")
                DB.execute(
                    """
                    INSERT INTO match_players (match_id, discord_id, team, mmr)
                    VALUES (?, ?, ?, ?)
                    """,
                    (match_id, discord_id, 1, mmr)  # 0 = Radiant
                )

            self.pending_matches.remove(game_id)
            logger.info(f"Logged into Database game with game_id: {game_id} , match_id: {match_id}, lobby_id: {lobby_id}")

            # TODO Add players involved with all their details to match_players

        except Exception as e:
            logger.exception(f"Failed to add new game to DB with error: {e}")

    async def on_game_ended(self, game_id: int, game_info):
        """
        Cleanup after a game ends and update ratings.

        Uses geometric mean team ELOs and standard ELO formula for player updates.

        Args:
            game_id (int): Identifier for the ended game.
            game_info: Object containing all game information
        """
        try:
            logger.info(f"Entered on game ended")
            radiant, dire = self.game_map_inverse[game_id]

            await self.clear_game(game_id)

            # Retrieve player ratings
            radiant_ratings = [DB.fetch_rating(id) for id in radiant]
            dire_ratings = [DB.fetch_rating(id) for id in dire]

            # Calculate means
            r_radiant = DB.power_mean(radiant_ratings, 5)
            r_dire = DB.power_mean(dire_ratings, 5)

            # Determine results
            s_radiant = 1 if game_info.match_outcome == 2 else 0
            s_dire = 1 - s_radiant

            # ELO expected scores
            e_radiant = 1 / (1 + 10 ** ((r_dire - r_radiant) / 3322))
            e_dire = 1 - e_radiant

            k = self.config.get("ELO_K")  # Use config or default

            # Update radiant ratings
            for i, pid in enumerate(radiant):
                new_rating = round(radiant_ratings[i] + k * (s_radiant - e_radiant))
                DB.execute(
                    "UPDATE users SET rating = ? WHERE discord_id = ?", (new_rating, pid)
                )

            # Update dire ratings
            for i, pid in enumerate(dire):
                new_rating = round(dire_ratings[i] + k * (s_dire - e_dire))
                DB.execute(
                    "UPDATE users SET rating = ? WHERE discord_id = ?", (new_rating, pid)
                )

            # Adding cute little emoji reaction to match card for the winner
            try:
                lobby_msg = self.lobby_messages.get(game_id)
                if s_radiant:
                    await lobby_msg.add_reaction("🌞")
                else:
                    await lobby_msg.add_reaction("🌚")
            except Exception as e:
                logger.exception(f"Failed to react to lobby message with winner with error: {e}")

        except Exception as e:
            logger.exception(f"Error updating users table with ratings with err: {e}")


        try:
            # Update match with game state POSTGAME and Winner details
            logger.info(f"Logging match results in DB for match_id {game_info.match_id} with winner: {game_info.match_outcome} and game_state: {game_info.game_state}")
            DB.execute("""
                UPDATE matches
                SET winning_team = ?, state = ?
                WHERE match_id = ?
            """, (game_info.match_outcome, game_info.game_state, game_info.match_id))
            logger.info(f"Post results add")
        except Exception as e:
            logger.exception(f"Error updating matches table with err: {e}")

        # Teardown Steam/Dota client for this match
        try:
            self.dota_talker.teardown_lobby(game_id)
            logger.info(f"[on_game_ended] Torn down Dota client for game {game_id}")
        except Exception:
            logger.exception(f"[on_game_ended] Failed to teardown Dota client for game {game_id}")


    async def clear_game(self, game_id: int):
        """
        Clears an active game and clean up all related state.

        Args:
            game_id (int): The ID of the game to cancel.
        """
        try:
            radiant, dire = self.game_map_inverse[game_id]
            del self.game_map_inverse[game_id]

            for player in radiant:
                del self.game_map[player]
            for player in dire:
                del self.game_map[player]

            players = self.game_map_inverse.get(game_id, set())
            self.game_map_inverse.pop(game_id, None)

            for player in players:
                self.game_map.pop(player, None)

            radiant_channel, dire_channel = self.game_channels.pop(game_id)

            target_channel = self.get_channel(int(self.config["GENERAL_V_CHANNEL_ID"]))
            all_members = radiant_channel.members + dire_channel.members
            move_tasks = []
            for member in all_members:
                logger.info(
                    f"[Game {game_id}] {member.display_name} | ID: {member.id} | Voice: {member.voice.channel.name if member.voice else 'Not in Voice'}")
                if not member.voice or not member.voice.channel:
                    continue
                if member.voice.channel.id == target_channel.id:
                    continue

                try:
                    move_tasks.append(member.move_to(target_channel))
                except Exception as e:
                    logger.exception(f"Failed to move {member.display_name} to {target_channel.name}: {e}")

            await asyncio.gather(*move_tasks, return_exceptions=True)
            await asyncio.gather(
                radiant_channel.delete(),
                dire_channel.delete(),
                return_exceptions=True
            )

        except Exception as e:
            logger.exception(f"[Game {game_id}] Error clearing game: ", e)


    async def on_steam_id_found(self, discord_id: int):
        """
        Event triggered when SteamID is received from the TCP server.

        Adds Steam friends to all Dota clients.
        Notifies mod channel if user has remaining mods to complete.

        Args:
            discord_id (int): Discord user ID for which SteamID was found.
        """
        steam_id = DB.fetch_steam_id(discord_id)
        for dotaClient in self.dota_talker.dotaClients:
            dotaClient.steam.friends.add(steam_id)

        modsRemaining = DB.fetch_one(
            f"SELECT modsRemaining FROM users WHERE discord_id = {discord_id}"
        )

        if modsRemaining > 0:
            mod_chan = self.get_channel(int(self.config["MOD_CHANNEL_ID"]))
            await mod_chan.send(f"<@{discord_id}> joined registration queue!")

    def get_players_by_match_id(self, match_id: int):
        """
        Retrieve all players (and their user info) for a given match_id.

        Args:
            match_id (int): The match ID to look up.

        Returns:
            list[tuple]: All rows of players with their joined user data.
        """
        query = """
            SELECT
                mp.match_id,
                mp.discord_id,
                u.steam_id,
                u.rating,
                mp.team,
                mp.mmr,
                mp.role
            FROM match_players AS mp
            JOIN users AS u ON mp.discord_id = u.discord_id
            WHERE mp.match_id = ?;
        """
        return DB.fetch_all(query, (match_id,))

    def get_unfinished_matches(self) -> list[tuple]:
        query = "SELECT * FROM matches WHERE winning_team IS NULL;"
        return DB.fetch_all(query)

    def get_next_game_id(self):
        try:
            DB.execute("UPDATE game_counter SET counter = counter + 1 WHERE id = 1")
            next_game_id = DB.fetch_one("SELECT counter FROM game_counter WHERE id = 1")
            return next_game_id
        except Exception as e:
            logger.exception(f"Error getting next game id: {e}")

    async def make_game(self, radiant, dire, cut_players):
        """
        Called when a new game is created.

        Creates voice channels for Radiant and Dire teams.
        Assigns channel permissions for players.
        Sends match details and lobby password in lobby text channel.
        Maintains internal mappings of players and game channels.

        Note:
            Movement of players to voice channels is currently commented out.

        Args:
            radiant (list[int]): List of Discord IDs for Radiant team players.
            dire (list[int]): List of Discord IDs for Dire team players.
        """
        # Create a temporary game ID

        game_id = self.get_next_game_id()
        self.pending_matches.add(game_id)

        create_tasks = [
            self.the_guild.create_voice_channel(f"Game {game_id} — Radiant"),
            self.the_guild.create_voice_channel(f"Game {game_id} — Dire")
        ]

        radiant_channel, dire_channel = await asyncio.gather(*create_tasks)

        self.game_map_inverse[game_id] = (set(), set())

        send_tasks = []
        for member_id in radiant:
            m = self.the_guild.get_member(member_id)

            if m:
                async def send_message(member=m, channel_id=radiant_channel.id):
                    try:
                        await member.send(
                            f"You were placed in a match! Join your channel: <#{channel_id}> Enjoy 🎮"
                        )
                    except Exception as e:
                        logger.exception(f"Tried to send a message to {member.name} but failed with exception: {e}")

                send_tasks.append(send_message())
                self.game_map[member_id] = game_id
                self.game_map_inverse[game_id][0].add(member_id)
        for member_id in dire:
            m = self.the_guild.get_member(member_id)
            if m:
                async def send_message(member=m, channel_id=dire_channel.id):
                    try:
                        await member.send(
                            f"You were placed in a match! Join your channel: <#{channel_id}> Enjoy 🎮"
                        )
                    except Exception as e:
                        logger.exception(f"Tried to send a message to {member.name} but failed with exception: {e}")

                send_tasks.append(send_message())
                self.game_map[member_id] = game_id
                self.game_map_inverse[game_id][1].add(member_id)

        for member_id in cut_players:
            m = self.the_guild.get_member(member_id)
            if m:
                async def send_message(member=m, channel_id=radiant_channel.id):
                    try:
                        await member.send(
                            f"You queued for a Gargamel game, but were put in the cuck chair until next game. 🪑 Your priority has been increased, "
                            f"and if you remain in the queue your chances of joining the next game are higher. "
                        )
                    except Exception as e:
                        logger.exception(f"Tried to send a message to {member.name} but failed with exception: {e}")

                send_tasks.append(send_message())
                self.game_map[member_id] = game_id
                self.game_map_inverse[game_id][1].add(member_id)

        await asyncio.gather(*send_tasks)

        self.game_channels[game_id] = (radiant_channel, dire_channel)

        password = await self.dota_talker.make_game(game_id, radiant, dire)

        embed = self.build_game_embed(game_id, radiant, dire, password)

        channel = self.get_channel(int(self.config["MATCH_CHANNEL_ID"]))

        view = self.GameModePoll(
            parent=self,
            game_id=game_id,
            mode_name_to_enum=self.dota_talker.mode_map,
            duration_sec=60,
            allowed_role="Mod",
        )
        message = await channel.send(embed=embed, view=view)

        try:
            tasks = [
                self.the_guild.get_member(member).move_to(radiant_channel)
                for member in radiant
                if self.the_guild.get_member(member) and self.the_guild.get_member(member).voice
            ] + [
                self.the_guild.get_member(member).move_to(dire_channel)
                for member in dire
                if self.the_guild.get_member(member) and self.the_guild.get_member(member).voice
            ]
            await asyncio.gather(*tasks)
        except Exception as e:
            logger.exception(f"Unexpected Exception: {e}")

        self.lobby_messages[game_id] = message
        if cut_players:
            content = {
                "name": f"** 🪑 Players who got put in the cuck chair last game (Selection Priority Increased for next game): 🪑**",
                "value": "\n".join(f"<@{user_id}>" for user_id in cut_players),
            }
            await self.update_queue_status_message(content=content)
        else:
            await self.update_queue_status_message()


# Run the bot
if __name__ == "__main__":
    bot = Master_Bot()
    signal.signal(signal.SIGINT, bot.handle_exit_signals)
    signal.signal(signal.SIGTERM, bot.handle_exit_signals)
    bot.run()

