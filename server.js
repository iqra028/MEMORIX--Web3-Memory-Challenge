const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// Load configuration
const config = JSON.parse(fs.readFileSync('game-config.json', 'utf8'));
const deploymentInfo = JSON.parse(fs.readFileSync('deployment-info.json', 'utf8'));

// Setup ethers provider and contract
const provider = new ethers.providers.JsonRpcProvider('http://127.0.0.1:8545');
const contractABI = require('./artifacts/contracts/MemorixGame.sol/MemorixGame.json').abi;
const contract = new ethers.Contract(deploymentInfo.contractAddress, contractABI, provider);

// In-memory storage
const activeRounds = new Map();
const telemetryData = [];

// Helper: Generate sequence
function generateSequence(gridSize, steps) {
  const maxIndex = gridSize * gridSize - 1;
  const sequence = [];
  for (let i = 0; i < steps; i++) {
    sequence.push(Math.floor(Math.random() * (maxIndex + 1)));
  }
  return sequence;
}

// Helper: Get difficulty config
function getDifficultyForLevel(level) {
  const baseSize = 3;
  const baseSteps = 3;
  
  // Increase difficulty every 3 levels
  const gridSize = Math.min(5, baseSize + Math.floor(level / 5));
  const steps = baseSteps + Math.floor(level / 2);
  
  return {
    gridSize,
    steps,
    showDuration: Math.max(300, 600 - (level * 10)),
    intervalBetween: Math.max(200, 400 - (level * 5))
  };
}

// Helper: Anti-cheat verification
function verifyRound(roundData, telemetry) {
  const checks = {
    passed: true,
    reasons: []
  };
  
  if (!telemetry.clicks || telemetry.clicks.length === 0) {
    return checks;
  }
  
  const reactionTimes = telemetry.clicks.map((click, i) => {
    if (i === 0) return click.clientTs - telemetry.sequenceStartTs;
    return click.clientTs - telemetry.clicks[i-1].clientTs;
  });
  
  const avgReaction = reactionTimes.reduce((a, b) => a + b, 0) / reactionTimes.length;
  
  if (avgReaction < config.antiCheat.min_reaction_time_ms) {
    checks.passed = false;
    checks.reasons.push('Suspiciously fast reactions');
  }
  
  return checks;
}

// Helper: Calculate score
function calculateScore(correctSteps, totalSteps, timeElapsedMs) {
  const basePoints = totalSteps * config.scoring.base_points_per_step;
  const percentCorrect = correctSteps / totalSteps;
  const timeBonus = Math.max(0, Math.floor((config.timing.input_timeout_ms - timeElapsedMs) / config.scoring.time_bonus_divisor));
  const accuracyBonus = Math.round(percentCorrect * basePoints * config.scoring.accuracy_weight);
  
  let finalScore = basePoints + timeBonus + accuracyBonus;
  
  if (correctSteps === totalSteps) {
    finalScore = Math.floor(finalScore * config.scoring.perfect_round_multiplier);
  }
  
  return finalScore;
}

// Get today's date in YYYYMMDD format
function getTodayDateNum() {
  const today = new Date();
  return parseInt(
    today.getFullYear().toString() +
    (today.getMonth() + 1).toString().padStart(2, '0') +
    today.getDate().toString().padStart(2, '0')
  );
}

// API Endpoints

// Check daily challenge status
app.get('/api/daily-challenge/status/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const dateNum = getTodayDateNum();
    
    // Check if player has completed today's challenge
    const hasCompleted = await contract.hasCompletedDailyChallenge(dateNum, address);
    
    res.json({
      success: true,
      dateNum,
      hasCompleted,
      canPlay: !hasCompleted
    });
  } catch (error) {
    console.error('Error checking daily challenge status:', error);
    res.status(500).json({ success: false, error: 'Failed to check status' });
  }
});

// Start infinite mode round
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
      timeLimit: config.timing.input_timeout_ms
    });
  } catch (error) {
    console.error('Error starting infinite round:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start daily challenge round
app.post('/api/round/start/daily', async (req, res) => {
  try {
    const { playerAddress } = req.body;
    
    if (!playerAddress) {
      return res.status(400).json({ success: false, error: 'Player address required' });
    }
    
    const dateNum = getTodayDateNum();
    
    // Check if player already completed today's challenge
    const hasCompleted = await contract.hasCompletedDailyChallenge(dateNum, playerAddress);
    if (hasCompleted) {
      return res.status(400).json({ 
        success: false, 
        error: 'ALREADY_COMPLETED',
        message: 'You have already completed today\'s daily challenge. Come back tomorrow!'
      });
    }
    
    // Fixed daily challenge parameters
    const difficultyConfig = {
      gridSize: 4,
      steps: 8,
      showDuration: 400,
      intervalBetween: 250
    };
    
    const roundId = `daily_${dateNum}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const sequence = generateSequence(difficultyConfig.gridSize, difficultyConfig.steps);
    
    const round = {
      roundId,
      playerAddress,
      sequence,
      gridSize: difficultyConfig.gridSize,
      steps: difficultyConfig.steps,
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
      timeLimit: config.timing.input_timeout_ms
    });
  } catch (error) {
    console.error('Error starting daily challenge:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Submit infinite mode round
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
    const clickedSequence = clicks.map(c => c.index);
    
    for (let i = 0; i < Math.min(clickedSequence.length, round.sequence.length); i++) {
      if (clickedSequence[i] === round.sequence[i]) {
        correctSteps++;
      }
    }
    
    const timeElapsedMs = Date.now() - round.startTime;
    const score = calculateScore(correctSteps, round.steps, timeElapsedMs);
    const verification = verifyRound(round, telemetry);
    
    telemetryData.push({
      roundId,
      playerAddress,
      timestamp: new Date().toISOString(),
      telemetry,
      verification
    });
    
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
      verification.passed
    );
    
    const receipt = await tx.wait();
    activeRounds.delete(roundId);
    
    const isPerfect = correctSteps === round.steps;
    
    res.json({
      success: true,
      score,
      correctSteps,
      totalSteps: round.steps,
      timeElapsedMs,
      verified: verification.passed,
      verificationReasons: verification.reasons,
      txHash: receipt.transactionHash,
      rewardEligible: verification.passed,
      isPerfect,
      canContinue: isPerfect // Only can continue if they won (perfect score)
    });
    
  } catch (error) {
    console.error('Error submitting infinite round:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Submit daily challenge round
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
    const clickedSequence = clicks.map(c => c.index);
    
    for (let i = 0; i < Math.min(clickedSequence.length, round.sequence.length); i++) {
      if (clickedSequence[i] === round.sequence[i]) {
        correctSteps++;
      }
    }
    
    const timeElapsedMs = Date.now() - round.startTime;
    const score = calculateScore(correctSteps, round.steps, timeElapsedMs);
    const verification = verifyRound(round, telemetry);
    const isPerfect = correctSteps === round.steps;
    
    telemetryData.push({
      roundId,
      playerAddress,
      timestamp: new Date().toISOString(),
      telemetry,
      verification
    });
    
    // Only submit to blockchain if perfect
    if (isPerfect && verification.passed) {
      const wallet = new ethers.Wallet(
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        provider
      );
      
      const contractWithSigner = contract.connect(wallet);
      
      try {
        const tx = await contractWithSigner.recordDailyChallenge(
          playerAddress,
          round.dateNum,
          score,
          correctSteps,
          round.steps,
          timeElapsedMs,
          true
        );
        
        const receipt = await tx.wait();
        activeRounds.delete(roundId);
        
        res.json({
          success: true,
          score,
          correctSteps,
          totalSteps: round.steps,
          timeElapsedMs,
          verified: verification.passed,
          verificationReasons: verification.reasons,
          txHash: receipt.transactionHash,
          rewardEligible: true,
          isPerfect: true,
          dailyChallengeCompleted: true
        });
        
      } catch (error) {
        // Handle "Already completed today" error
        if (error.message && error.message.includes('Already completed today')) {
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
        throw error;
      }
    } else {
      // Failed daily challenge - no blockchain submission
      activeRounds.delete(roundId);
      res.json({
        success: true,
        score,
        correctSteps,
        totalSteps: round.steps,
        timeElapsedMs,
        verified: verification.passed,
        verificationReasons: verification.reasons,
        txHash: null,
        rewardEligible: false,
        isPerfect: false,
        dailyChallengeCompleted: false,
        message: 'Daily challenge requires perfect completion. Try again!'
      });
    }
    
  } catch (error) {
    console.error('Error submitting daily challenge:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get player stats
app.get('/api/player/:address/stats', async (req, res) => {
  try {
    const stats = await contract.playerStats(req.params.address);
    const pendingRewards = await contract.pendingRewards(req.params.address);
    
    res.json({
      success: true,
      stats: {
        totalRounds: stats.totalRounds.toString(),
        totalScore: stats.totalScore.toString(),
        totalRewards: ethers.utils.formatEther(stats.totalRewards),
        bestScore: stats.bestScore.toString(),
        currentStreak: stats.currentStreak.toString(),
        currentLevel: stats.currentLevel.toString(),
        pendingRewards: ethers.utils.formatEther(pendingRewards)
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

// Get player round history
app.get('/api/player/:address/rounds', async (req, res) => {
  try {
    const roundIds = await contract.getPlayerRounds(req.params.address);
    const rounds = [];
    
    for (const id of roundIds) {
      const round = await contract.getRound(id);
      rounds.push({
        id: id.toString(),
        score: round.score.toString(),
        gridSize: round.gridSize,
        steps: round.steps,
        correctSteps: round.correctSteps,
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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    status: 'healthy',
    contractAddress: deploymentInfo.contractAddress,
    network: 'localhost'
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Memorix Backend Server running on port ${PORT}`);
  console.log(`Contract Address: ${deploymentInfo.contractAddress}`);
  console.log(`Network: localhost (Hardhat)`);
});
