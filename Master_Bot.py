# main_bot.py
from typing import Tuple
import DotaTalker
import TheCoordinator as TC
import json
import math
import sqlite3
import asyncio
import discord
from discord import app_commands
from discord.ext import commands
import random
import signal

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
        self.pending_matches_lock = threading.Lock()

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

        # Clean up Discord Voice and Text Channels, Clear the Bot Channel
        # TODO: Clean up Dota Lobbies that are empty if we bailed at the wrong time.
        loop = asyncio.get_event_loop()

        async def shutdown_sequence():
            try:
                await self.clean_up_on_exit_helper()
            except Exception as e:
                logger.exception(f"Cleanup failed with exception: {e}")

        loop.create_task(shutdown_sequence())

    async def clean_up_on_exit_helper(self):
        # Cleaning up channels is async, but signal catcher requires sync, setting up a job to
        # clean them up and just assume it's fine.
        general_channel = self.get_channel(int(self.config["GENERAL_V_CHANNEL_ID"]))

        move_tasks = []
        delete_tasks = []

        for channel in self.the_guild.voice_channels:
            if channel.name.startswith("Game"):
                # Queue up move tasks for all members in the Game channel
                for member in channel.members:
                    if member.voice and member.voice.channel == channel:
                        move_tasks.append(member.move_to(general_channel))

                # Queue up deletion of the Game channel
                delete_tasks.append(channel.delete())

        lobby_channel = self.get_channel(int(self.config["LOBBY_CHANNEL_ID"]))

        if move_tasks:
            await asyncio.gather(*move_tasks, return_exceptions=True)

        if lobby_channel:
            purge_task = self.get_channel(int(self.config["LOBBY_CHANNEL_ID"])).purge(
                limit=100
            )

            await asyncio.gather(*delete_tasks, purge_task, return_exceptions=True)

        else:
            await asyncio.gather(*delete_tasks, return_exceptions=True)

        if hasattr(bot, "tcp_server") and bot.tcp_server:
            bot.tcp_server.close()
            await bot.tcp_server.wait_closed()

        await self.close()

        pending = [t for t in asyncio.all_tasks() if not t.done()]
        logger.debug(f"🔍 Pending tasks after self.close: {len(pending)}")

        for task in pending:
            logger.debug(f" - {task}")

    async def queue_user(self, interaction: discord.Interaction, respond=True):

        if self.coordinator.in_queue(interaction.user.id):
            await interaction.response.send_message(
                "You're already in the queue, bozo.", ephemeral=True
            )
            return False

        rating = DB.fetch_rating(interaction.user.id)
        if not rating:
            logger.info(f"User with ID: {interaction.user.id} doesn't have a rating")
            await interaction.response.send_message(
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

                self.pending_game_task = asyncio.create_task(
                    self._start_game_loop(start_game_timer)
                )

        # Slash command requires a response for success
        if respond and not interaction.response.is_done():
            await interaction.response.send_message(
                f"You're now queueing with rating {rating}.", ephemeral=True
            )

        return True  # success

    async def leave_queue(self, interaction: discord.Interaction, respond=True):
        if not self.coordinator.in_queue(interaction.user.id):
            await interaction.response.send_message(
                "You're not in the queue, bozo, how are you gonna leave?",
                ephemeral=True,
            )
            return False
        self.coordinator.remove_player(interaction.user.id)
        await interaction.response.send_message(
            "You have left the queue.", ephemeral=True
        )
        await self.update_queue_status_message()

    async def start_ready_check(self, interaction: discord.Interaction):
        logger.info("Initiated ready check")
        queue_members = self.coordinator.queue.keys()
        confirmed = set()
        timed_out = set()
        removed = set()
        message_tasks = []

        for user_id in queue_members:
            member = interaction.guild.get_member(user_id)
            if not member:
                logger.warning(
                    f"Tried to get ready check confirmation from user {user_id}, but it seems they're no longer in the server"
                )
                timed_out.add(user_id)
                continue

            def make_view(user_id):
                view = discord.ui.View(timeout=60)

                async def confirm_callback(inner_interaction: discord.Interaction):
                    await inner_interaction.response.send_message("Marked ready!", ephemeral=True)
                    logger.info(f"Ready check confirmation from {inner_interaction.user.name}: ready")
                    confirmed.add(user_id)
                    self.update_queue_status_message(content=f"Ready check in progress", readied=confirmed)
                    await inner_interaction.message.delete()

                async def reject_callback(inner_interaction: discord.Interaction):
                    await inner_interaction.response.send_message("Removing from queue!", ephemeral=True)
                    self.coordinator.remove_player(user_id)
                    logger.info(f"Ready check confirmation from {inner_interaction.user.name}: remove")
                    removed.add(user_id)
                    self.update_queue_status_message(content=f"Ready check in progress", readied=confirmed)
                    await inner_interaction.message.delete()

                confirm_button = discord.ui.Button(label="✅ I'm Ready!", style=discord.ButtonStyle.primary)
                reject_button = discord.ui.Button(label="❌ I'm out", style=discord.ButtonStyle.danger)

                confirm_button.callback = confirm_callback
                reject_button.callback = reject_callback

                view.add_item(confirm_button)
                view.add_item(reject_button)

                return view
            
            view = make_view(user_id)

            async def send_message():
                try:
                    await member.send(
                        "Are you still ready to play? Click below:", view=view
                    )
                except discord.Forbidden:
                    await interaction.followup.send(
                        f"Couldn't DM <@{user_id}>. Assuming not ready."
                    )
            message_tasks.append(send_message())

        await asyncio.gather(*message_tasks)
        await asyncio.sleep(60)

        to_remove = queue_members - (confirmed | removed)

        for user_id in to_remove:
            self.coordinator.remove_player(user_id)

        await interaction.followup.send(
            f"Ready check complete. {len(confirmed)} confirmed, {len(to_remove)} removed from queue."
        )

    # GUI Views
    class QueueButtonView(discord.ui.View):
        def __init__(self, parent: "Master_Bot"):
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

        @discord.ui.button(label="✅ Ready Check", style=discord.ButtonStyle.success)
        async def ready_check(
            self, interaction: discord.Interaction, button: discord.ui.Button
        ):
            await self.parent.start_ready_check(interaction)

    class GameModePoll(discord.ui.View):
        def __init__(self, parent: "Master_Bot", game_id: int):
            super().__init__(timeout=None)
            self.parent = parent
            self.game_id = game_id
            self.voted: bool = False  # avoid multiple clicks for same message

        @discord.ui.button(label="Game Mode Poll", style=discord.ButtonStyle.primary)
        async def start_poll(
            self, interaction: discord.Interaction, button: discord.ui.Button
        ):
            if self.voted:
                await interaction.response.send_message(
                    "Vote already initiated!", ephemeral=True
                )
                return

            self.voted = True
            message = self.parent.lobby_messages.get(self.game_id)
            if not message:
                await interaction.response.send_message(
                    "Lobby message not found.", ephemeral=True
                )
                logging.error(
                    f"Someone tried to initiate a game mode poll, but the match listing doesn't exist"
                )
                return

            embed = message.embeds[0]
            embed.add_field(
                name="🗳️ Game Mode Voting",
                value="React below to vote:\n📈 Ranked All Pick\n👑 Captains Mode\n3️⃣ Single Draft\n🎲 All random\n\nIn **1 minute** the most voted option will be made the game mode.",
                inline=False,
            )

            await message.edit(embed=embed)
            await interaction.response.send_message("Voting started!", ephemeral=True)

            emojis = DB.mode_map.keys()
            tasks = [message.add_reaction(emoji) for emoji in emojis]
            await asyncio.gather(*tasks)
            asyncio.create_task(self.reviewPoll())

        async def reviewPoll(self):
            asyncio.sleep(60)
            message = self.parent.lobby_messages.get(self.game_id)

            emojis = DB.mode_map.keys()
            votes = dict()
            for emoji in emojis:
                votes[emoji] = 0

            for reaction in message.reactions:
                emoji = str(reaction.emoji)

                if emoji in emojis:
                    votes[emoji] += 1

            mode = max(votes.items(), key=lambda x: x[1])[0]

            self.parent.dota_talker.change_lobby_mode(
                self.game_id, DB.mode_map_enum.get(mode)
            )

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

    def build_game_embed(
        self,
        game_id: int,
        radiant_ids: list[int],
        dire_ids: list[int],
        password: str = None,
    ) -> discord.Embed:
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
                f"`{rating}`<@{uid}>"
                for uid, rating in zip(radiant_ids, radiant_ratings)
            )
            or "*Empty*",
            inline=True,
        )

        embed.add_field(
            name=f"🌚 Dire ({int(r_dire)})",
            value="\n".join(
                f"`{rating}`<@{uid}>" for uid, rating in zip(dire_ids, dire_ratings)
            )
            or "*Empty*",
            inline=True,
        )

        embed.add_field(name="Password", value=f"{password}", inline=False)

        return embed

    async def update_queue_status_message(
        self, new_message: bool = False, content=None, readied: set[int] = []
    ):
        """
        Updates or creates the queue status message listing all queued users and their ratings.
        """
        lobby_channel = self.get_channel(int(self.config["LOBBY_CHANNEL_ID"]))
        queue = list(self.coordinator.get_queue())  # [(discord_id, rating)]
        queued_ids = {user_id for user_id, _ in queue}

        team_size = self.config["TEAM_SIZE"]
        embed = discord.Embed(
            title="🎮 Gargamel League Queue 🎮", color=discord.Color.dark_gold()
        )

        if not queue:
            embed.description = "*No Players are currently queueing.*"

            if self.config["DEBUG_MODE"]:
                embed.description += f"\n\n <:BrokenRobot:1394750222940377218>*Gargamel Bot is currently set to DEBUG mode. <:BrokenRobot:1394750222940377218>*"

        else:
            player_lines = "\n".join(f"{"✅ " if user_id in readied else ""}<@{user_id}>" for user_id, rating in queue)

            # Add list of Players in General Voice Channel who are not in Queue Here
            # Make new embed underneath the Players in Queue to help see who hasn't clicked the button.
            voice_channel = self.get_channel(int(self.config["GENERAL_V_CHANNEL_ID"]))
            voice_members = voice_channel.members

            not_queued_but_in_general_voice_members = [
                member for member in voice_members if member.id not in queued_ids
            ]

            embed.add_field(
                name=f"**Players in queue ({len(queue)}):**",  # invisible character to avoid numbering
                value=player_lines,
                inline=False,
            )

            if not_queued_but_in_general_voice_members:
                not_queued_lines = ", ".join(
                    f"<@{member.id}>"
                    for member in not_queued_but_in_general_voice_members
                )
                embed.add_field(
                    name=f"**Shamefully in General Channel but not in Queue ({len(not_queued_but_in_general_voice_members)}):**",
                    value=not_queued_lines,
                    inline=False,
                )

            # Check to see if game is about to be launched for status display
            if len(queue) >= team_size * 2:
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
                await self.queue_status_msg.edit(embed=embed, view=view)
            else:
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

        await self.update_queue_status_message()

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

            embed = self.build_game_embed(
                game_id, radiant, dire, self.dota_talker.get_password(game_id)
            )

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
            # Find the most recent game if no ID provided
            if game_id is None:
                if not self.game_map_inverse:
                    return await interaction.response.send_message(
                        "No active games to cancel.", ephemeral=True
                    )
                game_id = max(self.game_map_inverse.keys())

            if game_id not in self.game_map_inverse:
                return await interaction.response.send_message(
                    f"No active game with ID {game_id}.", ephemeral=True
                )

            response = self.dota_talker.cancel_game(game_id)

            await self.clear_game(game_id)
            if response:
                await interaction.response.send_message(
                    f"Game {game_id} has been cancelled. ❌", ephemeral=True
                )
            else:
                await interaction.response.send_message(
                    f"Attempted to cancel game {game_id}, but there may be a problem.",
                    ephemeral=True,
                )
                mod_chan = self.get_channel(int(self.config["MOD_CHANNEL_ID"]))
                await mod_chan.send(
                    f"Attempted to cancel game {game_id}, but there may be a problem."
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
            if game_id not in self.game_map_inverse:
                return await interaction.response.send_message(
                    f"No active game with ID {game_id}.", ephemeral=True
                )

            radiant, dire = self.game_map_inverse[game_id]

            if old_member.id not in radiant and old_member.id not in dire:
                return await interaction.response.send_message(
                    f"{old_member.display_name} is not in game {game_id}.",
                    ephemeral=True,
                )
            if new_member.id in radiant or new_member.id in dire:
                return await interaction.response.send_message(
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

            await interaction.response.send_message(
                f"Replaced {old_member.mention} with {new_member.mention} in game {game_id}.",
                ephemeral=True,
            )

            try:
                await old_member.send(f"You've been removed from game {game_id}.")
            except discord.Forbidden:
                pass

            radiant_steam_ids = [DB.fetch_steam_id(id) for id in radiant]
            dire_steam_ids = [DB.fetch_steam_id(id) for id in dire]
            self.dota_talker.update_lobby_teams(
                game_id, radiant_steam_ids, dire_steam_ids
            )

        @app_commands.command(name="ping", description="Ping the bot")
        async def ping(interaction: discord.Interaction):
            """
            Simple test command to check if bot is responsive.

            Args:
                interaction (discord.Interaction): Interaction invoking the command.
            """
            await interaction.response.send_message("Pong!")

        @app_commands.command(
            name="clear_queue", description="Clear out the Game Queue"
        )
        async def clear_queue(interaction: discord.Interaction):
            """
            Clear out the Coordinator's Game queue and update the GUI

            """
            self.coordinator.clear_queue()
            await self.update_queue_status_message(content=f"Queue cleared - @here requeue if desired")

            return await interaction.response.send_message(
                f"The queue has been cleared.", ephemeral=True
            )

        @app_commands.command(
            name="remove_from_queue", description="Remove Specific Player from Queue"
        )
        @app_commands.describe(user="User to remove from the Queue")
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
                await interaction.response.send_message(
                    f"Removed {user.mention} from the queue.", ephemeral=True
                )
            else:
                await interaction.response.send_message(
                    f"{user.mention} was not in the queue.", ephemeral=True
                )

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

        if not self.config["DEBUG_MODE"]:
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

        with self.pending_matches_lock:
            if game_id not in self.pending_matches:
                logger.debug(f"Ignoring game {game_id}, not in pending_matches")
                return
            self.pending_matches.remove(game_id)

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
                    match_id,
                    lobby_id,
                    state,
                    game_mode,
                    server_region,
                    lobby_type,
                    league_id,
                ),
            )

            # Adding players to player_matches
            # Radiant = team 0, Dire = team 1
            radiant_ids, dire_ids = self.game_map_inverse.get(game_id, (set(), set()))
            for discord_id in radiant_ids:
                mmr = DB.fetch_rating(discord_id)
                logging.info(
                    f"Adding Radiant player: discord_id {discord_id} to database for match_id: {match_id} with mmr: {mmr}"
                )
                DB.execute(
                    """
                    INSERT INTO match_players (match_id, discord_id, team, mmr)
                    VALUES (?, ?, ?, ?)
                    """,
                    (match_id, discord_id, 0, mmr),  # 0 = Radiant
                )

            for discord_id in dire_ids:
                mmr = DB.fetch_rating(discord_id)
                logging.info(
                    f"Adding Dire player: discord_id {discord_id} to database for match_id: {match_id} with mmr: {mmr}"
                )
                DB.execute(
                    """
                    INSERT INTO match_players (match_id, discord_id, team, mmr)
                    VALUES (?, ?, ?, ?)
                    """,
                    (match_id, discord_id, 1, mmr),  # 1 = Dire
                )

            self.pending_matches.remove(game_id)
            logger.info(
                f"Logged into Database game with game_id: {game_id} , match_id: {match_id}, lobby_id: {lobby_id}"
            )

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
            logging.info(f"Entered on game ended")
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
                    "UPDATE users SET rating = ? WHERE discord_id = ?",
                    (new_rating, pid),
                )

            # Update dire ratings
            for i, pid in enumerate(dire):
                new_rating = round(dire_ratings[i] + k * (s_dire - e_dire))
                DB.execute(
                    "UPDATE users SET rating = ? WHERE discord_id = ?",
                    (new_rating, pid),
                )
        except Exception as e:
            logging.exception(f"Error updating users table with ratings with err: {e}")

        try:
            # Update match with game state POSTGAME and Winner details
            logging.info(
                f"Logging match results in DB for match_id {game_info.match_id} with winner: {game_info.match_outcome} and game_state: {game_info.game_state}"
            )
            DB.execute(
                """
                UPDATE matches
                SET winning_team = ?, state = ?
                WHERE match_id = ?
            """,
                (game_info.match_outcome, game_info.game_state, game_info.match_id),
            )
            logging.info(f"Post results add")
        except Exception as e:
            logger.exception(f"Error updating matches table with err: {e}")

    async def clear_game(self, game_id: int):
        """
        Clears an active game and clean up all related state.

        Args:
            game_id (int): The ID of the game to cancel.
        """

        radiant, dire = self.game_map_inverse[game_id]
        del self.game_map_inverse[game_id]

        players = radiant | dire

        for player in players:
            del self.game_map[player]

        radiant_channel, dire_channel = self.game_channels.pop(game_id)
        try:
            target_channel = self.get_channel(int(self.config["GENERAL_V_CHANNEL_ID"]))
            all_members = radiant_channel.members + dire_channel.members
            for member in all_members:
                logger.info(
                    f"{member.display_name} | ID: {member.id} | Voice: {member.voice.channel.name if member.voice else 'Not in Voice'}"
                )
            move_tasks = [
                member.move_to(target_channel)
                for member in all_members
                if member.voice and member.voice.channel != target_channel
            ]

            await asyncio.gather(*move_tasks)
            await asyncio.gather(radiant_channel.delete(), dire_channel.delete())

        except Exception as _:
            logger.exception(f"Unexpected Exception: ")

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

    def get_next_game_id(self):
        try:
            DB.execute("UPDATE game_counter SET counter = counter + 1 WHERE id = 1")
            next_game_id = DB.fetch_one("SELECT counter FROM game_counter WHERE id = 1")
            return next_game_id
        except Exception as e:
            logging.exception(f"Error getting next game id: {e}")

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

        password = self.dota_talker.make_game(game_id, radiant, dire)
        if password == "-1":
            logger.error(f"Failed to create lobby for game {game_id}")
            await self.update_queue_status_message(
                content=f"⚠️ Could not create game {game_id}: all servers busy. Players kept in queue."
            )

            # Re-queue players
            for member_id in radiant + dire:
                rating = DB.fetch_rating(member_id)
                self.coordinator.add_player(member_id, rating)

            mod_channel = self.get_channel(int(self.config["MOD_CHANNEL_ID"]))
            await mod_channel.send(
                f"🚨 All Dota clients are busy. Game {game_id} could not be created. Consider restarting clients."
            )
            return

        self.pending_matches.add(game_id)

        create_tasks = [
            self.the_guild.create_voice_channel(f"Game {game_id} — Radiant"),
            self.the_guild.create_voice_channel(f"Game {game_id} — Dire"),
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
                        logger.exception(
                            f"Tried to send a message to {member.name} but failed with exception: {e}"
                        )

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
                        logger.exception(
                            f"Tried to send a message to {member.name} but failed with exception: {e}"
                        )

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
                        logger.exception(
                            f"Tried to send a message to {member.name} but failed with exception: {e}"
                        )

                send_tasks.append(send_message())
                self.game_map[member_id] = game_id
                self.game_map_inverse[game_id][1].add(member_id)

        await asyncio.gather(*send_tasks)

        self.game_channels[game_id] = (radiant_channel, dire_channel)

        embed = self.build_game_embed(game_id, radiant, dire, password)

        channel = self.get_channel(int(self.config["MATCH_CHANNEL_ID"]))
        view = self.GameModePoll(self, game_id)
        message = await channel.send(embed=embed, view=view)

        try:
            tasks = [
                self.the_guild.get_member(member).move_to(radiant_channel)
                for member in radiant
                if self.the_guild.get_member(member)
                and self.the_guild.get_member(member).voice
            ] + [
                self.the_guild.get_member(member).move_to(dire_channel)
                for member in dire
                if self.the_guild.get_member(member)
                and self.the_guild.get_member(member).voice
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
