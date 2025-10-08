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

let contractABI = null;
let contract = null;
let contractWithSigner = null;

try {
  contractABI = require('./artifacts/contracts/MemorixGame.sol/MemorixGame.json').abi;
  contract = new ethers.Contract(contractAddress, contractABI, provider);
} catch (err) {
  console.warn('Could not load contract ABI:', err.message);
}

let ownerWallet = null;
try {
  ownerWallet = new ethers.Wallet(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    provider
  );
  if (contract) contractWithSigner = contract.connect(ownerWallet);
} catch (err) {
  console.warn('Could not create owner wallet:', err.message);
}

// In-memory state
const activeRounds = new Map();
const playerLevels = new Map();

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
  const timeLeftMs = Math.max(0, timeLimitMs - timeElapsedMs);
  const timeBonus = Math.floor(timeLeftMs * scoring.timeBonusPerMs);
  let score = Math.floor((basePoints * percentCorrect) + timeBonus);
  
  if (correctSteps === totalSteps && totalSteps > 0) {
    score = Math.floor(score * scoring.perfectRoundMultiplier);
  }
  
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

async function getPlayerCurrentLevel(playerAddress) {
  if (playerLevels.has(playerAddress)) {
    return playerLevels.get(playerAddress);
  }
  
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
  
  return 1;
}

function updatePlayerLevel(playerAddress, newLevel) {
  playerLevels.set(playerAddress, newLevel);
}

// Get full leaderboard sorted by level then score
async function getFullLeaderboard() {
  try {
    if (!contract) return [];
    
    const allPlayersAddresses = await contract.getAllPlayers();
    const leaderboard = [];
    
    for (const address of allPlayersAddresses) {
      try {
        const stats = await contract.playerStats(address);
        leaderboard.push({
          address: address,
          level: stats.currentLevel.toNumber(),
          score: stats.totalScore.toNumber(),
          bestScore: stats.bestScore.toNumber()
        });
      } catch (err) {
        console.warn(`Error fetching stats for ${address}:`, err.message);
      }
    }
    
    // Sort by level (desc), then by score (desc)
    leaderboard.sort((a, b) => {
      if (b.level !== a.level) return b.level - a.level;
      return b.score - a.score;
    });
    
    return leaderboard;
  } catch (error) {
    console.error('Error getting full leaderboard:', error);
    return [];
  }
}

// ---------- New: Payout countdown helpers ----------
function getNextPayoutDateUTC(timeStr) {
  // timeStr expected like "19:53"
  const [hh, mm] = timeStr.split(':').map(s => parseInt(s, 10));
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, 0, 0));
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}
function formatMs(ms) {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${hh.toString().padStart(2,'0')}:${mm.toString().padStart(2,'0')}:${ss.toString().padStart(2,'0')}`;
}
let payoutCountdownInterval = null;
function startPayoutCountdownPrinter() {
  try {
    if (payoutCountdownInterval) clearInterval(payoutCountdownInterval);
    payoutCountdownInterval = setInterval(() => {
      const now = new Date();
      const next = getNextPayoutDateUTC(config.leaderboard.updateSchedule.dailyResetTime);
      const msLeft = Math.max(0, next.getTime() - now.getTime());
      process.stdout.write(`\r⏳ Time until next leaderboard payout (UTC ${config.leaderboard.updateSchedule.dailyResetTime}): ${formatMs(msLeft)}    `);
      if (msLeft === 0) {
        process.stdout.write('\n');
      }
    }, 1000);
  } catch (err) {
    console.warn('Could not start payout countdown:', err.message);
  }
}

// Schedule daily leaderboard payout
function scheduleLeaderboardPayout() {
  try {
    const resetTime = config.leaderboard.updateSchedule.dailyResetTime.split(':');
    const hour = parseInt(resetTime[0]);
    const minute = parseInt(resetTime[1]);
    
    // Cron format: minute hour day month weekday
    const cronExpression = `${minute} ${hour} * * *`;
    
    cron.schedule(cronExpression, async () => {
      const now = new Date();
      console.log(`\n⏰ [${now.toISOString()}] Scheduled leaderboard payout triggered!`);
      console.log('🏆 Running daily leaderboard payout...');
      await processLeaderboardPayout();
    }, {
      timezone: config.leaderboard.updateSchedule.timezone || "UTC"
    });
    
    console.log(`⏰ Leaderboard payout scheduled: "${cronExpression}" (${config.leaderboard.updateSchedule.timezone || 'UTC'})`);
    console.log(`   Next payout at: ${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')} daily`);
    startPayoutCountdownPrinter();
  } catch (err) {
    console.warn('Could not schedule leaderboard payout:', err.message);
  }
}

async function processLeaderboardPayout() {
  try {
    console.log('📊 Fetching full leaderboard for payout...');
    const fullLeaderboard = await getFullLeaderboard();
    
    if (fullLeaderboard.length === 0) {
      console.log('No players to reward');
      playerLevels.clear();
      return;
    }
    
    console.log(`Found ${fullLeaderboard.length} players total`);
    
    const topCount = config.leaderboard.topPlayersCount || 10;
    const topPlayers = fullLeaderboard.slice(0, topCount);
    
    // Prepare arrays expected by the contract
    const addresses = new Array(topCount).fill(ethers.constants.AddressZero);
    const scores = new Array(topCount).fill(0);
    const levels = new Array(topCount).fill(0);
    
    topPlayers.forEach((entry, index) => {
      addresses[index] = entry.address;
      scores[index] = entry.score;
      levels[index] = entry.level;
      console.log(`  ${index + 1}. ${entry.address.substring(0, 6)}...${entry.address.substring(38)} - Level ${entry.level}, Score ${entry.score}`);
    });
    
    if (!contractWithSigner) {
      console.warn('Contract/signer not available - skipping on-chain update');
      playerLevels.clear();
      return;
    }
    
    try {
      console.log('💰 Distributing rewards to top 10...');
      // double-check owner before sending
      try {
        const onChainOwner = await contract.owner();
        if (onChainOwner.toLowerCase() !== ownerWallet.address.toLowerCase()) {
          console.error(`Aborting: signer (${ownerWallet.address}) is not contract owner (${onChainOwner}). Transaction would revert.`);
        } else {
          const tx = await contractWithSigner.updateLeaderboard(addresses, scores, levels);
          console.log('   tx submitted, hash:', tx.hash);
          const receipt = await tx.wait();
          console.log('   tx mined in block', receipt.blockNumber);
          console.log('✅ Leaderboard updated and rewards distributed');
        }
      } catch (preErr) {
        console.error('Pre-check failed for updateLeaderboard:', preErr && preErr.message ? preErr.message : preErr);
      }
    } catch (err) {
      console.error('Error calling updateLeaderboard (full error):', err);
      if (err.error && err.error.message) console.error('  nested error.message:', err.error.message);
      if (err.reason) console.error('  reason:', err.reason);
      if (err.data) console.error('  data:', err.data);
    }
    
    try {
      console.log('🔄 Resetting daily stats for ALL players...');
      const allAddresses = fullLeaderboard.map(p => p.address);
      
      // Reset in batches of 50 to avoid gas limits
      const batchSize = 50;
      for (let i = 0; i < allAddresses.length; i += batchSize) {
        const batch = allAddresses.slice(i, i + batchSize);
        const tx2 = await contractWithSigner.resetDailyStats(batch);
        console.log(`   reset batch ${Math.floor(i / batchSize) + 1} - tx submitted: ${tx2.hash}`);
        await tx2.wait();
        console.log(`  Reset batch ${Math.floor(i / batchSize) + 1} (${batch.length} players)`);
      }
      
      console.log('✅ All player stats reset');
    } catch (err) {
      console.error('Error calling resetDailyStats:', err && err.message ? err.message : err);
    }
    
    playerLevels.clear();
    console.log('🎉 Leaderboard payout complete!\n');
    
  } catch (error) {
    console.error('Error processing leaderboard payout:', error);
  }
}

// API Routes
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    contractAddress,
    network: config.blockchain.network,
    leaderboardNextReset: 'Daily at ' + config.leaderboard.updateSchedule.dailyResetTime
  });
});

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

app.post('/api/round/start/infinite', async (req, res) => {
  try {
    const { playerAddress, level } = req.body;
    
    if (!playerAddress) {
      return res.status(400).json({ success: false, error: 'Player address required' });
    }
    
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
        break;
      }
    }
    
    const timeElapsedMs = Date.now() - round.startTime;
    const isPerfect = correctSteps === round.steps;
    const timeExpired = timeElapsedMs > round.timeLimit;
    const passed = isPerfect && !timeExpired;
    
    const score = calculateInfiniteScore(correctSteps, round.steps, timeElapsedMs, round.timeLimit, round.level);
    const verification = verifyRound(round, telemetry);
    
    let nextLevel = round.level;
    if (isPerfect && verification.passed && !timeExpired) {
      nextLevel = round.level + 1;
      updatePlayerLevel(playerAddress, nextLevel);
      console.log(`Level up! ${playerAddress} -> Level ${nextLevel}`);
    }
    
    let txHash = null;
    if (verification.passed && contractWithSigner) {
      try {
        const tx = await contractWithSigner.recordInfiniteRound(
          playerAddress,
          score,
          nextLevel,
          timeElapsedMs,
          passed
        );
        const receipt = await tx.wait();
        txHash = receipt.transactionHash;
      } catch (err) {
        console.warn('Error recording infinite round:', err.message || err);
      }
    }
    
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

app.post('/api/round/start/daily', async (req, res) => {
  try {
    const { playerAddress } = req.body;
    
    if (!playerAddress) {
      return res.status(400).json({ success: false, error: 'Player address required' });
    }
    
    const dateNum = getTodayDateNum();
    let triesUsed = 0;
    let completed = false;
    
    try {
      if (contract) {
        const status = await contract.getDailyStatus(dateNum, playerAddress);
        triesUsed = status.triesUsed.toNumber();
        completed = status.completed;
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
        break;
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
        console.warn('Error recording daily challenge:', err.message || err);
      }
    }
    
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

app.get('/api/player/:address/stats', async (req, res) => {
  try {
    if (!contract) {
      return res.status(503).json({ success: false, error: 'Contract unavailable' });
    }
    const stats = await contract.playerStats(req.params.address);
    const pendingRewards = await contract.pendingRewards(req.params.address);
    
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

// Get full leaderboard (all players, sorted)
app.get('/api/leaderboard', async (req, res) => {
  try {
    const fullLeaderboard = await getFullLeaderboard();
    
    const formattedLeaderboard = fullLeaderboard.map((entry, index) => ({
      rank: index + 1,
      address: entry.address,
      score: entry.score,
      level: entry.level,
      bestScore: entry.bestScore
    }));
    
    res.json({ 
      success: true, 
      leaderboard: formattedLeaderboard,
      nextReset: config.leaderboard.updateSchedule.dailyResetTime,
      totalPlayers: formattedLeaderboard.length
    });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch leaderboard' });
  }
});

app.get('/api/player/:address/rounds', async (req, res) => {
  try {
    if (!contract) {
      return res.status(503).json({ success: false, error: 'Contract unavailable' });
    }
    const roundIds = await contract.getPlayerRounds(req.params.address);
    const rounds = [];
    
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

// Manual admin trigger for testing
app.post('/api/admin/trigger-payout', async (req, res) => {
  try {
    console.log('\n🔔 Admin triggered leaderboard payout (manual).');
    await processLeaderboardPayout();
    res.json({ success: true, message: 'Triggered leaderboard payout (see server logs).' });
  } catch (err) {
    console.error('Error in manual trigger:', err);
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

app.get('/', (req, res) => res.send('Memorix Backend Server is running'));

const PORT = config.server.port || 3001;
app.listen(PORT, () => {
  console.log(`\n🎮 Memorix Backend Server running on port ${PORT}`);
  console.log(`📍 Contract Address: ${contractAddress}`);
  console.log(`🌐 Network: ${config.blockchain.network}`);
  console.log(`⏰ Leaderboard resets daily at ${config.leaderboard.updateSchedule.dailyResetTime} UTC`);
  console.log(`\n✅ Server ready!\n`);
  
  // Startup diagnostics
  (async () => {
    try {
      console.log('🔎 Running startup blockchain diagnostics...');
      if (!contract) {
        console.warn('⚠️ Contract instance not available (ABI load failed or incorrect path).');
      } else {
        try {
          const ownerOnChain = await contract.owner();
          console.log(`   Contract owner on-chain: ${ownerOnChain}`);
        } catch (err) {
          console.warn('   Could not read contract.owner():', err.message);
        }
      }

      if (!ownerWallet) {
        console.warn('⚠️ ownerWallet not available — signer not created.');
      } else {
        console.log(`   Owner wallet address (local signer): ${ownerWallet.address}`);
      }

      if (contract && ownerWallet) {
        try {
          const ownerOnChain = await contract.owner();
          if (ownerOnChain.toLowerCase() !== ownerWallet.address.toLowerCase()) {
            console.warn('❗ Signer address DOES NOT MATCH contract owner — on-chain onlyOwner calls will revert.');
            console.warn(`   on-chain owner: ${ownerOnChain} | signer: ${ownerWallet.address}`);
          } else {
            console.log('   Signer matches contract owner — on-chain admin calls should be authorized.');
          }
        } catch (err) {
          // ignore
        }
      }

      try {
        const bal = await provider.getBalance(contractAddress);
        console.log(`   Contract ETH balance: ${ethers.utils.formatEther(bal)} ETH`);
      } catch (err) {
        console.warn('   Could not fetch contract balance:', err.message);
      }

      try {
        if (contract) {
          const pool = await contract.leaderboardTotalPool();
          console.log(`   Contract leaderboardTotalPool (on-chain): ${ethers.utils.formatEther(pool)} ETH`);
        }
      } catch (err) {
        // not critical
      }

    } catch (err) {
      console.warn('Startup diagnostics failed:', err.message);
    }

    // Start the payout schedule after diagnostics
    scheduleLeaderboardPayout();
  })();
});

// Global error handlers for better debugging
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
