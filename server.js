// server.js
const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const fs = require('fs');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

// Load configuration
const config = JSON.parse(fs.readFileSync('game-config.json', 'utf8'));
const deploymentInfo = JSON.parse(fs.readFileSync('deployment-info.json', 'utf8'));

// Blockchain setup
const provider = new ethers.providers.JsonRpcProvider(config.blockchain.rpcUrl);
const contractAddress = deploymentInfo.contractAddress || config.blockchain.contractAddress;

// Try to load ABI — make contract optional if ABI missing
let contractABI = null;
let contract = null;
let contractWithSigner = null;
try {
  contractABI = require('./artifacts/contracts/MemorixGame.sol/MemorixGame.json').abi;
  contract = new ethers.Contract(contractAddress, contractABI, provider);
} catch (err) {
  console.warn('Could not load contract ABI or create contract instance:', err.message);
  contract = null;
}

// Owner wallet for contract interactions (NOTE: don't hardcode in production)
let ownerWallet = null;
if (config.blockchain.ownerPrivateKey) {
  try {
    ownerWallet = new ethers.Wallet(config.blockchain.ownerPrivateKey, provider);
    if (contract) contractWithSigner = contract.connect(ownerWallet);
  } catch (err) {
    console.warn('Could not create owner wallet:', err.message);
  }
} else {
  // fallback used in your original snippet — still warn
  try {
    ownerWallet = new ethers.Wallet(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      provider
    );
    if (contract) contractWithSigner = contract.connect(ownerWallet);
    console.warn('Using fallback owner private key from code. Replace with config in production.');
  } catch (err) {
    console.warn('Could not create fallback owner wallet:', err.message);
  }
}

// In-memory state
const activeRounds = new Map();
const leaderboardScores = new Map(); // playerAddress => {score, level}
const playerLevels = new Map(); // Track player levels in-memory to avoid contract sync issues

// Helper functions
function getTodayDateNum() {
  const today = new Date();
  return parseInt(
    today.getFullYear().toString() +
    (today.getMonth() + 1).toString().padStart(2, '0') +
    today.getDate().toString().padStart(2, '0')
  );
}

function generateSequence(gridSize, steps) {
  const maxIndex = gridSize * gridSize - 1;
  const sequence = [];
  for (let i = 0; i < steps; i++) {
    sequence.push(Math.floor(Math.random() * (maxIndex + 1)));
  }
  return sequence;
}

function calculateInfiniteDifficulty(level) {
  const base = config.infiniteMode.baseDifficulty;
  const scaling = config.infiniteMode.difficultyScaling;
  
  const gridSize = Math.min(
    scaling.maxGridSize,
    base.gridSize + Math.floor((level - 1) / scaling.gridSizeIncreaseEvery)
  );
  
  const steps = Math.floor(base.steps + ((level - 1) * scaling.stepsIncreaseRate));
  
  const timeLimit = Math.max(
    scaling.minTimeLimit,
    config.infiniteMode.baseTimeLimit - ((level - 1) * scaling.timeLimitDecreasePerLevel)
  );
  
  const showDuration = Math.max(
    scaling.minShowDuration,
    base.showDuration - ((level - 1) * scaling.showDurationDecreasePerLevel)
  );
  
  const intervalBetween = Math.max(
    scaling.minInterval,
    base.intervalBetween - ((level - 1) * scaling.intervalDecreasePerLevel)
  );
  
  return { gridSize, steps, timeLimit, showDuration, intervalBetween };
}

function calculateInfiniteScore(correctSteps, totalSteps, timeElapsedMs, timeLimitMs, level) {
  const scoring = config.infiniteMode.scoring;
  
  const basePoints = totalSteps * scoring.basePointsPerStep;
  const percentCorrect = totalSteps > 0 ? (correctSteps / totalSteps) : 0;
  
  // Time bonus based on how fast they were
  const timeLeftMs = Math.max(0, timeLimitMs - timeElapsedMs);
  const timeBonus = Math.floor(timeLeftMs * scoring.timeBonusPerMs);
  
  let score = Math.floor((basePoints * percentCorrect) + timeBonus);
  
  // Perfect round bonus
  if (correctSteps === totalSteps && totalSteps > 0) {
    score = Math.floor(score * scoring.perfectRoundMultiplier);
  }
  
  // Level multiplier
  score = Math.floor(score * Math.pow(scoring.levelMultiplier, Math.max(0, level - 1)));
  
  return score;
}

function calculateDailyScore(correctSteps, totalSteps, timeElapsedMs, timeLimitMs) {
  const basePoints = totalSteps * 20;
  const percentCorrect = totalSteps > 0 ? (correctSteps / totalSteps) : 0;
  
  const timeLeftMs = Math.max(0, timeLimitMs - timeElapsedMs);
  const timeBonus = Math.floor(timeLeftMs * 0.2);
  
  let score = Math.floor((basePoints * percentCorrect) + timeBonus);
  
  if (correctSteps === totalSteps && totalSteps > 0) {
    score = Math.floor(score * 1.5);
  }
  
  return score;
}

function verifyRound(roundData, telemetry) {
  if (!config.antiCheat || !config.antiCheat.enabled) return { passed: true, reasons: [] };
  
  const checks = { passed: true, reasons: [] };
  
  if (!telemetry || !telemetry.clicks || telemetry.clicks.length === 0) {
    return checks;
  }
  
  const reactionTimes = telemetry.clicks.map((click, i) => {
    if (i === 0) return click.clientTs - (telemetry.sequenceStartTs || click.clientTs);
    return click.clientTs - telemetry.clicks[i-1].clientTs;
  });
  
  const avgReaction = reactionTimes.reduce((a, b) => a + b, 0) / reactionTimes.length;
  
  if (avgReaction < config.antiCheat.minReactionTimeMs) {
    checks.passed = false;
    checks.reasons.push('Suspiciously fast reactions');
  }
  
  return checks;
}

// Update leaderboard rankings
function updateLeaderboardRankings(playerAddress, currentLevel, incrementalScore) {
  if (!playerAddress) return;
  const existing = leaderboardScores.get(playerAddress) || { level: 1, score: 0 };
  // keep the highest level seen during the day (if player levels up, keep it)
  const newLevel = Math.max(existing.level || 1, currentLevel || 1);
  const newScore = (existing.score || 0) + (incrementalScore || 0);
  leaderboardScores.set(playerAddress, { level: newLevel, score: newScore });
}

// Get player's current level (from memory or contract)
async function getPlayerCurrentLevel(playerAddress) {
  // Check in-memory first
  if (playerLevels.has(playerAddress)) {
    return playerLevels.get(playerAddress);
  }
  
  // Otherwise try to fetch from contract
  try {
    if (contract) {
      const stats = await contract.playerStats(playerAddress);
      const level = stats.currentLevel ? stats.currentLevel.toNumber() : 1;
      playerLevels.set(playerAddress, level);
      return level;
    }
  } catch (err) {
    console.warn('Could not fetch level from contract:', err.message);
  }
  
  // Default to level 1
  return 1;
}

// Update player's level in memory
function updatePlayerLevel(playerAddress, newLevel) {
  playerLevels.set(playerAddress, newLevel);
}

// Schedule daily leaderboard payout
function scheduleLeaderboardPayout() {
  try {
    const resetTime = config.leaderboard.updateSchedule.dailyResetTime.split(':');
    const hour = parseInt(resetTime[0]);
    const minute = parseInt(resetTime[1]);
    
    // Run every day at specified time (server timezone) — cron format: minute hour day month weekday
    cron.schedule(`${minute} ${hour} * * *`, async () => {
      console.log('Running daily leaderboard payout...');
      await processLeaderboardPayout();
    });
    
    console.log(`Leaderboard payout scheduled for ${hour}:${minute} ${config.leaderboard.updateSchedule.timezone} daily`);
  } catch (err) {
    console.warn('Could not schedule leaderboard payout:', err.message);
  }
}

async function processLeaderboardPayout() {
  try {
    // Sort players by level first, then score
    const sortedPlayers = Array.from(leaderboardScores.entries())
      .sort((a, b) => {
        if (b[1].level !== a[1].level) return b[1].level - a[1].level;
        return b[1].score - a[1].score;
      })
      .slice(0, config.leaderboard.topPlayersCount || 10);

    if (sortedPlayers.length === 0) {
      console.log('No players to reward');
      // still clear in-memory (defensive)
      leaderboardScores.clear();
      playerLevels.clear();
      return;
    }

    const topCount = config.leaderboard.topPlayersCount || 10;

    // Prepare arrays sized to topCount (fill with zero-address / zeros if fewer players)
    const addresses = new Array(topCount).fill(ethers.constants.AddressZero);
    const scores = new Array(topCount).fill(0);
    const levels = new Array(topCount).fill(0);

    sortedPlayers.forEach((entry, index) => {
      addresses[index] = entry[0];
      scores[index] = entry[1].score;
      levels[index] = entry[1].level;
    });

    if (!contractWithSigner) {
      console.warn('Contract/signer not available — skipping on-chain leaderboard update. Logging to console instead.');
      console.log('Would update leaderboard with:', { addresses, scores, levels });

      // Still reset in-memory for next day
      leaderboardScores.clear();
      playerLevels.clear();
      return;
    }

    // Call contract to update leaderboard and distribute rewards
    try {
      console.log('Calling contract.updateLeaderboard(...) with top players...');
      const tx = await contractWithSigner.updateLeaderboard(addresses, scores, levels);
      await tx.wait();
      console.log('✅ Leaderboard updated and rewards distributed (on-chain)');
    } catch (err) {
      console.error('Error while calling updateLeaderboard on chain:', err.message);
    }

    // --- NEW: Reset daily stats & levels on-chain for players we want to reset ---
    // We'll reset the players we included in the leaderboard arrays (non-zero addresses).
    try {
      // create list of addresses to reset (exclude zero address)
      const toReset = addresses.filter(a => a !== ethers.constants.AddressZero);
      if (toReset.length > 0) {
        // contract function resetDailyStats(address[] memory players) must exist in the contract (see solidity changes)
        const tx2 = await contractWithSigner.resetDailyStats(toReset);
        await tx2.wait();
        console.log('✅ On-chain daily stats/levels reset for top players');
      } else {
        console.log('No top players to reset on-chain.');
      }
    } catch (err) {
      console.error('Error while calling resetDailyStats on chain:', err.message);
    }

    // Clear memory maps for next day
    leaderboardScores.clear();
    playerLevels.clear();

  } catch (error) {
    console.error('Error processing leaderboard payout:', error);
  }
}
// API Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    contractAddress,
    network: config.blockchain.network,
    leaderboardNextReset: 'Daily at ' + config.leaderboard.updateSchedule.dailyResetTime
  });
});

// Get game config (for frontend)
app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    config: {
      infiniteMode: config.infiniteMode,
      dailyChallenge: config.dailyChallenge,
      leaderboard: config.leaderboard
    }
  });
});

// Start infinite round
app.post('/api/round/start/infinite', async (req, res) => {
  try {
    const { playerAddress, level } = req.body;
    
    if (!playerAddress) {
      return res.status(400).json({ success: false, error: 'Player address required' });
    }
    
    // Get current level from memory/contract
    const currentLevel = level ? parseInt(level) : await getPlayerCurrentLevel(playerAddress);
    const difficulty = calculateInfiniteDifficulty(currentLevel);
    
    const roundId = `infinite_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const sequence = generateSequence(difficulty.gridSize, difficulty.steps);
    
    const round = {
      roundId,
      playerAddress,
      sequence,
      ...difficulty,
      roundType: 'INFINITE',
      level: currentLevel,
      startTime: Date.now()
    };
    
    activeRounds.set(roundId, round);
    
    res.json({
      success: true,
      roundId,
      sequence,
      ...difficulty,
      level: currentLevel
    });
  } catch (error) {
    console.error('Error starting infinite round:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Submit infinite round
app.post('/api/round/submit/infinite', async (req, res) => {
  try {
    const { roundId, playerAddress, clicks, telemetry } = req.body;
    
    const round = activeRounds.get(roundId);
    if (!round) {
      return res.status(404).json({ success: false, error: 'Round not found' });
    }
    
    if (round.playerAddress !== playerAddress) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    
    let correctSteps = 0;
    const clickedSequence = (clicks || []).map(c => c.index);
    
    for (let i = 0; i < Math.min(clickedSequence.length, round.sequence.length); i++) {
      if (clickedSequence[i] === round.sequence[i]) {
        correctSteps++;
      } else {
        break; // Stop at first mistake
      }
    }
    
    const timeElapsedMs = Date.now() - round.startTime;
    const isPerfect = correctSteps === round.steps;
    const timeExpired = timeElapsedMs > round.timeLimit;
    const passed = isPerfect && !timeExpired;
    
    const score = calculateInfiniteScore(correctSteps, round.steps, timeElapsedMs, round.timeLimit, round.level);
    const verification = verifyRound(round, telemetry);
    
    // Determine next level BEFORE recording on blockchain
    let nextLevel = round.level;
    if (isPerfect && verification.passed && !timeExpired) {
      nextLevel = round.level + 1;
      updatePlayerLevel(playerAddress, nextLevel); // Update in-memory immediately
      console.log(`Level up! ${playerAddress} -> Level ${nextLevel}`);
    }
    
    // Record on blockchain (if available)
    let txHash = null;
    
    if (verification.passed && contractWithSigner) {
      try {
        const tx = await contractWithSigner.recordInfiniteRound(
          playerAddress,
          score,
          nextLevel, // Send the NEXT level to contract
          timeElapsedMs,
          passed
        );
        const receipt = await tx.wait();
        txHash = receipt.transactionHash;
      } catch (err) {
        console.warn('Error recording infinite round on chain:', err.message);
      }
    } else if (!contractWithSigner) {
      console.warn('contractWithSigner not available — skipping on-chain record for infinite round');
    }
    
    // Update leaderboard with the NEXT level (if they leveled up)
    updateLeaderboardRankings(playerAddress, nextLevel, score);
    
    activeRounds.delete(roundId);
    
    res.json({
      success: true,
      score,
      correctSteps,
      totalSteps: round.steps,
      timeElapsedMs,
      timeExpired,
      verified: verification.passed,
      isPerfect,
      canContinue: isPerfect && verification.passed && !timeExpired,
      nextLevel,
      currentLevel: round.level,
      txHash,
      message: isPerfect ? 
        `Perfect! Level ${round.level} complete! Moving to Level ${nextLevel}` : 
        `Got ${correctSteps}/${round.steps} correct. Try again!`
    });
    
  } catch (error) {
    console.error('Error submitting infinite round:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get daily challenge status
app.get('/api/daily-challenge/status/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const dateNum = getTodayDateNum();
    
    let triesUsed = 0;
    let completed = false;
    
    try {
      if (contract) {
        const status = await contract.getDailyStatus(dateNum, address);
        triesUsed = status.triesUsed.toNumber();
        completed = status.completed;
      } else {
        // If no contract, assume zero for demo/testing
        triesUsed = 0;
        completed = false;
      }
    } catch (err) {
      console.warn('Error fetching daily status:', err.message);
    }
    
    res.json({
      success: true,
      dateNum,
      triesUsed,
      maxTries: config.dailyChallenge.maxTriesPerDay,
      completed,
      canPlay: triesUsed < config.dailyChallenge.maxTriesPerDay && !completed
    });
  } catch (error) {
    console.error('Error checking daily status:', error);
    res.status(500).json({ success: false, error: 'Failed to check status' });
  }
});

// Start daily challenge
app.post('/api/round/start/daily', async (req, res) => {
  try {
    const { playerAddress } = req.body;
    
    if (!playerAddress) {
      return res.status(400).json({ success: false, error: 'Player address required' });
    }
    
    const dateNum = getTodayDateNum();
    
    // Check status
    let triesUsed = 0;
    let completed = false;
    
    try {
      if (contract) {
        const status = await contract.getDailyStatus(dateNum, playerAddress);
        triesUsed = status.triesUsed.toNumber();
        completed = status.completed;
      } else {
        triesUsed = 0;
        completed = false;
      }
      
      if (triesUsed >= config.dailyChallenge.maxTriesPerDay) {
        return res.status(400).json({
          success: false,
          error: 'TRIES_EXCEEDED',
          message: `You've used all ${config.dailyChallenge.maxTriesPerDay} tries today. Come back tomorrow!`
        });
      }
      
      if (completed) {
        return res.status(400).json({
          success: false,
          error: 'ALREADY_COMPLETED',
          message: 'You already completed today\'s challenge. Come back tomorrow!'
        });
      }
    } catch (err) {
      console.warn('Error checking status:', err.message);
    }
    
    const challengeConfig = config.dailyChallenge.challenge;
    const roundId = `daily_${dateNum}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const sequence = generateSequence(challengeConfig.gridSize, challengeConfig.steps);
    
    const round = {
      roundId,
      playerAddress,
      sequence,
      gridSize: challengeConfig.gridSize,
      steps: challengeConfig.steps,
      showDuration: challengeConfig.showDuration,
      intervalBetween: challengeConfig.intervalBetween,
      timeLimit: challengeConfig.timeLimit,
      roundType: 'DAILY_CHALLENGE',
      dateNum,
      startTime: Date.now()
    };
    
    activeRounds.set(roundId, round);
    
    res.json({
      success: true,
      roundId,
      sequence,
      gridSize: challengeConfig.gridSize,
      steps: challengeConfig.steps,
      showDuration: challengeConfig.showDuration,
      intervalBetween: challengeConfig.intervalBetween,
      timeLimit: challengeConfig.timeLimit,
      difficulty: challengeConfig.difficulty
    });
  } catch (error) {
    console.error('Error starting daily round:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Submit daily challenge
app.post('/api/round/submit/daily', async (req, res) => {
  try {
    const { roundId, playerAddress, clicks, telemetry } = req.body;
    
    const round = activeRounds.get(roundId);
    if (!round) {
      return res.status(404).json({ success: false, error: 'Round not found' });
    }
    
    if (round.playerAddress !== playerAddress) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    
    let correctSteps = 0;
    const clickedSequence = (clicks || []).map(c => c.index);
    
    for (let i = 0; i < Math.min(clickedSequence.length, round.sequence.length); i++) {
      if (clickedSequence[i] === round.sequence[i]) {
        correctSteps++;
      } else {
        break; // Stop at first mistake
      }
    }
    
    const timeElapsedMs = Date.now() - round.startTime;
    const isPerfect = correctSteps === round.steps;
    const timeExpired = timeElapsedMs > round.timeLimit;
    const passed = isPerfect && !timeExpired;
    
    const score = calculateDailyScore(correctSteps, round.steps, timeElapsedMs, round.timeLimit);
    const verification = verifyRound(round, telemetry);
    
    let txHash = null;
    let rewardEarned = false;
    
    if (verification.passed && contractWithSigner) {
      try {
        const tx = await contractWithSigner.recordDailyChallenge(
          playerAddress,
          round.dateNum,
          score,
          timeElapsedMs,
          passed,
          true
        );
        const receipt = await tx.wait();
        txHash = receipt.transactionHash;
        rewardEarned = passed;
      } catch (err) {
        if (err.message && (err.message.includes('already completed') || err.message.includes('Already completed'))) {
          activeRounds.delete(roundId);
          return res.status(400).json({
            success: false,
            error: 'ALREADY_COMPLETED',
            message: 'You already completed today\'s challenge!'
          });
        }
        console.warn('Error recording daily challenge on chain:', err.message);
      }
    } else if (!contractWithSigner) {
      console.warn('contractWithSigner not available — skipping on-chain record for daily challenge');
    }
    
    // Update leaderboard
    const currentLevel = await getPlayerCurrentLevel(playerAddress);
    updateLeaderboardRankings(playerAddress, currentLevel, score);
    
    activeRounds.delete(roundId);
    
    res.json({
      success: true,
      score,
      correctSteps,
      totalSteps: round.steps,
      timeElapsedMs,
      timeExpired,
      verified: verification.passed,
      isPerfect,
      passed,
      rewardEarned,
      rewardAmount: passed ? config.dailyChallenge.rewards.rewardPerCompletion : '0',
      txHash,
      message: passed ? 
        `Perfect! You earned ${config.dailyChallenge.rewards.rewardPerCompletion} ETH!` :
        timeExpired ? 'Time expired! Try again.' : 
        `Got ${correctSteps}/${round.steps} correct. Try again!`
    });
    
  } catch (error) {
    console.error('Error submitting daily challenge:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get player stats
app.get('/api/player/:address/stats', async (req, res) => {
  try {
    if (!contract) {
      return res.status(503).json({ success: false, error: 'Contract unavailable' });
    }
    const stats = await contract.playerStats(req.params.address);
    const pendingRewards = await contract.pendingRewards(req.params.address);
    
    // Update in-memory level tracking
    const level = stats.currentLevel.toNumber();
    updatePlayerLevel(req.params.address, level);
    
    res.json({
      success: true,
      stats: {
        totalRounds: stats.totalRounds.toString(),
        totalScore: stats.totalScore.toString(),
        totalRewards: ethers.utils.formatEther(stats.totalRewards),
        bestScore: stats.bestScore.toString(),
        currentLevel: level.toString(),
        dailyTriesUsed: stats.dailyTriesUsed.toString(),
        dailyCompleted: stats.dailyCompleted,
        pendingRewards: ethers.utils.formatEther(pendingRewards)
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

// Get leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    if (!contract) {
      // fallback: return local leaderboard map sorted
      const formatted = Array.from(leaderboardScores.entries())
        .sort((a,b) => {
          if (b[1].level !== a[1].level) return b[1].level - a[1].level;
          return b[1].score - a[1].score;
        })
        .map((entry, idx) => ({
          rank: idx + 1,
          address: entry[0],
          score: entry[1].score,
          level: entry[1].level
        }));
      return res.json({ success: true, leaderboard: formatted, nextReset: config.leaderboard.updateSchedule.dailyResetTime });
    }
    
    const leaderboard = await contract.getLeaderboard();
    
    const formattedLeaderboard = leaderboard
      .map((entry, index) => ({
        rank: index + 1,
        address: entry.player,
        score: entry.score.toString(),
        level: entry.level
      }))
      .filter(e => e.address !== ethers.constants.AddressZero);
    
    res.json({ 
      success: true, 
      leaderboard: formattedLeaderboard,
      nextReset: config.leaderboard.updateSchedule.dailyResetTime
    });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch leaderboard' });
  }
});

// Get player rounds
app.get('/api/player/:address/rounds', async (req, res) => {
  try {
    if (!contract) {
      return res.status(503).json({ success: false, error: 'Contract unavailable' });
    }
    const roundIds = await contract.getPlayerRounds(req.params.address);
    const rounds = [];
    
    // fetch last up to 20 rounds
    const startIdx = Math.max(0, roundIds.length - 20);
    for (let i = startIdx; i < roundIds.length; i++) {
      const id = roundIds[i];
      const round = await contract.getRound(id);
      rounds.push({
        id: id.toString(),
        roundType: round.roundType === 0 ? 'INFINITE' : 'DAILY_CHALLENGE',
        level: round.level,
        score: round.score.toString(),
        timeElapsedMs: round.timeElapsedMs.toString(),
        reward: ethers.utils.formatEther(round.reward),
        timestamp: new Date(round.timestamp.toNumber() * 1000).toISOString(),
        verified: round.verified
      });
    }
    
    res.json({ success: true, rounds });
  } catch (error) {
    console.error('Error fetching rounds:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch rounds' });
  }
});

app.get('/', (req, res) => res.send('Memorix Backend Server is running'));

// Start server
const PORT = config.server.port || 3001;
app.listen(PORT, () => {
  console.log(`\n🎮 Memorix Backend Server running on port ${PORT}`);
  console.log(`📍 Contract Address: ${contractAddress}`);
  console.log(`🌐 Network: ${config.blockchain.network}`);
  console.log(`⏰ Leaderboard resets daily at ${config.leaderboard.updateSchedule.dailyResetTime} UTC`);
  console.log(`\n✅ Server ready!\n`);
  
  // Schedule leaderboard payout
  scheduleLeaderboardPayout();
});