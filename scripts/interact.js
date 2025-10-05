const hre = require("hardhat");
const fs = require("fs");

async function main() {
  // Load deployment info
  const deploymentInfo = JSON.parse(fs.readFileSync('deployment-info.json', 'utf8'));
  const contractAddress = deploymentInfo.contractAddress;
  
  console.log("Interacting with MemorixGame at:", contractAddress);
  
  const [owner, player1, player2] = await hre.ethers.getSigners();
  const MemorixGame = await hre.ethers.getContractFactory("MemorixGame");
  const game = MemorixGame.attach(contractAddress);
  
  console.log("\n=== Initial State ===");
  console.log("Owner:", owner.address);
  console.log("Player1:", player1.address);
  console.log("Player2:", player2.address);
  console.log("Contract Balance:", hre.ethers.utils.formatEther(await hre.ethers.provider.getBalance(game.address)), "ETH");
  
  // Get today's date in YYYYMMDD format
  const today = new Date();
  const dateNum = parseInt(
    today.getFullYear().toString() +
    (today.getMonth() + 1).toString().padStart(2, '0') +
    today.getDate().toString().padStart(2, '0')
  );
  
  // Test 1: Record Infinite Mode Round for Player1 (Level 1)
  console.log("\n=== Recording Infinite Round 1 for Player1 (Level 1) ===");
  const tx1 = await game.recordInfiniteRound(
    player1.address,    // player
    150,                // score
    3,                  // gridSize (3x3)
    5,                  // steps
    5,                  // correctSteps (perfect!)
    2500,               // timeElapsedMs
    true                // verified
  );
  await tx1.wait();
  console.log("✓ Infinite Round 1 recorded!");
  
  // Check player1 stats
  let stats1 = await game.playerStats(player1.address);
  console.log("Current Level:", stats1.currentLevel.toString());
  console.log("Total Score:", stats1.totalScore.toString());
  
  // Check pending rewards
  let pendingRewards = await game.pendingRewards(player1.address);
  console.log("Player1 Pending Rewards:", hre.ethers.utils.formatEther(pendingRewards), "ETH");
  
  // Test 2: Record another Infinite Round for Player1 (Level 2)
  console.log("\n=== Recording Infinite Round 2 for Player1 (Level 2) ===");
  const tx2 = await game.recordInfiniteRound(
    player1.address,
    200,
    3,                  // 3x3 grid
    6,                  // 6 steps
    6,                  // 6 correct (perfect again!)
    3000,
    true
  );
  await tx2.wait();
  console.log("✓ Infinite Round 2 recorded!");
  
  // Check updated stats
  stats1 = await game.playerStats(player1.address);
  console.log("Current Level:", stats1.currentLevel.toString());
  console.log("Current Streak:", stats1.currentStreak.toString());
  
  pendingRewards = await game.pendingRewards(player1.address);
  console.log("Player1 Pending Rewards:", hre.ethers.utils.formatEther(pendingRewards), "ETH");
  
  // Test 3: Record Infinite Round with partial completion
  console.log("\n=== Recording Infinite Round 3 for Player1 (Partial) ===");
  const tx3 = await game.recordInfiniteRound(
    player1.address,
    180,
    4,                  // 4x4 grid
    7,                  // 7 steps
    5,                  // only 5 correct (not perfect)
    3500,
    true
  );
  await tx3.wait();
  console.log("✓ Infinite Round 3 recorded (partial completion)");
  
  stats1 = await game.playerStats(player1.address);
  console.log("Current Level:", stats1.currentLevel.toString(), "(no level up - partial completion)");
  console.log("Current Streak:", stats1.currentStreak.toString(), "(streak broken)");
  
  // Test 4: Record Daily Challenge for Player2
  console.log("\n=== Recording Daily Challenge for Player2 ===");
  
  // First, set up today's daily challenge
  console.log("Setting up daily challenge...");
  const setupTx = await game.setDailyChallenge(
    dateNum,
    4,      // 4x4 grid
    8,      // 8 steps
    400,    // 400ms show duration
    250     // 250ms interval
  );
  await setupTx.wait();
  console.log("✓ Daily challenge configured");
  
  // Fund the daily challenge
  const fundTx = await game.fundDailyChallenge(dateNum, {
    value: hre.ethers.utils.parseEther("5")
  });
  await fundTx.wait();
  console.log("✓ Daily challenge funded with 5 ETH");
  
  // Record daily challenge completion for player2
  const tx4 = await game.recordDailyChallenge(
    player2.address,
    dateNum,
    250,                // score
    8,                  // correctSteps
    8,                  // totalSteps (perfect!)
    4500,               // timeElapsedMs
    true                // verified
  );
  await tx4.wait();
  console.log("✓ Daily Challenge recorded for Player2!");
  
  // Check player2 stats
  const stats2 = await game.playerStats(player2.address);
  console.log("Player2 Total Score:", stats2.totalScore.toString());
  console.log("Player2 Last Daily Challenge Date:", stats2.lastDailyChallengeDate.toString());
  
  const pendingRewards2 = await game.pendingRewards(player2.address);
  console.log("Player2 Pending Rewards:", hre.ethers.utils.formatEther(pendingRewards2), "ETH");
  
  // Get full player stats
  console.log("\n=== Player1 Full Stats ===");
  stats1 = await game.playerStats(player1.address);
  console.log("Total Rounds:", stats1.totalRounds.toString());
  console.log("Total Score:", stats1.totalScore.toString());
  console.log("Total Rewards:", hre.ethers.utils.formatEther(stats1.totalRewards), "ETH");
  console.log("Best Score:", stats1.bestScore.toString());
  console.log("Current Streak:", stats1.currentStreak.toString());
  console.log("Current Level:", stats1.currentLevel.toString());
  
  // Get round details
  console.log("\n=== Round Details ===");
  const round1 = await game.getRound(1);
  console.log("Round 1:");
  console.log("  Player:", round1.player);
  console.log("  Round Type:", round1.roundType === 0 ? "INFINITE" : "DAILY_CHALLENGE");
  console.log("  Level:", round1.level.toString());
  console.log("  Score:", round1.score.toString());
  console.log("  Grid Size:", round1.gridSize);
  console.log("  Steps:", round1.steps, "/ Correct:", round1.correctSteps);
  console.log("  Time:", round1.timeElapsedMs.toString(), "ms");
  console.log("  Reward:", hre.ethers.utils.formatEther(round1.reward), "ETH");
  console.log("  Verified:", round1.verified);
  
  // Player1 withdraws rewards
  console.log("\n=== Player1 Withdrawing Rewards ===");
  const player1Balance_before = await hre.ethers.provider.getBalance(player1.address);
  console.log("Player1 Balance Before:", hre.ethers.utils.formatEther(player1Balance_before), "ETH");
  
  const withdrawTx = await game.connect(player1).withdrawReward();
  const receipt = await withdrawTx.wait();
  
  const player1Balance_after = await hre.ethers.provider.getBalance(player1.address);
  console.log("Player1 Balance After:", hre.ethers.utils.formatEther(player1Balance_after), "ETH");
  console.log("Pending Rewards After Withdrawal:", hre.ethers.utils.formatEther(await game.pendingRewards(player1.address)), "ETH");
  
  // Get player round history
  const player1Rounds = await game.getPlayerRounds(player1.address);
  console.log("\n=== Player1 Round History ===");
  console.log("Round IDs:", player1Rounds.map(id => id.toString()).join(", "));
  
  // Get daily challenge info
  console.log("\n=== Daily Challenge Info ===");
  const completers = await game.getDailyChallengeCompleters(dateNum);
  console.log("Today's completers:", completers);
  console.log("Player2 completed today:", await game.hasCompletedDailyChallenge(dateNum, player2.address));
  console.log("Player1 completed today:", await game.hasCompletedDailyChallenge(dateNum, player1.address));
  
  // Test leaderboard (initially empty)
  console.log("\n=== Leaderboard ===");
  const leaderboard = await game.getLeaderboard();
  console.log("Top 10:");
  leaderboard.forEach((entry, i) => {
    if (entry.player !== hre.ethers.constants.AddressZero) {
      console.log(`  ${i + 1}. ${entry.player} - Score: ${entry.score.toString()}, Level: ${entry.level}`);
    }
  });
  
  console.log("\n=== Final Contract State ===");
  console.log("Contract Balance:", hre.ethers.utils.formatEther(await hre.ethers.provider.getBalance(game.address)), "ETH");
  console.log("Next Round ID:", (await game.nextRoundId()).toString());
  console.log("Base Reward Per Step:", hre.ethers.utils.formatEther(await game.baseRewardPerStep()), "ETH");
  console.log("Daily Challenge Reward:", hre.ethers.utils.formatEther(await game.dailyChallengeRewardPerCompletion()), "ETH");
  console.log("Leaderboard Pool:", hre.ethers.utils.formatEther(await game.leaderboardRewardPool()), "ETH");
  
  console.log("\n✓ All tests completed successfully!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
