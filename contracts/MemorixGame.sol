// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MemorixGame {
    address public owner;

    enum RoundType { INFINITE, DAILY_CHALLENGE }

    struct Round {
        uint256 id;
        address player;
        RoundType roundType;
        uint8 level;              // infinite mode level
        uint8 gridSize;
        uint8 steps;
        uint256 score;
        uint256 timeElapsedMs;
        uint8 correctSteps;
        uint256 reward;
        uint256 timestamp;
        bool verified;
    }

    struct PlayerStats {
        uint256 totalRounds;
        uint256 totalScore;
        uint256 totalRewards;
        uint256 bestScore;
        uint256 currentStreak;
        uint8 currentLevel;       // current infinite level
        uint256 lastDailyChallengeDate; // timestamp of last daily challenge (date only)
    }

    struct DailyChallenge {
        uint256 date;             // YYYYMMDD format
        uint8 gridSize;
        uint8 steps;
        uint256 rewardPool;
        uint256 showDuration;
        uint256 intervalBetween;
        mapping(address => bool) hasCompleted;
        address[] completers;
    }

    struct LeaderboardEntry {
        address player;
        uint256 score;
        uint8 level;
    }

    uint256 public nextRoundId = 1;
    mapping(uint256 => Round) public rounds;
    mapping(address => uint256[]) public playerRounds;
    mapping(address => uint256) public pendingRewards;
    mapping(address => PlayerStats) public playerStats;
    
    // Daily challenges mapping: date (YYYYMMDD) => DailyChallenge
    mapping(uint256 => DailyChallenge) public dailyChallenges;
    uint256 public currentDailyChallengeDate;
    
    // Leaderboard (top 10 updated daily)
    LeaderboardEntry[10] public leaderboard;
    uint256 public lastLeaderboardUpdate;

    // Game configuration
    uint256 public baseRewardPerStep = 0.001 ether;
    uint256 public timeBonusMultiplier = 100;
    uint256 public dailyChallengeRewardPerCompletion = 0.01 ether;
    uint256 public leaderboardRewardPool = 1 ether; // Total for top 10
    
    event RoundRecorded(
        uint256 indexed roundId, 
        address indexed player, 
        uint256 score, 
        uint256 reward,
        RoundType roundType,
        uint8 level
    );
    event RewardWithdrawn(address indexed player, uint256 amount);
    event DailyChallengeCompleted(uint256 indexed date, address indexed player, uint256 reward);
    event LeaderboardUpdated(uint256 timestamp);
    event LevelUp(address indexed player, uint8 newLevel);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not authorized");
        _;
    }

    // Initialize or update daily challenge
    function setDailyChallenge(
        uint256 date,
        uint8 gridSize,
        uint8 steps,
        uint256 showDuration,
        uint256 intervalBetween
    ) external onlyOwner {
        DailyChallenge storage challenge = dailyChallenges[date];
        challenge.date = date;
        challenge.gridSize = gridSize;
        challenge.steps = steps;
        challenge.showDuration = showDuration;
        challenge.intervalBetween = intervalBetween;
        currentDailyChallengeDate = date;
    }

    // Fund daily challenge reward pool
    function fundDailyChallenge(uint256 date) external payable onlyOwner {
        dailyChallenges[date].rewardPool += msg.value;
    }

    // Record infinite level round
    function recordInfiniteRound(
        address player,
        uint256 score,
        uint8 gridSize,
        uint8 steps,
        uint8 correctSteps,
        uint256 timeElapsedMs,
        bool verified
    ) external onlyOwner {
        require(steps > 0 && steps <= 50, "Invalid steps");
        require(correctSteps <= steps, "Invalid correct steps");
        require(gridSize >= 2 && gridSize <= 10, "Invalid grid size");

        PlayerStats storage stats = playerStats[player];
        uint8 currentLevel = stats.currentLevel == 0 ? 1 : stats.currentLevel;

        uint256 reward = calculateReward(steps, correctSteps, timeElapsedMs);

        rounds[nextRoundId] = Round({
            id: nextRoundId,
            player: player,
            roundType: RoundType.INFINITE,
            level: currentLevel,
            gridSize: gridSize,
            steps: steps,
            score: score,
            timeElapsedMs: timeElapsedMs,
            correctSteps: correctSteps,
            reward: reward,
            timestamp: block.timestamp,
            verified: verified
        });

        playerRounds[player].push(nextRoundId);
        
        stats.totalRounds++;
        stats.totalScore += score;
        
        if (verified && correctSteps == steps) {
            // Perfect round - level up and give reward
            pendingRewards[player] += reward;
            stats.totalRewards += reward;
            stats.currentLevel = currentLevel + 1;
            stats.currentStreak++;
            
            if (score > stats.bestScore) {
                stats.bestScore = score;
            }
            
            emit LevelUp(player, stats.currentLevel);
        } else if (verified) {
            // Partial completion - give partial reward
            uint256 partialReward = (reward * correctSteps) / steps;
            pendingRewards[player] += partialReward;
            stats.totalRewards += partialReward;
            stats.currentStreak = 0;
        }

        emit RoundRecorded(nextRoundId, player, score, reward, RoundType.INFINITE, currentLevel);
        nextRoundId++;
    }

    // Record daily challenge round
    function recordDailyChallenge(
        address player,
        uint256 date,
        uint256 score,
        uint8 correctSteps,
        uint8 totalSteps,
        uint256 timeElapsedMs,
        bool verified
    ) external onlyOwner {
        DailyChallenge storage challenge = dailyChallenges[date];
        require(challenge.date == date, "Challenge not initialized");
        require(!challenge.hasCompleted[player], "Already completed today");
        require(verified, "Not verified");
        require(correctSteps == totalSteps, "Must complete perfectly");

        // Mark as completed
        challenge.hasCompleted[player] = true;
        challenge.completers.push(player);

        // Instant reward
        uint256 reward = dailyChallengeRewardPerCompletion;
        pendingRewards[player] += reward;

        PlayerStats storage stats = playerStats[player];
        stats.totalScore += score;
        stats.totalRewards += reward;
        stats.lastDailyChallengeDate = date;

        rounds[nextRoundId] = Round({
            id: nextRoundId,
            player: player,
            roundType: RoundType.DAILY_CHALLENGE,
            level: 0,
            gridSize: challenge.gridSize,
            steps: challenge.steps,
            score: score,
            timeElapsedMs: timeElapsedMs,
            correctSteps: correctSteps,
            reward: reward,
            timestamp: block.timestamp,
            verified: verified
        });

        playerRounds[player].push(nextRoundId);

        emit DailyChallengeCompleted(date, player, reward);
        emit RoundRecorded(nextRoundId, player, score, reward, RoundType.DAILY_CHALLENGE, 0);
        nextRoundId++;
    }

    // Update leaderboard (called daily by owner)
    function updateLeaderboard(address[] memory topPlayers, uint256[] memory scores, uint8[] memory levels) external onlyOwner {
        require(topPlayers.length == 10, "Must provide 10 players");
        require(scores.length == 10 && levels.length == 10, "Arrays length mismatch");

        // Distribute rewards to top 10
        uint256[10] memory rewards = [
            leaderboardRewardPool * 30 / 100,  // 30% to 1st
            leaderboardRewardPool * 20 / 100,  // 20% to 2nd
            leaderboardRewardPool * 15 / 100,  // 15% to 3rd
            leaderboardRewardPool * 10 / 100,  // 10% to 4th
            leaderboardRewardPool * 8 / 100,   // 8% to 5th
            leaderboardRewardPool * 6 / 100,   // 6% to 6th
            leaderboardRewardPool * 4 / 100,   // 4% to 7th
            leaderboardRewardPool * 3 / 100,   // 3% to 8th
            leaderboardRewardPool * 2 / 100,   // 2% to 9th
            leaderboardRewardPool * 2 / 100    // 2% to 10th
        ];

        for (uint8 i = 0; i < 10; i++) {
            leaderboard[i] = LeaderboardEntry({
                player: topPlayers[i],
                score: scores[i],
                level: levels[i]
            });
            
            if (topPlayers[i] != address(0)) {
                pendingRewards[topPlayers[i]] += rewards[i];
                playerStats[topPlayers[i]].totalRewards += rewards[i];
            }
        }

        lastLeaderboardUpdate = block.timestamp;
        emit LeaderboardUpdated(block.timestamp);
    }

    function calculateReward(
        uint8 steps,
        uint8 correctSteps,
        uint256 timeElapsedMs
    ) public view returns (uint256) {
        if (correctSteps == 0) return 0;
        
        uint256 reward = uint256(correctSteps) * baseRewardPerStep;
        
        // Time bonus
        if (timeElapsedMs < 10000) {
            reward += (reward * timeBonusMultiplier) / 1000;
        }
        
        // Perfect bonus
        if (correctSteps == steps) {
            reward += reward / 2;
        }
        
        return reward;
    }

    function withdrawReward() external {
        uint256 amount = pendingRewards[msg.sender];
        require(amount > 0, "No rewards");
        require(address(this).balance >= amount, "Insufficient contract balance");
        
        pendingRewards[msg.sender] = 0;
        payable(msg.sender).transfer(amount);
        
        emit RewardWithdrawn(msg.sender, amount);
    }

    // View functions
    function getPlayerRounds(address player) external view returns (uint256[] memory) {
        return playerRounds[player];
    }

    function getRound(uint256 roundId) external view returns (Round memory) {
        return rounds[roundId];
    }

    function getDailyChallengeCompleters(uint256 date) external view returns (address[] memory) {
        return dailyChallenges[date].completers;
    }

    function hasCompletedDailyChallenge(uint256 date, address player) external view returns (bool) {
        return dailyChallenges[date].hasCompleted[player];
    }

    function getLeaderboard() external view returns (LeaderboardEntry[10] memory) {
        return leaderboard;
    }

    // Admin functions
    function updateBaseReward(uint256 newReward) external onlyOwner {
        baseRewardPerStep = newReward;
    }

    function updateDailyChallengeReward(uint256 newReward) external onlyOwner {
        dailyChallengeRewardPerCompletion = newReward;
    }

    function updateLeaderboardPool(uint256 newPool) external onlyOwner {
        leaderboardRewardPool = newPool;
    }

    function fundContract() external payable onlyOwner {}

    function emergencyWithdraw() external onlyOwner {
        payable(owner).transfer(address(this).balance);
    }

    receive() external payable {}
}
