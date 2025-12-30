import random
import math
import itertools
import json
import heapq
from typing import List, Tuple, Set
from DBFunctions import power_mean, unfun_score, fetch_rating, fetch_steam_id
import logging
import time
from datetime import datetime

logger = logging.getLogger(__name__)

with open("config.json") as configFile:
    config: dict = json.load(configFile)


class TheCoordinator:
    def __init__(self, discordBot, dota_talker):
        # user_id -> (rating, join_time, random_tiebreaker)
        self.queue = {}
        self.discordBot = discordBot
        self.dota_talker = dota_talker

    # --- Queue Management ---

    def in_queue(self, discord_id: int) -> bool:
        return discord_id in self.queue

    def add_player(self, user: int, rating: int) -> int:
        """Add a player to the queue with their rating and join time."""
        if user not in self.queue:
            join_time = time.time()
            human_time = datetime.fromtimestamp(join_time).strftime("%Y-%m-%d %H:%M:%S")
            self.queue[user] = (rating, join_time, random.random())
            logger.info(f"[Coordinator] Added {user} to queue (rating={rating}, time={human_time})")
        return len(self.queue)

    def remove_player(self, user: int) -> bool:
        """Remove a player from the queue."""
        removed = self.queue.pop(user, None) is not None
        if removed:
            logger.info(f"[Coordinator] Removed {user} from queue.")
        return removed

    def get_queue(self) -> List[Tuple[int, int]]:
        """Return a sorted list of (user_id, rating), oldest first."""
        return [
            (user, info[0])
            for user, info in sorted(self.queue.items(), key=lambda x: (x[1][1], x[1][2]))
        ]

    def clear_queue(self):
        """Clear all players from the queue."""
        self.queue.clear()
        logger.info("[Coordinator] Queue cleared.")

    # --- Game Logic ---

    async def balance_teams(self, game_id: int):
        """
        Rebalance teams in an active game using the same MMR logic as make_game().
        This should be called after a force_replace() to restore MMR fairness.
        """
        logger.info(f"[Coordinator] Rebalancing teams for game {game_id}...")

        # Access game state through Master_Bot
        game_map_inverse = self.discordBot.game_map_inverse
        game_map = self.discordBot.game_map
        dota_talker = self.discordBot.dota_talker
        lobby_messages = self.discordBot.lobby_messages

        # --- Step 1: Gather players currently in game ---
        radiant_set, dire_set = game_map_inverse.get(game_id, (set(), set()))
        all_players = list(radiant_set | dire_set)

        if len(all_players) < config["TEAM_SIZE"] * 2:
            logger.warning(f"[Coordinator] Not enough players to rebalance (have {len(all_players)})")
            return False

        # --- Step 2: Fetch MMRs for all players ---
        player_ratings: list[tuple[int, int]] = []
        for player_id in all_players:
            try:
                mmr = fetch_rating(player_id)
            except Exception as e:
                logger.error(f"[Coordinator] Could not fetch MMR for {player_id}, cannot balance game: {e}")
                return False
            player_ratings.append((player_id, mmr))

        # Separate IDs and ratings
        users = [pid for pid, _ in player_ratings]
        ratings = [mmr for _, mmr in player_ratings]

        # --- Step 3: Use same balancing algorithm as make_game() ---
        heap: list[tuple[int, list[int]]] = []

        for team1_indices in itertools.combinations(range(config["TEAM_SIZE"] * 2), config["TEAM_SIZE"]):
            team1 = [ratings[i] for i in team1_indices]
            team2 = [ratings[i] for i in range(config["TEAM_SIZE"] * 2) if i not in team1_indices]

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

        radiant_users = [users[i] for i in selected_partition]
        dire_users = [users[i] for i in range(config["TEAM_SIZE"] * 2) if i not in selected_partition]

        total_r = sum(ratings[i] for i in selected_partition)
        total_d = sum(ratings[i] for i in range(config["TEAM_SIZE"] * 2) if i not in selected_partition)

        logger.info(f"[Coordinator] Balanced Radiant total={total_r}, Dire total={total_d}")

        # --- Step 4: Update Master_Bot maps ---
        game_map_inverse[game_id] = (set(radiant_users), set(dire_users))
        for pid in radiant_users + dire_users:
            game_map[pid] = game_id

        # --- Step 5: Update Dota lobby teams ---
        radiant_steam = [fetch_steam_id(str(pid)) for pid in radiant_users]
        dire_steam = [fetch_steam_id(str(pid)) for pid in dire_users]
        logger.info(f"Radiant steam: {radiant_steam}")
        logger.info(f"Dire steam: {dire_steam}")
        success = dota_talker.update_lobby_teams(game_id, radiant_steam, dire_steam)
        if not success:
            logger.warning(f"[Coordinator] Failed to update Dota lobby for game {game_id}")

        # Removed redundant message updating
        # --- Step 6: Update the Discord embed ---
        # message = lobby_messages.get(game_id)
        # if message:
        #     embed = self.discordBot.build_game_embed(game_id)
        #     await message.edit(embed=embed)
        #     logger.info(f"[Coordinator] Updated Discord embed for rebalanced teams in game {game_id}")
        # else:
        #     logger.warning(f"[Coordinator] No lobby message found for game {game_id}")

        logger.info(f"[Coordinator] Finished rebalancing teams for game {game_id}")
        return True

    def make_game(self) -> Tuple[List[int], List[int], Set[int]]:
        """Form two balanced teams using weighted fairness (older players have higher chance)."""
        if len(self.queue) < config["TEAM_SIZE"] * 2:
            raise ValueError("Not enough players to make a game.")

        now = time.time()
        users = []
        weights = []

        # --- Step 1: Calculate weights based on time waited ---
        for user, (rating, join_time, rand) in self.queue.items():
            wait_time = now - join_time
            # Weight function: stronger bias for longer waits
            weights.append(max(wait_time, 1.0) ** 2)
            users.append(user)

        # --- Step 2: Weighted random selection ---
        chosen_users = random.choices(users, weights=weights, k=config["TEAM_SIZE"] * 2)

        # Remove duplicates (choices() allows replacement)
        chosen_users = list(dict.fromkeys(chosen_users))

        # Fill remaining slots if duplicates reduced count
        if len(chosen_users) < config["TEAM_SIZE"] * 2:
            for u in users:
                if u not in chosen_users:
                    chosen_users.append(u)
                if len(chosen_users) >= config["TEAM_SIZE"] * 2:
                    break

        ratings = [self.queue[u][0] for u in chosen_users]

        # --- Step 3: Balance teams based on rating fairness ---
        heap: list[Tuple[int, list[int]]] = []  # stores (-diff, team1_indices)

        for team1_indices in itertools.combinations(range(config["TEAM_SIZE"] * 2), config["TEAM_SIZE"]):
            team1 = [ratings[i] for i in team1_indices]
            team2 = [ratings[i] for i in range(config["TEAM_SIZE"] * 2) if i not in team1_indices]

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

        team1_users = [chosen_users[i] for i in selected_partition]
        team2_users = [chosen_users[i] for i in range(config["TEAM_SIZE"] * 2) if i not in selected_partition]

        # --- Step 4: Remove selected players from queue ---
        for user in team1_users + team2_users:
            del self.queue[user]

        cut_players = set(self.queue.keys())

        logger.info(f"[Coordinator] Formed game with weighted fairness. Cut players: {cut_players}")
        return team1_users, team2_users, cut_players


if __name__ == "__main__":
    coordinator = TheCoordinator(None, None)

    players = {}

    for i in range(config["TEAM_SIZE"] * 2 * 2):
        players[str(i)] = random.randint(1000, 6000)
        print(f"added player {str(i)} with skill {players[str(i)]}")
        coordinator.add_player(str(i), players[str(i)])

    for player, (rating, join_time, rand) in coordinator.queue.items():
        human_time = datetime.fromtimestamp(join_time).strftime("%Y-%m-%d %H:%M:%S")
        print(f"{player} : (rating={rating}, join_time={human_time}, rand={rand})")

    teamA, teamB, leftover = coordinator.make_game()
    print(teamA)
    print(teamB)
    teamA_ratings = sorted(players[x] for x in teamA)
    teamB_ratings = sorted(players[x] for x in teamB)
    print(teamA_ratings)
    print(teamB_ratings)
    print(f"teamA: {power_mean(teamA_ratings)}")
    print(f"teamB: {power_mean(teamB_ratings)}")
    print(f"unfun: {unfun_score(teamA_ratings, teamB_ratings, config['UNFUN_MOD'])}")
