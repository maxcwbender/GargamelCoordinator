from typing import Union
import discord
import re
import math
import json
import sqlite3
import requests

class User:

    def __init__(self, discordUserInfo: discord.member.Member, 
                       rating: int = 1400):
        """ Initializes the instance variables of the User class. This includes: 
                discordUserInfo:    the discord.member.Member object associated 
                                    with this user
                vouches:            a list storing tuples containing each user 
                                    who has vouched for this user and their 
                                    message sent when vouching
                assignedMods:       a list storing tuples containing each 
                                    mod-user who was assigned to this user, 
                                    along with their approval-status represented
                                    as a boolean and the message sent with their
                                    decision
                rating:             the rating (via RMS) of the user
                isMod:              True if user is a mod, False otherwise
                assignedRegistrant  None if user is not a mod or if the mod has 
                                    no current assigned registrant, otherwise it
                                    is the discord.member.Member object of the 
                                    user
        
            discordUserInfo:        A discord.member.Member object representing 
                                    this user"""

        self.discordUserInfo: discord.member.Member = discordUserInfo
        self.vouches: dict[User, str] = {}
        self.modInfo: dict[User, tuple[Union[bool, None], str]] = {}
        self.isMod: bool = False
        self.assignedRegistrant: Union[User, None] = None
        self.rating = rating
    
    def assignMod(self, mod: 'User'):
        """ Registers the User mod in modInfo"""
        self.modInfo[mod] = (None, "")
    
    def updateModResult(self, mod: 'User', result: bool, message: str):
        """ Updates the entry for the User mod in modInfo to the tuple (result, 
            message)"""
        self.modInfo[mod] = (result, message)
    
    def assignRegistrant(self, user: 'User'):
        """ Assigns the User user as the assignedRegistrant"""
        self.assignedRegistrant = user

    def modResults(self) -> tuple[int, int, int]:
        """ Returns (A, D, W) where 
                A is the number of approval votes
                D is the number of disapprovals
                W is the number of votes still in process
            of the registered mods in modInfo"""
        approvals = 0
        disapprovals = 0
        waiting = 0
        for (_, (modResult, _)) in self.modInfo.items():
            if modResult:
                approvals += 1
            elif modResult == False:
                disapprovals += 1
            else:
                waiting += 1
        return (approvals, disapprovals, waiting)

    def addVouch(self, user: 'User', message: str):
        """ Registers the User user in the vouches dictionary"""
        self.vouches[user] = message

    def vouchedBy(self, user: 'User') -> bool:
        """ Returns True if the User user has already vouched for self, 
            otherwise returns False"""
        return True if self.vouches.get(user) else False

class Master_Bot:

    def __init__(self):
        with open("config.json") as configFile:
            self.config: dict = json.load(configFile)

        con = sqlite3.connect('allUsers.db')
        self.cursor = con.cursor()
        
        self.client = discord.Client()
        self.theGuild: discord.guild.Guild = None
        # These should really be replaced by a proper database. TODO for sure. 
        self.registration_queue: list[User] = []
        self.usersByID: dict[int, User] = {} 
        self.deleteMessage = ("\nThis message and your message will be deleted "
            "in {time} seconds.").format(time = self.config.get('DELETE_DELAY'))
        self.registerEvents()
        self.client.run(self.config.get('CLIENT_KEY'))

    async def registerCommand(self, message: discord.message.Message):
        """ The $register command allows new users to enter the registration 
            queue. The new user is also added into the database of all users. 
            Command can only be used from the registration channel."""
        sent: discord.message.Message
        if message.channel.name != "registration":
            sent = await message.reply(("<@{name}>: please use the registration"
                " channel.").format(name = message.author.id) 
                + self.deleteMessage)
        elif message.author.id in self.usersByID:
            sent: discord.message.Message = await message.reply(("<@{name}>: "
                "you are already registered.").format(name = message.author.id) 
                + self.deleteMessage)
        else:
            newUser = User(message.author)
            self.registration_queue.append(newUser)
            self.usersByID[message.author.id] = newUser
            sent = await message.reply(("<@{name}>: you are now in line for "
                "registration; you will be notified when you are all set to go."
                " Current length of queue: {num}.").format(
                    name = message.author.id, 
                    num = len(self.registration_queue))
                + self.deleteMessage)
        await message.delete(delay = self.config.get('DELETE_DELAY'))
        await sent.delete(delay = self.config.get('DELETE_DELAY'))

    async def pollRegistrationCommand(self, message: discord.message.Message):
        """ The $pollRegistration command gives the mod who used it a new 
            registrant to approve. Command should only be issued from the 
            mod-station channel. Mods who haven"t approved their previously
            issued registrant will not be given a new one. """
        sent: discord.message.Message
        if message.channel.name != "mod-station":
            sent = await message.reply(
                "<@{name}>: please use the mod-station channel.".format(
                    name = message.author.id) + self.deleteMessage)
        elif len(self.registration_queue)==0:
            sent = await message.reply(
                "<@{name}>: the registration queue is empty.".format(
                    name = message.author.id) + self.deleteMessage)
        elif self.usersByID[message.author.id].assignedRegistrant != None:
            modID = message.author.id
            sent = await message.reply(("<@{name}>: you have already been "
                "assigned the registrant <@{name2}>. Please approve or reject "
                "them before receiving a new registrant.").format(name = modID, 
                    name2 = self.usersByID[modID].assignedRegistrant.
                        discordUserInfo.id) 
                + self.deleteMessage)
        else:
            # If standard protocol has been followed, we now find a registrant 
            # in the registration queue that this mod hasn't reviewed yet (if 
            # one exists), and assign this registrant to this mod.
            theMod: User = self.usersByID[message.author.id]
            registrant: User = None
            for user in self.registration_queue:
                newUser = True
                for mod in user.modInfo:
                    if mod == theMod:
                        newUser = False
                        break
                if newUser:
                    registrant = user
                    break
            if registrant != None:
                registrant.assignMod(theMod)
                theMod.assignRegistrant(registrant)
                if (len(registrant.modInfo) 
                        >= self.config.get('MOD_ASSIGNMENT')):
                    self.registration_queue.remove(registrant)
                sent = await message.reply(("<@{name}>: you are now assigned "
                    "the registrant <@{name2}>").format(
                        name = message.author.id, 
                        name2 = registrant.discordUserInfo.id) 
                    + self.deleteMessage)
            else:
                sent = await message.reply(("<@{name}>: you have already "
                    "approved everyone in the queue.").format(
                        name = message.author.id)
                    + self.deleteMessage)
        await message.delete(delay = self.config.get('DELETE_DELAY'))
        await sent.delete(delay = self.config.get('DELETE_DELAY'))

    async def modDecisionCommand(self, message: discord.message.Message):
        """ The $approve and $reject commands are used by mods with respect to 
            their assigned registrant. This command can only be issued from the 
            mod-station channel. Will do nothing if the message author has no 
            assigned registrant. If the approval pushes the approved user over 
            the threshold, the user will be given the contender role and will be 
            notified in the general channel.""" 
        sent: discord.message.Message
        if message.channel.name != "mod-station":
            sent = await message.reply(("<@{name}>: please use the mod-station "
                "channel").format(name = message.author.id) 
                + self.deleteMessage)
        elif self.usersByID[message.author.id].assignedRegistrant == None:
            sent = await message.reply(("<@{name}>: you do not currently have "
                "an assigned registrant. Please use the \"$pollRegistration\" "
                "command to receive a new registrant.").format(
                    name = message.author.id) 
                + self.deleteMessage)
        else:
            theMod = self.usersByID[message.author.id]
            theUser = self.usersByID[message.author.id].assignedRegistrant
            result = True if message.content.startswith("$approve") else False
            reMatch = re.match("^(\$approve|\$reject)( *)(.*)", message.content, 
                flags = re.DOTALL)
            if reMatch == None:
                sent = await message.reply(("<@{name}>: incorrect format. To "
                    "$approve or $reject someone, your post should look "
                    "something like '$approve [optional notes about your "
                    "decision]").format(name = message.author.id, 
                        Bender = self.config.get('BENDER_ID'))
                    + self.deleteMessage)
            else: 
                theUser.updateModResult(theMod, result, reMatch.group(3))
                theMod.assignRegistrant(None)
                results = theUser.modResults()
                modRequirements = math.ceil(self.config.get('MOD_ASSIGNMENT')/2)
                if (results[0] == modRequirements and result):
                    await theUser.discordUserInfo.add_roles(discord.utils.get(
                        self.theGuild.roles, name = "Contender"))
                    generalChannel : discord.channel.TextChannel = (
                        self.client.get_channel(
                            self.config.get('GENERAL_CHANNEL_ID')))
                    await generalChannel.send(("<@{name}>: you are now "
                        "officially a contender. Welcome to the Gargamel "
                        "League!").format(name = theUser.discordUserInfo.id))
                elif (results[1] == modRequirements and (not result)):
                    await theUser.discordUserInfo.send(
                        ("<@{name}>: you were flagged by 2 moderators and are "
                        "unable to register. If you think this was made in "
                        "error, contact <@{Bender}>").format(
                            name = theUser.discordUserInfo.id, 
                            Bender = self.config.get('BENDER_ID')))
                sent = await message.reply("<@{name}>: acknowledged.".format(
                    name = message.author.id) + self.deleteMessage)
        await message.delete(delay = self.config.get('DELETE_DELAY'))
        await sent.delete(delay = self.config.get('DELETE_DELAY'))

    async def vouchCommand(self, message: discord.message.Message):
        """ The $vouch command allows a user to vouch for another user. This 
            info gets added into the vouchee's User data. If enough users vouch 
            for user X, then X gets given a special role 'vouched'."""
        sent: discord.message.Message
        reMatch = re.search("^\$vouch <@(!|)([0-9]+)> (.*)", message.content, 
            flags = re.DOTALL)
        if reMatch == None:
            sent = await message.reply(("<@{name}>: incorrect format. To vouch "
                "for someone, your post should look something like '$vouch "
                "<@{Bender}> I can personally attest that Bender is an all "
                "around good guy, not toxic, and not a smurf'.").format(
                    name = message.author.id, 
                    Bender = self.config.get('BENDER_ID')) 
                + self.deleteMessage)
        else:
            voucheeID = int(reMatch.group(2))
            theVouchee = self.usersByID.get(voucheeID)
            theVoucher = self.usersByID.get(message.author.id)
            if theVouchee == None:
                sent = await message.reply(("<@{name}>: this user appears to "
                    "have not $register-ed yet.").format(
                        name = message.author.id) 
                    + self.deleteMessage)
            elif theVouchee == theVoucher:
                sent = await message.reply(("<@{name}>: you cannot vouch for "
                    "yourself.").format(name = message.author.id) 
                    + self.deleteMessage)
            else: 
                if theVouchee.vouchedBy(theVoucher):
                    sent = await message.reply(("<@{name}>: you have already "
                        "vouched for <@{name2}>. I will update your note with "
                        "your latest message").format(name = message.author.id, 
                            name2 = voucheeID) + self.deleteMessage)
                else: 
                    if (len(theVouchee.vouches) 
                            == self.config.get('VOUCH_REQUIREMENT')-1):
                        await theVouchee.discordUserInfo.add_roles(
                            self.theGuild.get_role(
                                self.config.get('VOUCHED_ROLE_ID')))
                        await theVouchee.discordUserInfo.send(("<@{name}>: you "
                            "have been vouched for, so you have been granted "
                            "general access to the server. You are able to "
                            "queue, but only among other vouched "
                            "users.").format(
                                name = theVouchee.discordUserInfo.id))
                    sent = await message.reply(("<@{name}>: acknowledged, thank"
                        " you for vouching <@{name2}>.").format(
                            name = message.author.id, name2 = voucheeID) 
                        + self.deleteMessage)
                theVouchee.addVouch(theVoucher, reMatch.group(3))
        await message.delete(delay = self.config.get('DELETE_DELAY'))
        await sent.delete(delay = self.config.get('DELETE_DELAY'))

    def registerEvents(self):

        @self.client.event
        async def on_ready():
            print("Connected!")
            self.theGuild = self.client.guilds[0]

        @self.client.event
        async def on_message(message: discord.message.Message):
            """ This function is called whenever a message is read by this 
                bot"""
            
            # Ignore bot's own messages
            if message.author == self.client.user:
                pass
                
            elif message.content.startswith("$register"):
                await self.registerCommand(message)

            elif message.content.startswith("$pollRegistration"):
                await self.pollRegistrationCommand(message)
                
            elif (message.content.startswith("$approve") or 
                    message.content.startswith("$reject")):
                await self.modDecisionCommand(message)

            elif message.content.startswith("$vouch"):
                await self.vouchCommand(message)

            # TODO: $queue, $info

if __name__ == "__main__":
    Master_Bot()