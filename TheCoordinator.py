from asyncio.events import TimerHandle
from typing import Callable
import Master_Bot as MB
import json
import time
import itertools
import math
import asyncio
import discord

class User:

    def __init__(self, discordID: int, rating: int):
        """ Initializes the instance variables of the User class. This includes:
                discordID:          the discord id of the associated User
                rating:             the skill rating of the associated User
                entranceTime:       a float representing the time User queued"""
        self.discordID = discordID
        self.rating = rating
        self.entranceTime = time.time()
        self.eventHandle: TimerHandle = None

    def getRating(self) -> int:
        return self.rating

    def getEntranceTime(self) -> float:
        return self.entranceTime

    def __repr__(self) -> str:
        return str(self.rating)

class Coordinator:

    def __init__(self, eventLoop: asyncio.AbstractEventLoop, 
            discordClient: discord.Client):
        """ The __init__ function loads in the config file (located in the same
            directory), and creates instance variables for storing the discord
            info of the users, a queue of the users in FIFO order, and a sorted
            list of all the users by their rating."""
        with open("config.json") as configFile:
            self.config: dict = json.load(configFile)

        self.usersByID: dict[int, User] = {}
        self.usersFIFO: list[User] = []
        self.usersByRating: list[User] = []
        self.eventLoop = eventLoop
        self.waitingForTen = False
        self.discordClient = discordClient
    
    def start(self):
        self.eventLoop.run_forever()

    def findIndexBS(self, user: User, listOfUsers: list[User], 
                    key: Callable[[User], float]) -> int:
        """ If the given User user is in usersByRating, then it will return the 
            index of user in the list. Otherwise, it will return the index of
            the lowest User by its key that has a higher key than user."""
        curStart = 0
        curEnd = len(listOfUsers)
        curIdx = int((curStart + curEnd)/2)

        # recurse until we can recurse no further or we have found an equal key
        while(curStart != curEnd and key(listOfUsers[curIdx]) != key(user)):
            if key(listOfUsers[curIdx]) < key(user):
                curStart = curIdx+1
            else:
                curEnd = curIdx
            curIdx = int((curStart + curEnd)/2)
        # if user is not in listOfUsers or if we have found the user itself
        if (curIdx == len(listOfUsers) or key(listOfUsers[curIdx]) != key(user) 
            or listOfUsers[curIdx] == user): 
            return curIdx
        else:
            # in this case, we need to iterate over all values with the same key
            # to determine whether or not user is among the list listOfUsers
            prevIdx = curIdx
            curIdx -= 1
            while(curIdx >= 0 and key(listOfUsers[curIdx]) == key(user)):
                if listOfUsers[curIdx] == user:
                    return curIdx
                curIdx -= 1
            curIdx = prevIdx + 1
            while(curIdx < len(listOfUsers) and 
                key(listOfUsers[curIdx]) == key(user)):
                if listOfUsers[curIdx] == user:
                    return curIdx
                curIdx += 1
        return curIdx

    def findUserPool(self, user: User):
        """ Returns a list of users with rating near the given User user. Will 
            attempt to get the value in config specified by the key 
            'lookaround', with an equal number below the user as above. If there
            is not enough users above, it will find extra below to make up the 
            difference, and vice-versa. """
        idx = self.findIndexBS(user, self.usersByRating, User.getRating)
        preferredStart = idx - int(self.config.get('lookAround')/2)
        startCut = 0 if preferredStart > 0 else -preferredStart
        preferredEnd = idx + int(self.config.get('lookAround')/2)
        endCut = (0 if preferredEnd < len(self.usersByRating) 
                    else preferredEnd - len(self.usersByRating) + 1)
        start = max(preferredStart - endCut, 0)
        end = min(preferredEnd + startCut, len(self.usersByRating) - 1)
        return self.usersByRating[start:idx] + self.usersByRating[idx+1:end+1]

    def gameImbalance(self, teamA: tuple[User, ...], 
                            teamB: tuple[User, ...]) -> float:
        """ Calculates the game-imbalance of the given teams.
            See https://www.ifaamas.org/Proceedings/aamas2017/pdfs/p1073.pdf"""
        nA = len(teamA)
        nB = len(teamB)
        pNorm = self.config.get('pNorm')
        qNorm = self.config.get('qNorm')

        teamASkills = tuple(map(lambda x : x.getRating(), teamA))
        teamBSkills = tuple(map(lambda x : x.getRating(), teamB))
        avgSkill = (sum(teamASkills) + sum(teamBSkills))/(nA + nB)

        teamAPoweredSkills = tuple(map(lambda x : x ** pNorm, 
                                    teamASkills))
        teamASkillNormed = (sum(teamAPoweredSkills) / nA) ** (1 / pNorm)
        teamBPoweredSkills = tuple(map(lambda x : x ** pNorm, 
                                    teamBSkills))
        teamBSkillNormed = (sum(teamBPoweredSkills) / nB) ** (1 / pNorm)

        poweredVariances = tuple(map(
            lambda x : abs(x.getRating() - avgSkill) ** qNorm, teamA + teamB))
        normedVariance = (sum(poweredVariances) / (nA + nB)) ** (1 / qNorm)

        return (normedVariance + 
            self.config.get('alpha') * abs(teamASkillNormed - teamBSkillNormed))

    def bestGameUsingExactlyThesePlayers(self,
            users: list[User]) -> (tuple[tuple[User, ...], tuple[User, ...]]):
        """ WARNING: This function has runtime exponential in the length of 
            users. It tries every choice of possible 2 team games between the 
            list of users"""
        bestGame = None
        bestScore = math.inf

        for teamA in itertools.combinations(users, int(len(users) / 2)):
            teamB = tuple(user for user in users if user not in teamA)
            score = self.gameImbalance(teamA, teamB)
            if score < bestScore:
                bestScore = score
                bestGame = (teamA, teamB)
        return bestGame

    def approxBestGameUsingExactlyThesePlayers(self, users: list[User]) -> (
            tuple[tuple[User, ...], tuple[User, ...]]):
        """ This function creates a game using the players given in users
            greedily. It has a runtime linear in the number of users given."""
        users.sort(key=User.getRating, reverse=True)
        teamA = ()
        totalSkillA = 0
        teamB = ()
        totalSkillB = 0
        
        for user in users:
            if totalSkillA <= totalSkillB and len(teamA) < len(users)/2:
                teamA += (user,)
                totalSkillA += user.getRating()
            else: 
                teamB += (user,)
                totalSkillB += user.getRating()
        return (teamA, teamB)

    def insert(self, discordID: int, rating: int):
        self.eventLoop.call_soon(self.__insert, discordID, rating)

    def __insert(self, discordID: int, rating: int):
        """ This inserts user into the queue usersFIFO and the sorted list
            usersByRating.""" 
        newUser = User(discordID, rating)
        self.usersFIFO.append(newUser)
        self.usersByRating.insert(
            self.findIndexBS(newUser, self.usersByRating, User.getRating), 
            newUser)
        self.usersByID[discordID] = newUser
        newUser.eventHandle = self.eventLoop.call_later(90, self.__create)
        if self.waitingForTen and len(self.usersFIFO) == 10:
            self.waitingForTen = False
            self.__create()

    def delete(self, discordID: int):
        self.eventLoop.call_soon(self.__delete, self.usersByID.get(discordID))

    def __delete(self, user: User):
        """ This deletes user from the queue and usersByRating."""
        if user == None:
            print("Tried to delete None")
            return
        self.usersFIFO.pop(
            self.findIndexBS(user, self.usersFIFO, User.getEntranceTime))
        self.usersByRating.pop(
            self.findIndexBS(user, self.usersByRating, User.getRating))
        self.usersByID.__delitem__(user.discordID)
        user.eventHandle.cancel()

    def create(self):
        self.eventLoop.call_soon(self.__create)

    def __create(self) -> tuple[tuple[User, ...], tuple[User, ...]]:
        """ This creates the approximately most balanced game involving the user
            who has been waiting in the queue for the longest"""
        if len(self.usersFIFO)<10:
            print("Not enough players in queue")
            self.waitingForTen = True
            return
        theUser = self.usersFIFO[0]
        thePool = self.findUserPool(theUser)
        bestGame = None
        bestScore = math.inf
        for ninePlayers in itertools.combinations(thePool, 9):
            (teamA, teamB) = self.bestGameUsingExactlyThesePlayers(
                list(ninePlayers) + [theUser])
            curScore = self.gameImbalance(teamA, teamB)
            if curScore < bestScore: 
                bestGame = (teamA, teamB)
                bestScore = curScore
        for user in bestGame[0] + bestGame[1]:
            self.__delete(user)
        self.discordClient.dispatch("game_created", 
            list(map(lambda x : x.discordID, bestGame[0] + bestGame[1])))
        return bestGame

def test():
    import random
    eventLoop = asyncio.new_event_loop()
    coordinator = Coordinator(eventLoop)
    delay = 0
    for i in range(500):
        rating = max(int(random.normalvariate(2500, 1000)), 0)
        delay += random.expovariate(2)
        coordinator.eventLoop.call_later(delay, coordinator.insert, i, rating)
    eventLoop.run_forever()

if __name__ == "__main__":
    test()