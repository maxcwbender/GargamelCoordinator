# main_bot.py
import DotATalker
import TheCoordinator as TC
import json
import math
import sqlite3
import asyncio
import discord
from discord import app_commands
from discord.ext import commands
import random
import numpy as np

"""
Main bot script for Discord MasterBot managing Dota 2 community interactions.

Features:
- Moderation queue with mod assignment and decision recording
- User vouching and rating system with role assignments
- Game queueing and matchmaking integration with DotaTalker and TheCoordinator
- TCP server to receive SteamID notifications from localhost
- Uses discord.py app_commands (slash commands) for interaction
- SQLite DB backend for persistent user and mod data

Author: mbender
"""


class Master_Bot(commands.Bot):
    """
    Discord bot subclass managing all interactions and game coordination.

    Attributes:
        config (dict): Configuration loaded from JSON file.
        con (sqlite3.Connection): Database connection to 'allUsers.db'.
        coordinator (TheCoordinator): Manages matchmaking and queue logic.
        dota_talker (DotATalker): Handles Dota 2 client interactions.
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
        self.dota_talker = DotATalker.DotATalker(self)

        self.the_guild: discord.Guild = None
        self.game_counter = 0
        self.game_channels: dict[
            int, tuple[discord.VoiceChannel, discord.VoiceChannel]
        ] = {}
        self.game_map: dict[int, int] = {}
        self.game_map_inverse: dict[int, (set[int], set[int])] = {}
        self.queue_status_msg: discord.Message = None
        self.pending_game_task: asyncio.Task | None = None

    def run(self):
        """
        Start the bot using the token loaded from config file.
        Overrides commands.Bot.run for clarity and encapsulation.
        """
        super().run(self.config["BOT_TOKEN"])

    def fetch_one(self, query, params=()):
        """Execute a SQL query and return a single row or None.

        Args:
            query (str): SQL query string.
            params (tuple): Query parameters.

        Returns:
            tuple or None: The first row of the result set, or None if no results.
        """
        with self.con as con:
            result = con.execute(query, params).fetchone()
        return result[0] if result else None

    def fetch_all(self, query, params=()):
        """Execute a SQL query and return all matching rows.

        Args:
            query (str): SQL query string.
            params (tuple): Query parameters.

        Returns:
            list of tuples: All rows matching the query.
        """
        with self.con as con:
            return con.execute(query, params).fetchall()

    def execute(self, query, params=()):
        """Execute a SQL command (INSERT, UPDATE, DELETE).

        Args:
            query (str): SQL command string.
            params (tuple): Command parameters.
        """
        with self.con as con:
            con.execute(query, params)
        con.commit()

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
                print(f"Blocked non-local request: {addr}")
                writer.close()
                return

            data = await reader.read(1024)
            message = data.decode().strip()
            print(f"steam_id found: {message}")
            self.dispatch("steam_id_found", int(message))
            writer.close()

        server = await asyncio.start_server(
            handle, "127.0.0.1", self.config["pipePort"]
        )
        asyncio.create_task(server.serve_forever())

    async def update_queue_status_message(self, new_message: bool = False):
        """
        Updates or creates the queue status message listing all queued users and their ratings.
        """
        lobby_channel = self.get_channel(int(self.config["LOBBY_CHANNEL_ID"]))

        playerQueue = self.coordinator.get_queue()
        for i in range(len(playerQueue)):
            playerQueue[i] = f"<@{playerQueue[i][0]}>"
        
        if len(playerQueue) > self.config["TEAM_SIZE"] * 2:
            playerQueue.insert(self.config["TEAM_SIZE"] * 2, "✂️✂️✂️")

        content = (
            f"**Current Queue ({len(playerQueue)} player{"s" if len(playerQueue) != 1 else ""}):**\n"
            + ", ".join(playerQueue)
            if playerQueue
            else "*No players are currently queueing.*"
        )

        # If the message exists, try to edit it
        try:
            if self.queue_status_msg and not new_message:
                await self.queue_status_msg.edit(content=content)
            else:
                self.queue_status_msg = await lobby_channel.send(content)
        except discord.NotFound:
            # If message was deleted, reset and recreate
            self.queue_status_msg = await lobby_channel.send(content)

    def query_mod_results(self, user_id: int) -> tuple[int, int, int]:
        """
        Count moderation results for a user.

        Args:
            user_id (int): Discord ID of the user.

        Returns:
            tuple(int, int, int): Counts of (approvals, disapprovals, undecided) mod votes.
        """
        rows = self.fetch_all(
            "SELECT result FROM mod_notes WHERE registrant_id = ?", (user_id,)
        )
        A = sum(1 for r in rows if r[0] == 1)
        D = sum(1 for r in rows if r[0] == 0)
        W = sum(1 for r in rows if r[0] not in (0, 1))
        return A, D, W

    def exists_in(self, table: str, where_clause: str, params: tuple = ()) -> bool:
        """
        Check if any row exists in a specified table that satisfies a given WHERE clause.

        Args:
            table (str): Name of the table.
            where_clause (str): SQL WHERE clause (without the 'WHERE' keyword).
            params (tuple): Parameters to substitute into the query.

        Returns:
            bool: True if a matching row exists, False otherwise.

        Warning:
            This method does not sanitize the table name or WHERE clause.
            Ensure they are constructed safely to avoid SQL injection.
        """
        query = f"SELECT 1 FROM {table} WHERE {where_clause} LIMIT 1"
        return bool(self.fetch_one(query, params))

    def get_steamid(self, discord_id: int) -> int | None:
        """
        Retrieve SteamID associated with a Discord user ID.

        Args:
            discord_id (int): Discord user ID.

        Returns:
            (int or None): SteamID if found, else None.
        """
        return self.fetch_one(
            "SELECT steam_id FROM users WHERE discord_id = ?", (discord_id,)
        )

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

        registrant = self.fetch_one(
            "SELECT assignedRegistrant FROM users WHERE discord_id = ?", (mod_id,)
        )

        if not registrant:
            return await interaction.response.send_message(
                f"<@{mod_id}>: no registrant assigned. Use /poll_registration.",
                ephemeral=True,
            )

        self.execute(
            """
            UPDATE mod_notes
            SET notes = ?, result = ?, resultMessage_id = ?
            WHERE mod_id = ? AND registrant_id = ?
            """,
            (notes, int(result), interaction.id, mod_id, registrant),
        )

        self.execute(
            "UPDATE users SET rating = ?, assignedRegistrant = NULL WHERE discord_id = ?",
            (rating, mod_id),
        )

        print("Test")

        A, D, W = self.query_mod_results(registrant)
        threshold = math.ceil(self.config["MOD_ASSIGNMENT"] / 2)
        member = self.the_guild.get_member(registrant)
        print(registrant)
        print(member)
        if member:
            if result and A >= threshold:
                contender = discord.utils.get(self.the_guild.roles, name="Contender")
                await member.add_roles(contender)
                general = self.get_channel(int(self.config["GENERAL_CHANNEL_ID"]))
                await general.send(f"<@{registrant}> is now a Contender🎉")
            elif not result and D >= threshold:
                bender = int(self.config["BENDER_ID"])
                await member.send(
                    f"<@{registrant}>: you were flagged by {D} mods. Contact <@{bender}>."
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
            lobby_channel = self.get_channel(int(self.config["LOBBY_CHANNEL_ID"]))
            while len(self.coordinator.queue) >= TC.TEAM_SIZE * 2:
                await asyncio.sleep(seconds)

                if len(self.coordinator.queue) < TC.TEAM_SIZE * 2:
                    await lobby_channel.send("Not enough players anymore. Game cancelled. ❌")
                    break

                radiant, dire = self.coordinator.make_game()
                teams = [radiant, dire]
                random.shuffle(teams)
                radiant, dire = teams

                await self.on_game_created(radiant, dire)
                await self.update_queue_status_message()
                if len(self.coordinator.queue) >= TC.TEAM_SIZE * 2:
                    await lobby_channel.send("@here Still enough players! Starting another game in **15 seconds** ⏳")
                    seconds = 15  # Shorter delay for repeat games
                else:
                    break
        except asyncio.CancelledError:
            raise
        finally:
            self.pending_game_task = None

    async def on_ready(self):
        """
        Called when the bot is ready and connected.

        Starts internal TCP server. Caches the primary guild. Registers and syncs all
        slash commands with Discord.

        All slash command handlers are defined as nested async functions here.
        """
        print(f"Logged in as {self.user}")
        await self._start_tcp_server()
        self.the_guild = self.guilds[0]
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

            prev_registrant_id = self.fetch_one(
                f"SELECT assignedRegistrant FROM users WHERE discord_id = ?", (mod_id,)
            )
            if prev_registrant_id:
                return await interaction.response.send_message(
                    f"<@{mod_id}>: you already have <@{prev_registrant_id}> assigned. Approve/reject first.",
                    ephemeral=True,
                )

            new_registrant = self.fetch_one(
                f"""
                SELECT discord_id FROM users
                WHERE modsRemaining > 0
                AND NOT EXISTS(SELECT 1 FROM mod_notes
                WHERE mod_id = {mod_id} AND registrant_id = discord_id)
                ORDER BY dateCreated ASC
                LIMIT 1
                """
            )
            if not new_registrant:
                return await interaction.response.send_message(
                    f"<@{mod_id}>: no registrants available or all previously moderated.",
                    ephemeral=True,
                )

            self.execute(
                f"UPDATE users SET modsRemaining = modsRemaining - 1 WHERE discord_id = {new_registrant}"
            )
            self.execute(
                f"UPDATE users SET assignedRegistrant = {new_registrant} WHERE discord_id = {mod_id}"
            )
            self.execute(
                f"INSERT INTO mod_notes (request_id, mod_id, registrant_id) VALUES ({interaction.id}, {mod_id}, {new_registrant})"
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
            await self._mod_decision(interaction, notes = notes, result=False)

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
                    f"<@{interaction.user.id}>: please use <#{vouch_channel}>", ephemeral=True
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
                self.execute(
                    f"UPDATE vouches SET notes=? WHERE voucher_id={interaction.user.id} AND vouchee_id={user.id}",
                    (note,),
                )
                msg = f"Updated your vouch for {user.mention}."
            else:
                # New vouch
                self.execute(
                    f"UPDATE users SET timesVouched = timesVouched + 1 WHERE discord_id = {user.id}"
                )
                self.execute(
                    f"INSERT INTO vouches (vouch_id, vouchee_id, voucher_id, notes) VALUES ({interaction.id}, {user.id}, {interaction.user.id}, ?)",
                    (note,),
                )
                msg = f"Thanks for vouching for {user.mention}."

                # Auto-assign Vouched role if threshold reached
                count = self.fetch_one(f"SELECT timesVouched FROM users WHERE discord_id = {user.id}")
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

            self.execute(
                f"UPDATE users SET rating={rating} WHERE discord_id={user.id}"
            )
            await interaction.response.send_message(
                f"Set {user.display_name}'s rating to {rating}.", ephemeral=True
            )

        @app_commands.command(name="queue", description="Join the game queue")
        async def queue(interaction: discord.Interaction):
            """
            Adds a user to the matchmaking queue using their stored rating.

            Notifies user of queue status.
            Automatically creates game when enough players join.

            Args:
                interaction (discord.Interaction): Interaction invoking the command.
            """
            rating = self.fetch_one(f"SELECT rating FROM users WHERE discord_id={interaction.user.id}")
            if not rating:
                return await interaction.response.send_message(
                    "You don't have a rating yet.", ephemeral=True
                )
            
            pool_size = self.coordinator.add_player(interaction.user.id, rating)
            await interaction.response.send_message(
                f"You're now queueing with rating {rating}.", ephemeral=True
            )

            if pool_size >= TC.TEAM_SIZE * 2:
                if self.pending_game_task is None or self.pending_game_task.done():
                    lobby_channel = self.get_channel(int(self.config["LOBBY_CHANNEL_ID"]))
                    await lobby_channel.send("@here Enough players! Game will start in **1 minute** ⏳")
                    self.pending_game_task = asyncio.create_task(self._start_game_loop(60))

            await self.update_queue_status_message()

        @app_commands.command(name="leave", description="Leave the game queue")
        async def leave(interaction: discord.Interaction):
            """
            Removes the user from the matchmaking queue.

            Args:
                interaction (discord.Interaction): Interaction invoking the command.
            """
            self.coordinator.remove_player(interaction.user.id)
            await interaction.response.send_message(
                "You left the queue.", ephemeral=True
            )
            await self.update_queue_status_message()

        @app_commands.command(name="force_start", description="Immediately start a game if enough players are in queue.")
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

            await interaction.response.send_message("Force-starting game now!", ephemeral=True)

            # Immediately start the loop, with short countdown
            chan = self.get_channel(int(self.config["LOBBY_CHANNEL_ID"]))
            await chan.send("@here ⚡ Force-start requested — game beginning in **5 seconds**!")
            self.pending_game_task = asyncio.create_task(self._start_game_loop(5))

        
        @app_commands.command(name="ping", description="Ping the bot")
        async def ping(interaction: discord.Interaction):
            """
            Simple test command to check if bot is responsive.

            Args:
                interaction (discord.Interaction): Interaction invoking the command.
            """
            await interaction.response.send_message("Pong!")

        # Add explicitly
        self.tree.add_command(poll_registration)
        self.tree.add_command(approve)
        self.tree.add_command(reject)
        self.tree.add_command(vouch)
        self.tree.add_command(set_rating)
        self.tree.add_command(queue)
        self.tree.add_command(leave)
        self.tree.add_command(force_start)
        self.tree.add_command(ping)

        await self.tree.sync()  # Clears global commands from Discord
        await self.tree.sync(guild=self.the_guild)

        
    async def on_game_ended(self, game_id: int, winner: int):
        """
        Cleanup after a game ends and update ratings.

        Uses geometric mean team ELOs and standard ELO formula for player updates.

        Args:
            game_id (int): Identifier for the ended game.
            winner (int): The winner of the game (2 if radiant, 3 if dire)
        """
        radiant, dire = self.game_map_inverse[game_id]
        del self.game_map_inverse[game_id]

        for player in radiant:
            del self.game_map[player]
        for player in dire:
            del self.game_map[player]

        radiant_channel, dire_channel = self.game_channels.pop(game_id)
        await radiant_channel.delete()
        await dire_channel.delete()

        # Retrieve player ratings
        radiant_ratings = [self.fetch_one(
            "SELECT rating FROM users WHERE discord_id = ?", (pid,)) for pid in radiant]
        dire_ratings = [self.fetch_one(
            "SELECT rating FROM users WHERE discord_id = ?", (pid,)) for pid in dire]

        # Calculate geometric means
        r_radiant = np.exp(np.mean(np.log(radiant_ratings)))
        r_dire = np.exp(np.mean(np.log(dire_ratings)))

        # Determine results
        s_radiant = 1 if winner == 2 else 0
        s_dire = 1 - s_radiant

        # ELO expected scores
        e_radiant = 1 / (1 + 10 ** ((r_dire - r_radiant) / 3322))
        e_dire = 1 - e_radiant

        k = self.config.get("ELO_K", 32)  # Use config or default

        # Update radiant ratings
        for i, pid in enumerate(radiant):
            new_rating = round(radiant_ratings[i] + k * (s_radiant - e_radiant))
            self.execute(
                "UPDATE users SET rating = ? WHERE discord_id = ?", (new_rating, pid)
            )

        # Update dire ratings
        for i, pid in enumerate(dire):
            new_rating = round(dire_ratings[i] + k * (s_dire - e_dire))
            self.execute(
                "UPDATE users SET rating = ? WHERE discord_id = ?", (new_rating, pid)
            )

    async def on_steam_id_found(self, discord_id: int):
        """
        Event triggered when SteamID is received from the TCP server.

        Adds Steam friends to all Dota clients.
        Notifies mod channel if user has remaining mods to complete.

        Args:
            discord_id (int): Discord user ID for which SteamID was found.
        """
        steam_id = self.fetch_one(f"SELECT steam_id FROM users WHERE discord_id = {discord_id}")
        for dotaClient in self.dota_talker.dotaClients:
            dotaClient.steam.friends.add(steam_id)

        modsRemaining = self.fetch_one(f"SELECT modsRemaining FROM users WHERE discord_id = {discord_id}")

        if modsRemaining > 0:
            mod_chan = self.get_channel(int(self.config["MOD_CHANNEL_ID"]))
            await mod_chan.send(f"<@{discord_id}> joined registration queue!")

    async def on_game_created(self, radiant, dire):
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
        self.game_counter += 1
        game_id = self.game_counter
        radiant_channel = await self.the_guild.create_voice_channel(
            f"Game {self.game_counter} — Radiant"
        )
        dire_channel = await self.the_guild.create_voice_channel(
            f"Game {self.game_counter} — Dire"
        )

        # # Disable view/connect for default roles (undecided feature)
        # for role in await self.the_guild.fetch_roles():
        #     if role.name not in ("League Commish", "GargamelCoordinator", "Mod"):
        #         await radiant.set_permissions(role, view_channel=False, connect=False)
        #         await dire.set_permissions(role, view_channel=False, connect=False)

        self.game_map_inverse[game_id] = (set(), set())
        # Give perms for viewing new channels; movement feature currently disabled
        for member_id in radiant:
            m = self.the_guild.get_member(member_id)
            await radiant_channel.set_permissions(m, view_channel=True, connect=True)
            try:
                await m.move_to(radiant_channel)
            except (discord.HTTPException, discord.ClientException):
                print(f"[WARN] Couldn't move {m.display_name} — not connected to voice.")
            await m.send(
                f"You were placed in a match! Join your channel: <#{radiant_channel.id}> Enjoy 🎮"
            )
            self.game_map[member_id] = game_id
            self.game_map_inverse[game_id][0].add(member_id)
        for member_id in dire:
            m = self.the_guild.get_member(member_id)
            await dire_channel.set_permissions(m, view_channel=True, connect=True)
            try:
                await m.move_to(dire_channel)
            except (discord.HTTPException, discord.ClientException):
                print(f"[WARN] Couldn't move {m.display_name} — not connected to voice.")
            await m.send(
                f"You were placed in a match! Join your channel: <#{dire_channel.id}> Enjoy 🎮"
            )
            self.game_map[member_id] = game_id
            self.game_map_inverse[game_id][1].add(member_id)

        self.game_channels[game_id] = (radiant_channel, dire_channel)

        
        radiant_ratings = [self.fetch_one(
            "SELECT rating FROM users WHERE discord_id = ?", (pid,)) for pid in radiant]
        dire_ratings = [self.fetch_one(
            "SELECT rating FROM users WHERE discord_id = ?", (pid,)) for pid in dire]
        
        
        # Calculate geometric means
        r_radiant = np.exp(np.mean(np.log(radiant_ratings)))
        r_dire = np.exp(np.mean(np.log(dire_ratings)))

        password = self.dota_talker.make_game(game_id, radiant, dire)
        await self.get_channel(int(self.config["LOBBY_CHANNEL_ID"])).send(
            f"""New match created!
            
            Radiant ({int(r_radiant)}):  {', '.join([f'(<@{str(radiant[i])}>, {str(radiant_ratings[i])})' for i in range(len(radiant))])}
            Dire ({int(r_dire)}): {', '.join([f'(<@{str(dire[i])}>, {str(dire_ratings[i])})' for i in range(len(dire))])}
            Password: {password}"""
        )

        await self.update_queue_status_message(True)



# Run the bot
if __name__ == "__main__":
    bot = Master_Bot()
    bot.run()
