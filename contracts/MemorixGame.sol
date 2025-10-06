// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MemorixGame {
    address public owner;

    enum RoundType { INFINITE, DAILY_CHALLENGE }
    enum FailureReason { NONE, WRONG_SEQUENCE, TIME_EXPIRED }

    struct Round {
        uint256 id;
        address player;
        RoundType roundType;
        uint8 level;
        uint8 gridSize;
        uint8 steps;
        uint256 score;
        uint256 timeElapsedMs;
        uint256 timeLimitMs;
        uint8 correctSteps;
        uint256 reward;
        uint256 timestamp;
        bool verified;
        FailureReason failureReason;
    }

    struct PlayerStats {
        uint256 totalRounds;
        uint256 totalScore;
        uint256 totalRewards;
        uint256 bestScore;
        uint256 currentStreak;
        uint8 currentLevel;
        uint256 lastDailyChallengeDate;
        uint256 timeoutsCount;
        uint256 perfectRoundsCount;
    }

    struct DailyChallenge {
        uint256 date;
        uint8 gridSize;
        uint8 steps;
        uint256 rewardPool;
        uint256 showDuration;
        uint256 intervalBetween;
        uint256 timeLimitMs;
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
    
    mapping(uint256 => DailyChallenge) public dailyChallenges;
    uint256 public currentDailyChallengeDate;
    
    LeaderboardEntry[10] public leaderboard;
    uint256 public lastLeaderboardUpdate;

    uint256 public baseRewardPerStep = 0.001 ether;
    uint256 public timeBonusMultiplier = 100;
    uint256 public dailyChallengeRewardPerCompletion = 0.01 ether;
    uint256 public leaderboardRewardPool = 1 ether;
    
    event RoundRecorded(
        uint256 indexed roundId, 
        address indexed player, 
        uint256 score, 
        uint256 reward,
        RoundType roundType,
        uint8 level,
        FailureReason failureReason
    );
    event RewardWithdrawn(address indexed player, uint256 amount);
    event DailyChallengeCompleted(uint256 indexed date, address indexed player, uint256 reward);
    event LeaderboardUpdated(uint256 timestamp);
    event LevelUp(address indexed player, uint8 newLevel);
    event TimeExpired(uint256 indexed roundId, address indexed player, uint8 level);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not authorized");
        _;
    }

    function setDailyChallenge(
        uint256 date,
        uint8 gridSize,
        uint8 steps,
        uint256 showDuration,
        uint256 intervalBetween,
        uint256 timeLimitMs
    ) external onlyOwner {
        DailyChallenge storage challenge = dailyChallenges[date];
        challenge.date = date;
        challenge.gridSize = gridSize;
        challenge.steps = steps;
        challenge.showDuration = showDuration;
        challenge.intervalBetween = intervalBetween;
        challenge.timeLimitMs = timeLimitMs;
        currentDailyChallengeDate = date;
    }

    function fundDailyChallenge(uint256 date) external payable onlyOwner {
        dailyChallenges[date].rewardPool += msg.value;
    }

    function recordInfiniteRound(
        address player,
        uint256 score,
        uint8 gridSize,
        uint8 steps,
        uint8 correctSteps,
        uint256 timeElapsedMs,
        uint256 timeLimitMs,
        bool timeExpired,
        bool verified
    ) external onlyOwner {
        require(steps > 0 && steps <= 50, "Invalid steps");
        require(correctSteps <= steps, "Invalid correct steps");
        require(gridSize >= 2 && gridSize <= 10, "Invalid grid size");

        PlayerStats storage stats = playerStats[player];
        uint8 currentLevel = stats.currentLevel == 0 ? 1 : stats.currentLevel;

        FailureReason failureReason = FailureReason.NONE;
        if (timeExpired) {
            failureReason = FailureReason.TIME_EXPIRED;
            stats.timeoutsCount++;
        } else if (correctSteps < steps) {
            failureReason = FailureReason.WRONG_SEQUENCE;
        }

        uint256 reward = 0;
        if (!timeExpired && correctSteps == steps) {
            reward = calculateReward(steps, correctSteps, timeElapsedMs, timeLimitMs);
        }

        rounds[nextRoundId] = Round({
            id: nextRoundId,
            player: player,
            roundType: RoundType.INFINITE,
            level: currentLevel,
            gridSize: gridSize,
            steps: steps,
            score: score,
            timeElapsedMs: timeElapsedMs,
            timeLimitMs: timeLimitMs,
            correctSteps: correctSteps,
            reward: reward,
            timestamp: block.timestamp,
            verified: verified,
            failureReason: failureReason
        });

        playerRounds[player].push(nextRoundId);
        stats.totalRounds++;
        stats.totalScore += score;
        
        if (verified && correctSteps == steps && !timeExpired) {
            pendingRewards[player] += reward;
            stats.totalRewards += reward;
            stats.currentLevel = currentLevel + 1;
            stats.currentStreak++;
            stats.perfectRoundsCount++;
            
            if (score > stats.bestScore) {
                stats.bestScore = score;
            }
            
            emit LevelUp(player, stats.currentLevel);
        } else {
            stats.currentStreak = 0;
            if (timeExpired) {
                emit TimeExpired(nextRoundId, player, currentLevel);
            }
        }

        emit RoundRecorded(nextRoundId, player, score, reward, RoundType.INFINITE, currentLevel, failureReason);
        nextRoundId++;
    }

    function recordDailyChallenge(
        address player,
        uint256 date,
        uint256 score,
        uint8 correctSteps,
        uint8 totalSteps,
        uint256 timeElapsedMs,
        uint256 timeLimitMs,
        bool timeExpired,
        bool verified
    ) external onlyOwner {
        DailyChallenge storage challenge = dailyChallenges[date];
        require(challenge.date == date, "Challenge not initialized");
        require(!challenge.hasCompleted[player], "Already completed today");
        require(verified, "Not verified");
        require(correctSteps == totalSteps && !timeExpired, "Must complete perfectly within time");

        challenge.hasCompleted[player] = true;
        challenge.completers.push(player);

        uint256 reward = dailyChallengeRewardPerCompletion;
        pendingRewards[player] += reward;

        PlayerStats storage stats = playerStats[player];
        stats.totalScore += score;
        stats.totalRewards += reward;
        stats.lastDailyChallengeDate = date;
        stats.perfectRoundsCount++;

        rounds[nextRoundId] = Round({
            id: nextRoundId,
            player: player,
            roundType: RoundType.DAILY_CHALLENGE,
            level: 0,
            gridSize: challenge.gridSize,
            steps: challenge.steps,
            score: score,
            timeElapsedMs: timeElapsedMs,
            timeLimitMs: timeLimitMs,
            correctSteps: correctSteps,
            reward: reward,
            timestamp: block.timestamp,
            verified: verified,
            failureReason: FailureReason.NONE
        });

        playerRounds[player].push(nextRoundId);

        emit DailyChallengeCompleted(date, player, reward);
        emit RoundRecorded(nextRoundId, player, score, reward, RoundType.DAILY_CHALLENGE, 0, FailureReason.NONE);
        nextRoundId++;
    }

    function updateLeaderboard(address[] memory topPlayers, uint256[] memory scores, uint8[] memory levels) external onlyOwner {
        require(topPlayers.length == 10, "Must provide 10 players");
        require(scores.length == 10 && levels.length == 10, "Arrays length mismatch");

        uint256[10] memory rewards = [
            leaderboardRewardPool * 30 / 100,
            leaderboardRewardPool * 20 / 100,
            leaderboardRewardPool * 15 / 100,
            leaderboardRewardPool * 10 / 100,
            leaderboardRewardPool * 8 / 100,
            leaderboardRewardPool * 6 / 100,
            leaderboardRewardPool * 4 / 100,
            leaderboardRewardPool * 3 / 100,
            leaderboardRewardPool * 2 / 100,
            leaderboardRewardPool * 2 / 100
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
        uint256 timeElapsedMs,
        uint256 timeLimitMs
    ) public view returns (uint256) {
        if (correctSteps == 0) return 0;
        
        uint256 reward = uint256(correctSteps) * baseRewardPerStep;
        
        uint256 timeLeftMs = timeLimitMs > timeElapsedMs ? timeLimitMs - timeElapsedMs : 0;
        uint256 timeBonus = (reward * timeLeftMs * timeBonusMultiplier) / (timeLimitMs * 1000);
        reward += timeBonus;
        
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
