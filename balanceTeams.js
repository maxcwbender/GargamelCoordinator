const TEAM_SIZE = 5;
const POWER_MEAN_P = 5;
const UNFUN_MOD = 2;
const TOP_K = 5;
/**
 * Log-space power mean to avoid overflow with large MMR values.
 * Computes (Σ rᵖ / n)^(1/p) using logarithms for numerical stability.
 */
function powerMean(ratings, p = POWER_MEAN_P) {
  // For each rating r, we need r^p. In log space: p * ln(r).
  // We use the log-sum-exp trick to avoid overflow:
  //   log(Σ r^p) = log(Σ exp(p*log(r)))
  //             = max + log(Σ exp(p*log(r) - max))
  const logValues = ratings.map((r) => p * Math.log(r));
  const maxLog = Math.max(...logValues);
  const logSum = maxLog + Math.log(
    logValues.reduce((sum, lv) => sum + Math.exp(lv - maxLog), 0)
  );
  // (Σ r^p / n)^(1/p) = exp((1/p) * (log(Σ r^p) - log(n)))
  return Math.floor(Math.exp((logSum - Math.log(ratings.length)) / p));
}

function unfunScore(team1Ratings, team2Ratings, p = UNFUN_MOD) {
  let sum = 0;
  for (let i = 0; i < team1Ratings.length; i++) {
    sum += Math.pow(Math.abs(team1Ratings[i] - team2Ratings[i]), p);
  }
  return Math.floor(Math.pow(sum, 1 / p));
}

function getCombinations(arr, k) {
  const results = [];
  function combine(start, combo) {
    if (combo.length === k) {
      results.push([...combo]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      combine(i + 1, combo);
      combo.pop();
    }
  }
  combine(0, []);
  return results;
}

function weightedRandomChoice(items, weights) {
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let rand = Math.random() * totalWeight;
  for (let i = 0; i < items.length; i++) {
    rand -= weights[i];
    if (rand <= 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * Evaluate the quality of a match based on MMR spread.
 * Returns a score from 0 to 1, where 1 is a perfectly matched game.
 * Uses exponential decay so the score never hits exactly 0 — it stays
 * informative even for extreme spreads (e.g. 2k vs 15k).
 *
 * @param {number[]} ratings - All player MMR ratings in the game
 * @returns {number} Quality score between 0 and 1
 */
function gameQuality(ratings) {
  const spread = Math.max(...ratings) - Math.min(...ratings);
  // Exponential decay: quality halves every 2000 MMR of spread.
  // 0 spread => 1.0, 2000 spread => 0.5, 4000 => 0.25, 8000 => 0.06, etc.
  const halfLife = 2000;
  return Math.pow(0.5, spread / halfLife);
}

/**
 * Balance 10 players into two teams of 5 using power mean and unfun score.
 *
 * @param {Array<{id: any, mmr: number}>} players - 10 players with id and mmr
 * @returns {{team1: Array<{id: any, mmr: number}>, team2: Array<{id: any, mmr: number}>, quality: number}}
 *   quality is 0-1 indicating how fair the game is (1 = perfect, 0 = extremely lopsided)
 */
function balanceTeams(players) {
  if (players.length !== TEAM_SIZE * 2) {
    throw new Error(`Expected ${TEAM_SIZE * 2} players, got ${players.length}`);
  }

  const ratings = players.map((p) => p.mmr);
  const quality = gameQuality(ratings);
  const indices = Array.from({ length: TEAM_SIZE * 2 }, (_, i) => i);

  // Min-heap of size TOP_K tracking the best (lowest badness+diff) partitions.
  // We store {score: -(badness+diff), team1Indices} and keep the worst of our
  // top-K at the front so we can evict it when we find something better.
  const heap = [];

  for (const team1Indices of getCombinations(indices, TEAM_SIZE)) {
    const team1IndicesSet = new Set(team1Indices);
    const team2Indices = indices.filter((i) => !team1IndicesSet.has(i));

    const team1 = team1Indices.map((i) => ratings[i]).sort((a, b) => a - b);
    const team2 = team2Indices.map((i) => ratings[i]).sort((a, b) => a - b);

    const team1Rating = powerMean(team1);
    const team2Rating = powerMean(team2);
    const diff = Math.abs(team1Rating - team2Rating);
    const badness = unfunScore(team1, team2);

    const negScore = -(badness + diff);

    // Maintain a max-heap (by negScore) of size TOP_K.
    // Since JS has no built-in heap, we use a sorted insert + trim approach
    // which is fine for k=5 over 252 combinations.
    heap.push({ score: negScore, team1Indices });
    heap.sort((a, b) => a.score - b.score); // most negative first (best)
    if (heap.length > TOP_K) {
      heap.pop(); // remove the worst (least negative score)
    }
  }

  // Weighted random selection: lower badness+diff => higher probability
  const weights = heap.map((entry) => 1 / (-entry.score + 1e-6));
  const selected = weightedRandomChoice(heap, weights);

  const team1IndicesSet = new Set(selected.team1Indices);
  const team1 = selected.team1Indices.map((i) => players[i]);
  const team2 = players.filter((_, i) => !team1IndicesSet.has(i));

  return { team1, team2, quality };
}

module.exports = { balanceTeams, powerMean, unfunScore, gameQuality };
