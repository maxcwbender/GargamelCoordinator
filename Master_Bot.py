from typing import Union
import discord
from discord.channel import TextChannel
from discord.guild import Guild
from discord.member import Member
from discord.message import Message
from discord.user import User
import re
import math
import json
import sqlite3
import socketserver
import threading
import TheCoordinator as TC
import asyncio

class Master_Bot:

    def __init__(self):
        with open("config.json") as configFile:
            self.config: dict = json.load(configFile)

        eventLoop = asyncio.new_event_loop()
        self.coordinator: TC.Coordinator = TC.Coordinator(eventLoop)

        self.con = sqlite3.connect('allUsers.db')
        intents = discord.Intents.default()
        intents.members = True
        self.client = discord.Client(intents = intents, 
            loop=eventLoop)
        self.theGuild: Guild = None

        self.deleteMessage = ("\nThis message and your message will be deleted "
            "in {time} seconds.").format(time = self.config.get('DELETE_DELAY'))
        self.registerEvents()
        
        class MyTCPHandler(socketserver.BaseRequestHandler):

            def __init__(self, request, client_address, server, 
                    discordClient: discord.client.Client):
                self.discordClient = discordClient
                socketserver.BaseRequestHandler.__init__(self, request, 
                    client_address, server)

            def handle(self):
                data = self.request.recv(1024).strip().decode('utf-8')
                print("Just got "+data+" from the webserver")
                self.discordClient.dispatch("steamIDFound", data)

        class MyTCPServer(socketserver.ThreadingTCPServer):

            def __init__(self, aTuple, discordClient):
                self.discordClient = discordClient
                socketserver.ThreadingTCPServer.__init__(self, aTuple, 
                    MyTCPHandler)

            def verify_request(self, _, client_adddress):
                if client_adddress[0] == '127.0.0.1':
                    return True
                else:
                    print(f"Attempted connection from {client_adddress[0]}")
                    return False

            def finish_request(self, request, client_address):
                MyTCPHandler(request, client_address, self, self.discordClient)
        
        self.socketPipe = MyTCPServer(
            ("localhost", self.config.get('pipePort')), self.client)

        self.serverThread = threading.Thread(
            target=self.socketPipe.serve_forever)
        self.serverThread.start()
        
        self.client.run(self.config.get('CLIENT_KEY'))

    def escapeString(self, string: str) -> str:
        """ Creates a copy of the given string where all double quotation marks 
            are replaced with single quotation marks."""
        return string.replace('\"', '\'')

    def modResults(self, user: User) -> tuple[int, int, int]:
        """ Returns (A, D, W) where 
                A is the number of approval votes
                D is the number of disapprovals
                W is the number of votes still in process
            of the registered mods in the table mod_notes"""
        cursor = self.con.cursor()
        rows = cursor.execute(f"""SELECT result FROM mod_notes 
            WHERE registrant_id = {user.id}""").fetchall()
        cursor.close()
        (A, D, W) = (0, 0, 0)
        for row in rows:
            if row[0] == 0:
                D += 1
            elif row[0] == 1:
                A += 1
            else:
                W += 1
        return (A, D, W)

    def itemInTable(self, table: str, field: str, value):
        """ Returns true if the given value is in the given table in the given 
            field."""
        cursor = self.con.cursor()
        row = cursor.execute(f"""SELECT * FROM {table} 
            WHERE {field} = {value} LIMIT 1""").fetchone()
        cursor.close()
        if row:
            return True
        else: 
            return False

    async def pollRegistrationCommand(self, message: Message):
        """ The $pollRegistration command gives the mod who used it a new 
            registrant to approve. Command should only be issued from the 
            mod-station channel. Mods who haven"t approved their previously
            issued registrant will not be given a new one. """
        sent: Message
        cursor = self.con.cursor()
        (assignedRegistrant,) = tuple(cursor.execute(f"""
            SELECT (assignedRegistrant) FROM users WHERE discord_id = 
            {message.author.id}""").fetchone())
        cursor.close()
        if message.channel.name != "mod-station":
            sent = await message.reply(("<@{name}>: please use the <#{mod}> "
                "channel").format(name = message.author.id, 
                    mod = int(self.config.get('MOD_CHANNEL_ID'))) 
                + self.deleteMessage)
        elif assignedRegistrant != None: 
            sent = await message.reply(("<@{name}>: you have already "
                "been assigned the registrant <@{name2}>. Please "
                "approve or reject them before receiving a new "
                "registrant.").format(name = message.author.id, 
                    name2 = assignedRegistrant)
                + self.deleteMessage)
        else:
            cursor = self.con.cursor()
            row = cursor.execute(f"""
                SELECT (discord_id) FROM users WHERE 
                    modsRemaining > 0
                    AND NOT EXISTS (SELECT 1 FROM mod_notes WHERE 
                        mod_id = {message.author.id} AND 
                        registrant_id = discord_id)
                ORDER BY dateCreated ASC""").fetchone()
            cursor.close()
            if row == None:
                sent = await message.reply(("<@{name}>: either the registration"
                    " queue is empty or you have already approved everyone in "
                    "the queue.").format(name = message.author.id) 
                    + self.deleteMessage)
            else: 
                assignedRegistrant = row[0]
                self.con.execute(f"""UPDATE users 
                    SET modsRemaining = modsRemaining - 1 
                    WHERE discord_id = {assignedRegistrant}""")
                self.con.commit()
                self.con.execute(f"""UPDATE users SET assignedRegistrant = 
                    {assignedRegistrant} WHERE discord_id = {message.author.id}
                    """)
                self.con.commit()
                self.con.execute(f"""INSERT INTO mod_notes 
                    (request_id, mod_id, registrant_id) VALUES 
                    ({message.id}, {message.author.id}, {assignedRegistrant})
                    """)
                self.con.commit()
                sent = await message.reply(("<@{name}>: you are now assigned "
                    "the registrant <@{name2}>").format(
                        name = message.author.id, 
                        name2 = assignedRegistrant) 
                    + self.deleteMessage)
        await message.delete(delay = self.config.get('DELETE_DELAY'))
        await sent.delete(delay = self.config.get('DELETE_DELAY'))

    async def modDecisionCommand(self, message: Message):
        """ The $approve and $reject commands are used by mods with respect to 
            their assigned registrant. This command can only be issued from the 
            mod-station channel. Will do nothing if the message author has no 
            assigned registrant. If the approval pushes the approved user over 
            the threshold, the user will be given the contender role and will be 
            notified in the general channel.""" 
        sent: Message
        if message.channel.name != "mod-station":
            sent = await message.reply(("<@{name}>: please use the <#{mod}> "
                "channel").format(name = message.author.id, 
                    mod = int(self.config.get('MOD_CHANNEL_ID')))
                + self.deleteMessage)
            await message.delete(delay = self.config.get('DELETE_DELAY'))
        else: 
            cursor = self.con.cursor()
            registrant = cursor.execute(f"""
                    SELECT assignedRegistrant FROM users 
                    WHERE discord_id = {message.author.id}""").fetchone()[0]
            if registrant == None:
                sent = await message.reply(("<@{name}>: you do not currently "
                    "have an assigned registrant. Please use the "
                    "\"$pollRegistration\" command to receive a new "
                    "registrant.").format(name = message.author.id) 
                    + self.deleteMessage)
                await message.delete(delay = self.config.get('DELETE_DELAY'))
            else: 
                result = 1 if message.content.startswith("$approve") else 0
                reMatch = re.match("^(\$approve|\$reject)( *)(.*)", 
                    message.content, flags = re.DOTALL)
                if reMatch == None:
                    sent = await message.reply(("<@{name}>: incorrect format. "
                        "To $approve or $reject someone, your post should look "
                        "something like '$approve [optional notes about your "
                        "decision]").format(name = message.author.id, 
                            Bender = int(self.config.get('BENDER_ID')))
                        + self.deleteMessage)
                    await message.delete(
                        delay = self.config.get('DELETE_DELAY'))
                else: 
                    self.con.execute(f"""UPDATE mod_notes 
                        SET notes = \"{self.escapeString(message.content)}\", 
                                result = {result},
                                resultMessage_id = {message.id}
                            WHERE mod_id = {message.author.id}""")
                    self.con.commit()
                    self.con.execute(f"""UPDATE users 
                            SET assignedRegistrant = NULL 
                            WHERE discord_id = {message.author.id}""")
                    self.con.commit()
                    theUser: Member = self.theGuild.get_member(registrant)
                    results = self.modResults(theUser)
                    modRequirements = math.ceil(
                                      self.config.get('MOD_ASSIGNMENT')/2)
                    if (results[0] == modRequirements and result):
                        await theUser.add_roles(discord.utils.get(
                            self.theGuild.roles, name = "Contender"))
                        generalChannel : discord.channel.TextChannel = (
                            self.client.get_channel(
                                int(self.config.get('GENERAL_CHANNEL_ID'))))
                        await generalChannel.send(("<@{name}>: you are now "
                            "officially a contender. Welcome to the Gargamel "
                            "League!").format(name = registrant))
                    elif (results[1] == modRequirements and (not result)):
                        await theUser.send(("<@{name}>: you were flagged by "
                            "{num} moderators and are unable to register. If "
                            "you think this was made in error, contact "
                            "<@{Bender}>").format(name = registrant, 
                                Bender = int(self.config.get('BENDER_ID'))))
                    sent = await message.reply(("<@{name}>: thank you for "
                        "taking the time to review this user! Feel free to use "
                        "the \$pollRegistration command to grab another when "
                        "you're ready.").format(name = message.author.id))
        await sent.delete(delay = self.config.get('DELETE_DELAY'))

    async def vouchCommand(self, message: Message):
        """ The $vouch command allows a user to vouch for another user. This 
            info gets added into the vouchee's User data. If enough users vouch 
            for user X, then X gets given a special role 'vouched'."""
        sent: Message
        reMatch = re.search("^\$vouch <@(!|)([0-9]+)> (.*)", message.content, 
            flags = re.DOTALL)
        if message.channel.name != "vouching":
            sent = await message.reply(("<@{name}>: please use the <#{vouch}> "
                "channel").format(name = message.author.id, 
                    vouch = int(self.config.get('VOUCH_CHANNEL_ID')))
                + self.deleteMessage)
            await sent.delete(delay = self.config.get('DELETE_DELAY'))
            await message.delete(delay = self.config.get('DELETE_DELAY'))
        elif reMatch == None:
            sent = await message.reply(("<@{name}>: incorrect format. To vouch "
                "for someone, your post should look something like '$vouch "
                "<@{Bender}> I can personally attest that Bender is an all "
                "around good guy, not toxic, and not a smurf'.").format(
                    name = message.author.id, 
                    Bender = int(self.config.get('BENDER_ID')))
                + self.deleteMessage)
            await sent.delete(delay = self.config.get('DELETE_DELAY'))
            await message.delete(delay = self.config.get('DELETE_DELAY'))
        else:
            voucheeID = int(reMatch.group(2))
            theVouchee: Member = self.theGuild.get_member(voucheeID)
            theVoucher: Member = message.author
            if not self.itemInTable('users', 'discord_id', voucheeID):
                sent = await message.reply(("<@{name}>: this user appears to "
                    "have not $register-ed yet.").format(
                        name = message.author.id)
                    + self.deleteMessage)
                    
                await message.delete(delay = self.config.get('DELETE_DELAY'))
            elif theVouchee == theVoucher:
                sent = await message.reply(("<@{name}>: you cannot vouch for "
                    "yourself.").format(name = message.author.id) 
                    + self.deleteMessage)
                await message.delete(delay = self.config.get('DELETE_DELAY'))
            else: 
                cursor = self.con.cursor()
                row = cursor.execute(f"""SELECT * FROM vouches WHERE 
                    voucher_id = {theVoucher.id} AND 
                    vouchee_id = {voucheeID}""").fetchone()
                cursor.close()
                if row:
                    self.con.execute(f"""UPDATE vouches 
                        SET notes = \"{self.escapeString(message.content)}\" 
                        WHERE voucher_id = {theVoucher.id} AND
                            vouchee_id = {voucheeID}""")
                    self.con.commit()
                    sent = await message.reply(("<@{name}>: you have already "
                        "vouched for <@{name2}>. I will update your note with "
                        "your latest message. This message will be deleted in "
                        "{delay} seconds.").format(name = message.author.id, 
                            name2 = voucheeID, 
                            delay = self.config.get('DELETE_DELAY')))
                else: 
                    self.con.execute(f"""UPDATE users 
                        SET timesVouched = timesVouched + 1 
                        WHERE discord_id = {voucheeID}
                    """)
                    cursor = self.con.cursor()
                    vouches = cursor.execute(f"""SELECT timesVouched FROM users 
                        WHERE discord_id = {voucheeID}""").fetchall()
                    cursor.close()
                    if len(vouches) == self.config.get('VOUCH_REQUIREMENT'):
                        await theVouchee.add_roles(discord.utils.get(
                            self.theGuild.roles, name = "Vouched"))
                        await theVouchee.send(("<@{name}>: you "
                            "have been vouched for, so you have been granted "
                            "general access to the server. You are able to "
                            "queue, but only among other vouched "
                            "users.").format(
                                name = theVouchee.id))
                    self.con.execute(f"""INSERT INTO vouches 
                        (vouch_id, vouchee_id, voucher_id, notes)
                        VALUES ({message.id}, {voucheeID}, {theVoucher.id}, 
                            \"{self.escapeString(message.content)}\")""")
                    sent = await message.reply(("<@{name}>: acknowledged, thank"
                        " you for vouching <@{name2}>. This message will be "
                        "deleted in {delay} seconds.").format(
                            name = message.author.id, name2 = voucheeID, 
                            delay = self.config.get('DELETE_DELAY'))
                        )
        await sent.delete(delay = self.config.get('DELETE_DELAY'))

    async def setRatingCommand(self, message: Message):
        sent: Message
        reMatch = re.search("^\$setrating <@(!|)([0-9]+)> ([0-9]+)", 
            message.content, flags = re.DOTALL)
        if message.channel.name != "mod-station":
            sent = await message.reply(("<@{name}>: please use the <#{mod}> "
                "channel").format(name = message.author.id, 
                    vouch = int(self.config.get('MOD_CHANNEL_ID')))
                + self.deleteMessage)
            await sent.delete(delay = self.config.get('DELETE_DELAY'))
        elif reMatch == None:
            sent = await message.reply(("<@{name}>: incorrect format. To set "
                "the rank of a user, your message should look like $setrank "
                "<@{Bender}> 1234").format(
                    name = message.author.id, 
                    Bender = int(self.config.get('BENDER_ID')))
                + self.deleteMessage)
            await sent.delete(delay = self.config.get('DELETE_DELAY'))
        else:
            userID = int(reMatch.group(2))
            rating = int(reMatch.group(3))
            self.con.execute(f"""UPDATE users SET rating = {rating}
                WHERE discord_id = {userID}""")
            self.con.commit()
            sent = await message.reply("<@{name}>: acknowledged, thank you!".
                format(name = message.author.id))
        await sent.delete(delay = self.config.get('DELETE_DELAY'))

    async def queueCommand(self, message: Message):
        sent: Message
        cursor = self.con.cursor()
        rating: int = cursor.execute(f"""SELECT rating FROM users 
            WHERE discord_id = {message.author.id}""").fetchone()[0]
        cursor.close()
        if rating == None:
            sent = await message.reply(("<@{name}>: the mods haven't assigned "
            "a rating for you yet, so you are unable to queue.").format(
                    name = message.author.id) + self.deleteMessage)
        else:
            self.coordinator.insert(message.author.id, rating)
            sent = await message.reply(("<@{name}>: acknowledged, you're "
                "queueing with rating {rating}").format(
                    name = message.author.id, rating = rating) 
                + self.deleteMessage)
        await message.delete(delay = self.config.get('DELETE_DELAY'))
        await sent.delete(delay = self.config.get('DELETE_DELAY'))

    def registerEvents(self):

        @self.client.event
        async def on_game_created(game: list[int]):
            print("Game: ", game)

        @self.client.event
        async def on_steamIDFound(discordID: int):
            await self.client.get_channel(
                int(self.config.get('MOD_CHANNEL_ID'))).send(
                    f"<@{discordID}> just joined the registration queue!")

        @self.client.event
        async def on_ready():
            print("Connected!")
            self.theGuild = self.client.guilds[0]

        @self.client.event
        async def on_message(message: Message):
            """ This function is called whenever a message is read by this 
                bot"""
            
            # Ignore bot's own messages
            if message.author == self.client.user:
                pass

            elif message.content.startswith("$pollRegistration"):
                await self.pollRegistrationCommand(message)
                
            elif (message.content.startswith("$approve") or 
                    message.content.startswith("$reject")):
                await self.modDecisionCommand(message)

            elif message.content.startswith("$vouch"):
                await self.vouchCommand(message)

            elif message.content.startswith("$setrating"):
                await self.setRatingCommand(message)

            elif message.content.startswith("$queue"):
                await self.queueCommand(message)

            # TODO: $queue, $info

if __name__ == "__main__":
    Master_Bot()