import random
import math
import itertools
import json
import heapq
from typing import List, Tuple, Set
from DBFunctions import power_mean, unfun_score
import logging
logger = logging.getLogger(__name__)

with open("config.json") as configFile:
    config: dict = json.load(configFile)

TEAM_SIZE = config["TEAM_SIZE"]


class TheCoordinator:
    def __init__(self):
        self.queue = {}  # user -> (rating, priority)

    def in_queue(self, discord_id):
        return discord_id in self.queue

    def add_player(self, user: int, rating: int) -> int:
        if user not in self.queue:
            self.queue[user] = (rating, random.random())
        return len(self.queue)

    def remove_player(self, user: int) -> bool:
        return self.queue.pop(user, None) is not None

    def get_queue(self) -> List[Tuple[int, int]]:
        return [
            (user, info[0])
            for user, info in sorted(self.queue.items(), key=lambda x: -x[1][1])
        ]

    def clear_queue(self):
        self.queue.clear()

    def make_game(self) -> Tuple[List[int], List[int], Set[int]]:
        if len(self.queue) < TEAM_SIZE * 2:
            raise ValueError("Not enough players to make a game.")

        # Get top players by priority
        top = sorted(self.queue.items(), key=lambda x: -x[1][1])[: TEAM_SIZE * 2]
        users, user_infos = zip(*top)
        ratings = [rating for rating, _ in user_infos]

        
        heap: list[Tuple[int, list[int]]] = []  # stores (-diff, team1_indices)

        for team1_indices in itertools.combinations(range(TEAM_SIZE * 2), TEAM_SIZE):
            team1 = [ratings[i] for i in team1_indices]
            team2 = [ratings[i] for i in range(TEAM_SIZE * 2) if i not in team1_indices]
            
            team1.sort()
            team2.sort()

            team1_rating = power_mean(team1)
            team2_rating = power_mean(team2)
            diff = abs(team1_rating - team2_rating)
            
            badness = unfun_score(team1, team2, config["UNFUN_MOD"])

            heapq.heappush(heap, (-(badness + diff), team1_indices))
            if len(heap) > 5:
                heapq.heappop(heap)

        total_weight = sum(1 / (-score + 1e-6) for score, _ in heap)
        probs = [(1 / (-score + 1e-6)) / total_weight for score, _ in heap]

        selected_partition = random.choices(heap, weights=probs, k=1)[0][1]

        team1_users = [users[i] for i in selected_partition]
        team2_users = [users[i] for i in range(TEAM_SIZE * 2) if i not in selected_partition]

        # Remove players from the queue who were used
        for user in team1_users + team2_users:
            del self.queue[user]

        cut_players = set()
        # Increase priority of others
        for user in self.queue:
            rating, priority = self.queue[user]
            self.queue[user] = (rating, priority + 1)
            cut_players.add(user)

        return team1_users, team2_users, cut_players


if __name__ == "__main__":
    coordinator = TheCoordinator()

    players = {}

    for i in range(TEAM_SIZE * 2 * 2):
        players[str(i)] = random.randint(1000, 6000)
        print(f"added player {str(i)} with skill {players[str(i)]}")
        coordinator.add_player(str(i), players[str(i)])

    # ratings = [3017, 3958, 5762, 3998, 3043, 502, 4881, 5043, 4956, 1040]
    # for i in range(len(ratings)):
    #     players[str(i)] = ratings[i]
    #     print(f"added player {str(i)} with skill {players[str(i)]}")
    #     coordinator.add_player(str(i), players[str(i)])
        

    for player, (rating, priority) in coordinator.queue.items():
        print(f"{player} : ({rating, priority})")

    (teamA, teamB, leftover) = coordinator.make_game()
    print(teamA)
    print(teamB)
    teamA = [players[x] for x in teamA]
    teamB = [players[x] for x in teamB]
    teamA.sort()
    teamB.sort()
    print(teamA)
    print(teamB)
    print(f"teamA: {power_mean(teamA)}")
    print(f"teamB: {power_mean(teamB)}")
    print(f"unfun: {unfun_score(teamA, teamB, config["UNFUN_MOD"])}")
