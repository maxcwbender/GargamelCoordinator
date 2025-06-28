import random
import math
import itertools
import json
from typing import List, Tuple

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

    def make_game(self) -> Tuple[List[int], List[int]]:
        if len(self.queue) < TEAM_SIZE * 2:
            raise ValueError("Not enough players to make a game.")

        # Get top players by priority
        top = sorted(self.queue.items(), key=lambda x: -x[1][1])[: TEAM_SIZE * 2]
        users, user_infos = zip(*top)
        ratings = [rating for rating, _ in user_infos]

        # Try all split partitions and find the one with smallest diff in geo means
        best_partition = None
        min_diff = float("inf")

        for team1_indices in itertools.combinations(range(TEAM_SIZE * 2), TEAM_SIZE):
            team1 = [ratings[i] for i in team1_indices]
            team2 = [ratings[i] for i in range(TEAM_SIZE * 2) if i not in team1_indices]

            geo1 = math.prod(team1) ** (1 / TEAM_SIZE)
            geo2 = math.prod(team2) ** (1 / TEAM_SIZE)
            diff = abs(geo1 - geo2)

            if diff < min_diff:
                min_diff = diff
                best_partition = team1_indices

        # Build final team lists
        team1_users = [users[i] for i in best_partition]
        team2_users = [
            users[i] for i in range(TEAM_SIZE * 2) if i not in best_partition
        ]

        # Remove players from the queue who were used
        for user in team1_users + team2_users:
            del self.queue[user]

        # Increase priority of others
        for user in self.queue:
            rating, priority = self.queue[user]
            self.queue[user] = (rating, priority + 1)

        return team1_users, team2_users


if __name__ == "__main__":
    coordinator = TheCoordinator()

    players = {}

    for i in range(TEAM_SIZE * 2 * 2):
        players[str(i)] = random.randint(2000, 6000)
        print(f"added player {str(i)} with skill {players[str(i)]}")
        coordinator.add_player(str(i), players[str(i)])

    for player, (rating, priority) in coordinator.queue.items():
        print(f"{player} : ({rating, priority})")

    (teamA, teamB) = coordinator.make_game()
    print(teamA, teamB)
    print(f"teamA: {math.prod([players[name] for name in teamA]) ** (1/TEAM_SIZE)}")
    print(f"teamB: {math.prod([players[name] for name in teamB]) ** (1/TEAM_SIZE)}")

    for player, (rating, priority) in coordinator.queue.items():
        print(f"{player} : ({rating, priority})")
