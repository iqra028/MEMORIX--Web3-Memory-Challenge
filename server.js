// server.js - Cleaned and fixed version for memorix-game
const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// Load config files (ensure these exist)
const config = JSON.parse(fs.readFileSync('game-config.json', 'utf8'));
const deploymentInfo = JSON.parse(fs.readFileSync('deployment-info.json', 'utf8'));

// Provider & contract setup (local Hardhat)
const provider = new ethers.providers.JsonRpcProvider('http://127.0.0.1:8545');
const contractArtifactPath = './artifacts/contracts/MemorixGame.sol/MemorixGame.json';
let contractABI = [];
let contractAddress = deploymentInfo.contractAddress || null;

try {
  contractABI = require(contractArtifactPath).abi;
} catch (err) {
  console.warn('Could not load contract ABI from artifacts. Make sure compilation was done.', err.message);
}
if (!contractAddress) {
  console.warn('deployment-info.json missing contractAddress or it is null.');
}

const contract = new ethers.Contract(contractAddress, contractABI, provider);

// In-memory state
const activeRounds = new Map();
const telemetryData = [];

// Helpers
function generateSequence(gridSize, steps) {
  const maxIndex = gridSize * gridSize - 1;
  const sequence = [];
  for (let i = 0; i < steps; i++) {
    sequence.push(Math.floor(Math.random() * (maxIndex + 1)));
  }
  return sequence;
}

function getDifficultyForLevel(level) {
  const baseSize = 3;
  const baseSteps = 3;
  const baseTime = 30000;
  const baseShow = 600;
  const baseInterval = 400;
  
  const gridSize = Math.min(5, baseSize + Math.floor(level / 5));
  const steps = baseSteps + Math.floor(level / 2);
  const timeLimit = Math.max(10000, baseTime - (level * 500));
  const showDuration = Math.max(200, baseShow - (level * 15));
  const intervalBetween = Math.max(150, baseInterval - (level * 10));
  
  return {
    gridSize,
    steps,
    timeLimit,
    showDuration,
    intervalBetween
  };
}

function verifyRound(roundData, telemetry) {
  const checks = { passed: true, reasons: [] };
  
  if (!telemetry || !telemetry.clicks || telemetry.clicks.length === 0) {
    // No telemetry -> can't flag anti-cheat by reaction times; return passed
    return checks;
  }
  
  const reactionTimes = telemetry.clicks.map((click, i) => {
    if (i === 0) return click.clientTs - (telemetry.sequenceStartTs || click.clientTs);
    return click.clientTs - telemetry.clicks[i-1].clientTs;
  });
  
  const avgReaction = reactionTimes.reduce((a, b) => a + b, 0) / reactionTimes.length;
  
  if (config && config.antiCheat && typeof config.antiCheat.min_reaction_time_ms === 'number') {
    if (avgReaction < config.antiCheat.min_reaction_time_ms) {
      checks.passed = false;
      checks.reasons.push('Suspiciously fast reactions');
    }
  }
  
  return checks;
}

function calculateScore(correctSteps, totalSteps, timeElapsedMs, timeLimitMs) {
  // fallback scoring if config missing
  const basePointsPerStep = (config && config.scoring && config.scoring.base_points_per_step) ? config.scoring.base_points_per_step : 10;
  const timeBonusDivisor = (config && config.scoring && config.scoring.time_bonus_divisor) ? config.scoring.time_bonus_divisor : 1000;
  const accuracyWeight = (config && config.scoring && config.scoring.accuracy_weight) ? config.scoring.accuracy_weight : 0.5;
  const perfectMultiplier = (config && config.scoring && config.scoring.perfect_round_multiplier) ? config.scoring.perfect_round_multiplier : 1.2;

  const basePoints = totalSteps * basePointsPerStep;
  const percentCorrect = totalSteps > 0 ? (correctSteps / totalSteps) : 0;
  const timeBonus = Math.max(0, Math.floor((timeLimitMs - timeElapsedMs) / timeBonusDivisor));
  const accuracyBonus = Math.round(percentCorrect * basePoints * accuracyWeight);
  
  let finalScore = basePoints + timeBonus + accuracyBonus;
  
  if (correctSteps === totalSteps && totalSteps > 0) {
    finalScore = Math.floor(finalScore * perfectMultiplier);
  }
  
  return finalScore;
}

function getTodayDateNum() {
  const today = new Date();
  return parseInt(
    today.getFullYear().toString() +
    (today.getMonth() + 1).toString().padStart(2, '0') +
    today.getDate().toString().padStart(2, '0')
  );
}

// Routes

// Daily challenge status
app.get('/api/daily-challenge/status/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const dateNum = getTodayDateNum();

    // If contract has a read method `hasCompletedDailyChallenge(dateNum, address)` use it.
    let hasCompleted = false;
    try {
      if (contract && contract.hasCompletedDailyChallenge) {
        // If solidity signature is hasCompletedDailyChallenge(uint256,address)
        hasCompleted = await contract.hasCompletedDailyChallenge(dateNum, address);
      } else {
        // fallback: not available - assume not completed
        hasCompleted = false;
      }
    } catch (err) {
      console.warn('Error querying contract for daily completion:', err.message);
      hasCompleted = false;
    }

    res.json({
      success: true,
      dateNum,
      hasCompleted: !!hasCompleted,
      canPlay: !hasCompleted
    });
  } catch (error) {
    console.error('Error checking daily challenge status:', error);
    res.status(500).json({ success: false, error: 'Failed to check status' });
  }
});

// Player rounds (recent)
app.get('/api/player/:address/rounds', async (req, res) => {
  try {
    if (!contract || !contract.getPlayerRounds) {
      return res.status(500).json({ success: false, error: 'Contract method getPlayerRounds not available' });
    }

    const roundIds = await contract.getPlayerRounds(req.params.address);
    const rounds = [];
    
    for (const id of roundIds.slice(Math.max(0, roundIds.length - 10))) {
      const round = await contract.getRound(id);
      rounds.push({
        id: id.toString(),
        score: round.score.toString(),
        gridSize: round.gridSize,
        steps: round.steps,
        correctSteps: round.correctSteps,
        timeElapsedMs: round.timeElapsedMs.toString(),
        reward: ethers.utils.formatEther(round.reward || 0),
        timestamp: new Date((round.timestamp.toNumber ? round.timestamp.toNumber() : round.timestamp) * 1000).toISOString(),
        verified: !!round.verified
      });
    }
    
    res.json({ success: true, rounds });
  } catch (error) {
    console.error('Error fetching rounds:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch rounds' });
  }
});

// Health
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    status: 'healthy',
    contractAddress,
    network: 'localhost'
  });
});

// Start infinite round
app.post('/api/round/start/infinite', async (req, res) => {
  try {
    const { playerAddress, level } = req.body;
    
    if (!playerAddress) {
      return res.status(400).json({ success: false, error: 'Player address required' });
    }
    
    const currentLevel = level || 1;
    const difficultyConfig = getDifficultyForLevel(currentLevel);
    
    const roundId = `round_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const sequence = generateSequence(difficultyConfig.gridSize, difficultyConfig.steps);
    
    const round = {
      roundId,
      playerAddress,
      sequence,
      gridSize: difficultyConfig.gridSize,
      steps: difficultyConfig.steps,
      timeLimit: difficultyConfig.timeLimit,
      roundType: 'INFINITE',
      level: currentLevel,
      startTime: Date.now(),
      showDuration: difficultyConfig.showDuration,
      intervalBetween: difficultyConfig.intervalBetween,
      status: 'active'
    };
    
    activeRounds.set(roundId, round);
    
    res.json({
      success: true,
      roundId,
      sequence,
      gridSize: difficultyConfig.gridSize,
      steps: difficultyConfig.steps,
      showDuration: difficultyConfig.showDuration,
      intervalBetween: difficultyConfig.intervalBetween,
      timeLimit: difficultyConfig.timeLimit
    });
  } catch (error) {
    console.error('Error starting infinite round:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start daily round
app.post('/api/round/start/daily', async (req, res) => {
  try {
    const { playerAddress } = req.body;
    
    if (!playerAddress) {
      return res.status(400).json({ success: false, error: 'Player address required' });
    }
    
    const dateNum = getTodayDateNum();
    
    let hasCompleted = false;
    try {
      if (contract && contract.hasCompletedDailyChallenge) {
        hasCompleted = await contract.hasCompletedDailyChallenge(dateNum, playerAddress);
      }
    } catch (err) {
      console.warn('Error checking daily completion on contract:', err.message);
      hasCompleted = false;
    }

    if (hasCompleted) {
      return res.status(400).json({ 
        success: false, 
        error: 'ALREADY_COMPLETED',
        message: 'You have already completed today\'s daily challenge. Come back tomorrow!'
      });
    }
    
    const difficultyConfig = {
      gridSize: 4,
      steps: 8,
      showDuration: 400,
      intervalBetween: 250,
      timeLimit: 20000
    };
    
    const roundId = `daily_${dateNum}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const sequence = generateSequence(difficultyConfig.gridSize, difficultyConfig.steps);
    
    const round = {
      roundId,
      playerAddress,
      sequence,
      gridSize: difficultyConfig.gridSize,
      steps: difficultyConfig.steps,
      timeLimit: difficultyConfig.timeLimit,
      roundType: 'DAILY_CHALLENGE',
      dateNum,
      startTime: Date.now(),
      showDuration: difficultyConfig.showDuration,
      intervalBetween: difficultyConfig.intervalBetween,
      status: 'active'
    };
    
    activeRounds.set(roundId, round);
    
    res.json({
      success: true,
      roundId,
      sequence,
      gridSize: difficultyConfig.gridSize,
      steps: difficultyConfig.steps,
      showDuration: difficultyConfig.showDuration,
      intervalBetween: difficultyConfig.intervalBetween,
      timeLimit: difficultyConfig.timeLimit
    });
  } catch (error) {
    console.error('Error starting daily challenge:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Submit infinite round
app.post('/api/round/submit/infinite', async (req, res) => {
  try {
    const { roundId, playerAddress, clicks, telemetry, timeExpired } = req.body;
    
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
      }
    }
    
    const timeElapsedMs = Date.now() - round.startTime;
    const score = calculateScore(correctSteps, round.steps, timeElapsedMs, round.timeLimit);
    const verification = verifyRound(round, telemetry);
    
    telemetryData.push({
      roundId,
      playerAddress,
      timestamp: new Date().toISOString(),
      telemetry,
      verification
    });
    
    // Interact with contract if available
    let txHash = null;
    try {
      if (contract && contract.recordInfiniteRound) {
        const wallet = new ethers.Wallet(
          '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
          provider
        );
        const contractWithSigner = contract.connect(wallet);
        const tx = await contractWithSigner.recordInfiniteRound(
          playerAddress,
          score,
          round.gridSize,
          round.steps,
          correctSteps,
          timeElapsedMs,
          round.timeLimit,
          !!timeExpired,
          !!verification.passed
        );
        const receipt = await tx.wait();
        txHash = receipt.transactionHash;
      }
    } catch (err) {
      console.warn('Error recording infinite round on chain:', err.message);
      // continue and return success to the client (telemetry saved locally)
    }

    activeRounds.delete(roundId);
    
    const isPerfect = correctSteps === round.steps && !timeExpired;
    
    res.json({
      success: true,
      score,
      correctSteps,
      totalSteps: round.steps,
      timeElapsedMs,
      verified: verification.passed,
      verificationReasons: verification.reasons,
      txHash,
      rewardEligible: verification.passed && isPerfect,
      isPerfect,
      timeExpired: !!timeExpired,
      canContinue: isPerfect
    });
    
  } catch (error) {
    console.error('Error submitting infinite round:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Submit daily round
app.post('/api/round/submit/daily', async (req, res) => {
  try {
    const { roundId, playerAddress, clicks, telemetry, timeExpired } = req.body;
    
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
      }
    }
    
    const timeElapsedMs = Date.now() - round.startTime;
    const score = calculateScore(correctSteps, round.steps, timeElapsedMs, round.timeLimit);
    const verification = verifyRound(round, telemetry);
    const isPerfect = correctSteps === round.steps && !timeExpired;
    
    telemetryData.push({
      roundId,
      playerAddress,
      timestamp: new Date().toISOString(),
      telemetry,
      verification
    });
    
    // If perfect and verified, attempt to record daily challenge on chain
    let txHash = null;
    if (isPerfect && verification.passed) {
      try {
        if (contract && contract.recordDailyChallenge) {
          const wallet = new ethers.Wallet(
            '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
            provider
          );
          const contractWithSigner = contract.connect(wallet);
          const tx = await contractWithSigner.recordDailyChallenge(
            playerAddress,
            round.dateNum,
            score,
            correctSteps,
            round.steps,
            timeElapsedMs,
            round.timeLimit,
            false,
            true
          );
          const receipt = await tx.wait();
          txHash = receipt.transactionHash;
        }
      } catch (err) {
        // If contract reports "Already completed" return ALREADY_COMPLETED
        if (err.message && err.message.includes('Already completed')) {
          activeRounds.delete(roundId);
          return res.status(400).json({
            success: false,
            error: 'ALREADY_COMPLETED',
            message: 'You have already completed today\'s daily challenge!',
            score,
            correctSteps,
            totalSteps: round.steps
          });
        }
        console.warn('Error recording daily challenge on chain:', err.message);
      }
    }

    activeRounds.delete(roundId);

    if (isPerfect && verification.passed) {
      return res.json({
        success: true,
        score,
        correctSteps,
        totalSteps: round.steps,
        timeElapsedMs,
        verified: verification.passed,
        verificationReasons: verification.reasons,
        txHash,
        rewardEligible: true,
        isPerfect: true,
        dailyChallengeCompleted: true
      });
    } else {
      let failureMessage = 'Daily challenge requires perfect completion.';
      if (timeExpired) failureMessage = 'Time expired! You must complete within the time limit.';
      return res.json({
        success: true,
        score,
        correctSteps,
        totalSteps: round.steps,
        timeElapsedMs,
        timeExpired: !!timeExpired,
        verified: verification.passed,
        verificationReasons: verification.reasons,
        txHash,
        rewardEligible: false,
        isPerfect: false,
        dailyChallengeCompleted: false,
        message: failureMessage
      });
    }
    
  } catch (error) {
    console.error('Error submitting daily challenge:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Player stats
app.get('/api/player/:address/stats', async (req, res) => {
  try {
    if (!contract || !contract.playerStats) {
      return res.status(500).json({ success: false, error: 'Contract method playerStats not available' });
    }

    const stats = await contract.playerStats(req.params.address);
    const pendingRewards = (contract && contract.pendingRewards) ? await contract.pendingRewards(req.params.address) : ethers.BigNumber.from(0);
    
    res.json({
      success: true,
      stats: {
        totalRounds: stats.totalRounds ? stats.totalRounds.toString() : '0',
        totalScore: stats.totalScore ? stats.totalScore.toString() : '0',
        totalRewards: stats.totalRewards ? ethers.utils.formatEther(stats.totalRewards) : '0.0',
        bestScore: stats.bestScore ? stats.bestScore.toString() : '0',
        currentStreak: stats.currentStreak ? stats.currentStreak.toString() : '0',
        currentLevel: stats.currentLevel ? stats.currentLevel.toString() : '1',
        timeoutsCount: stats.timeoutsCount ? stats.timeoutsCount.toString() : '0',
        perfectRoundsCount: stats.perfectRoundsCount ? stats.perfectRoundsCount.toString() : '0',
        pendingRewards: pendingRewards ? ethers.utils.formatEther(pendingRewards) : '0.0'
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

// Leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    if (!contract || !contract.getLeaderboard) {
      return res.json({ success: true, leaderboard: [] });
    }

    const leaderboard = await contract.getLeaderboard();
    const formattedLeaderboard = (leaderboard || []).map((entry, index) => ({
      rank: index + 1,
      address: entry.player || entry.playerAddress || entry[0],
      score: entry.score ? entry.score.toString() : (entry[1] ? entry[1].toString() : '0'),
      level: entry.level ? entry.level : (entry[2] ? entry[2] : 0)
    })).filter(e => e.address && e.address !== ethers.constants.AddressZero);

    res.json({ success: true, leaderboard: formattedLeaderboard });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch leaderboard' });
  }
});

// Health / root
app.get('/', (req, res) => res.send('Memorix Backend is running.'));

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Memorix Backend Server running on port ${PORT}`);
  console.log(`Contract Address: ${contractAddress}`);
  console.log(`Network: localhost`);
});

