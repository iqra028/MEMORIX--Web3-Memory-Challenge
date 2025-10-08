// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MemorixGame {
    address public owner;

    enum RoundType { INFINITE, DAILY_CHALLENGE }

    struct Round {
        uint256 id;
        address player;
        RoundType roundType;
        uint8 level;
        uint256 score;
        uint256 timeElapsedMs;
        uint256 reward;
        uint256 timestamp;
        bool verified;
    }

    struct PlayerStats {
        uint256 totalRounds;
        uint256 totalScore;
        uint256 totalRewards;
        uint256 bestScore;
        uint256 currentLevel;
        uint256 dailyTriesUsed;
        uint256 lastDailyDate;
        bool dailyCompleted;
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
    
    // Daily challenge tracking
    mapping(uint256 => mapping(address => uint256)) public dailyTriesUsed;
    mapping(uint256 => mapping(address => bool)) public dailyCompleted;
    
    // Leaderboard - store ALL players who have played
    address[] public allPlayers;
    mapping(address => bool) public hasPlayed;
    mapping(address => uint256) public playerIndex;
    
    LeaderboardEntry[10] public topTenLeaderboard;
    uint256 public lastLeaderboardReset;

    // Configurable rewards
    uint256 public dailyReward = 0.01 ether;
    uint256 public leaderboardTotalPool = 1 ether;
    
    event RoundRecorded(
        uint256 indexed roundId, 
        address indexed player, 
        uint256 score,
        uint8 level,
        RoundType roundType
    );
    event RewardWithdrawn(address indexed player, uint256 amount);
    event DailyCompleted(address indexed player, uint256 date);
    event LeaderboardUpdated(uint256 timestamp);
    event LeaderboardReset(uint256 timestamp);

    constructor() {
        owner = msg.sender;
        lastLeaderboardReset = block.timestamp;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not authorized");
        _;
    }

    // Add player to tracking list if first time
    function addPlayerIfNew(address player) internal {
        if (!hasPlayed[player]) {
            hasPlayed[player] = true;
            playerIndex[player] = allPlayers.length;
            allPlayers.push(player);
        }
    }

    // Record infinite mode round
    function recordInfiniteRound(
        address player,
        uint256 score,
        uint8 level,
        uint256 timeElapsedMs,
        bool verified
    ) external onlyOwner {
        require(verified, "Not verified");
        
        addPlayerIfNew(player);
        
        rounds[nextRoundId] = Round({
            id: nextRoundId,
            player: player,
            roundType: RoundType.INFINITE,
            level: level,
            score: score,
            timeElapsedMs: timeElapsedMs,
            reward: 0,
            timestamp: block.timestamp,
            verified: verified
        });

        playerRounds[player].push(nextRoundId);
        
        PlayerStats storage stats = playerStats[player];
        stats.totalRounds++;
        stats.totalScore += score;
        stats.currentLevel = level;
        
        if (score > stats.bestScore) {
            stats.bestScore = score;
        }

        emit RoundRecorded(nextRoundId, player, score, level, RoundType.INFINITE);
        nextRoundId++;
    }

    // Record daily challenge
    function recordDailyChallenge(
        address player,
        uint256 date,
        uint256 score,
        uint256 timeElapsedMs,
        bool passed,
        bool verified
    ) external onlyOwner {
        require(verified, "Not verified");
        require(dailyTriesUsed[date][player] < 3, "Max tries exceeded");
        require(!dailyCompleted[date][player], "Already completed today");
        
        addPlayerIfNew(player);
        
        dailyTriesUsed[date][player]++;
        
        uint256 reward = 0;
        
        if (passed) {
            dailyCompleted[date][player] = true;
            reward = dailyReward;
            pendingRewards[player] += reward;
            
            PlayerStats storage stats = playerStats[player];
            stats.totalRewards += reward;
            stats.dailyCompleted = true;
            
            emit DailyCompleted(player, date);
        }
        
        rounds[nextRoundId] = Round({
            id: nextRoundId,
            player: player,
            roundType: RoundType.DAILY_CHALLENGE,
            level: 0,
            score: score,
            timeElapsedMs: timeElapsedMs,
            reward: reward,
            timestamp: block.timestamp,
            verified: verified
        });

        playerRounds[player].push(nextRoundId);
        
        PlayerStats storage stats = playerStats[player];
        stats.totalRounds++;
        stats.totalScore += score;
        stats.dailyTriesUsed = dailyTriesUsed[date][player];
        stats.lastDailyDate = date;

        emit RoundRecorded(nextRoundId, player, score, 0, RoundType.DAILY_CHALLENGE);
        nextRoundId++;
    }

    // Update leaderboard and distribute rewards to top 10
    function updateLeaderboard(
        address[10] memory topPlayers,
        uint256[10] memory scores,
        uint8[10] memory levels
    ) external onlyOwner {
        // Reward distribution (30%, 20%, 15%, 10%, 8%, 6%, 4%, 3%, 2%, 2%)
        uint256[10] memory rewardPercents = [uint256(30), 20, 15, 10, 8, 6, 4, 3, 2, 2];

        // Save top 10
        for (uint8 i = 0; i < 10; i++) {
            topTenLeaderboard[i] = LeaderboardEntry({
                player: topPlayers[i],
                score: scores[i],
                level: levels[i]
            });
            
            // Distribute rewards to top 10
            if (topPlayers[i] != address(0)) {
                uint256 reward = (leaderboardTotalPool * rewardPercents[i]) / 100;
                pendingRewards[topPlayers[i]] += reward;
                playerStats[topPlayers[i]].totalRewards += reward;
            }
        }

        lastLeaderboardReset = block.timestamp;
        emit LeaderboardUpdated(block.timestamp);
    }

    // Reset daily stats for ALL players
    function resetDailyStats(address[] memory players) external onlyOwner {
        for (uint256 i = 0; i < players.length; i++) {
            address player = players[i];
            if (player != address(0)) {
                PlayerStats storage stats = playerStats[player];
                stats.totalScore = 0;
                stats.currentLevel = 1;
                stats.bestScore = 0;
            }
        }
        emit LeaderboardReset(block.timestamp);
    }

    // Get all players (for full leaderboard)
    function getAllPlayers() external view returns (address[] memory) {
        return allPlayers;
    }

    // Get player count
    function getPlayerCount() external view returns (uint256) {
        return allPlayers.length;
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
    function getDailyStatus(uint256 date, address player) 
        external 
        view 
        returns (uint256 triesUsed, bool completed) 
    {
        return (dailyTriesUsed[date][player], dailyCompleted[date][player]);
    }

    function getLeaderboard() external view returns (LeaderboardEntry[10] memory) {
        return topTenLeaderboard;
    }

    function getPlayerRounds(address player) external view returns (uint256[] memory) {
        return playerRounds[player];
    }

    function getRound(uint256 roundId) external view returns (Round memory) {
        return rounds[roundId];
    }

    // Admin functions
    function updateDailyReward(uint256 newReward) external onlyOwner {
        dailyReward = newReward;
    }

    function updateLeaderboardPool(uint256 newPool) external onlyOwner {
        leaderboardTotalPool = newPool;
    }

    function fundContract() external payable onlyOwner {}

    function emergencyWithdraw() external onlyOwner {
        payable(owner).transfer(address(this).balance);
    }

    receive() external payable {}
}