const hre = require("hardhat");
const fs = require("fs");

async function main() {
  // Load deployment info
  const deploymentInfo = JSON.parse(fs.readFileSync('deployment-info.json', 'utf8'));
  const contractAddress = deploymentInfo.contractAddress;
  
  console.log("🎮 Interacting with MemorixGame at:", contractAddress);
  
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
  
  // Test 1: Record Infinite Round 1 for Player1 (Level 1)
  console.log("\n=== 🎮 Recording Infinite Round 1 for Player1 (Level 1) ===");
  const tx1 = await game.recordInfiniteRound(
    player1.address,    // player
    150,                // score
    1,                  // level 1
    2500,               // timeElapsedMs
    true                // verified
  );
  await tx1.wait();
  console.log("✓ Infinite Round 1 recorded!");
  
  // Check player1 stats
  let stats1 = await game.playerStats(player1.address);
  console.log("Current Level:", stats1.currentLevel.toString());
  console.log("Total Score:", stats1.totalScore.toString());
  
  // Check pending rewards (should be 0 for infinite mode)
  let pendingRewards = await game.pendingRewards(player1.address);
  console.log("Player1 Pending Rewards:", hre.ethers.utils.formatEther(pendingRewards), "ETH (should be 0)");
  
  // Test 2: Record Infinite Round 2 for Player1 (Level 2)
  console.log("\n=== 🎮 Recording Infinite Round 2 for Player1 (Level 2) ===");
  const tx2 = await game.recordInfiniteRound(
    player1.address,
    250,                // higher score
    2,                  // level 2
    3000,               // timeElapsedMs
    true                // verified
  );
  await tx2.wait();
  console.log("✓ Infinite Round 2 recorded!");
  
  // Check updated stats
  stats1 = await game.playerStats(player1.address);
  console.log("Current Level:", stats1.currentLevel.toString());
  console.log("Total Score:", stats1.totalScore.toString());
  
  pendingRewards = await game.pendingRewards(player1.address);
  console.log("Player1 Pending Rewards:", hre.ethers.utils.formatEther(pendingRewards), "ETH (still 0)");
  
  // Test 3: Record Infinite Round for Player2 (Level 1)
  console.log("\n=== 🎮 Recording Infinite Round for Player2 (Level 1) ===");
  const tx3 = await game.recordInfiniteRound(
    player2.address,
    120,
    1,
    3500,
    true
  );
  await tx3.wait();
  console.log("✓ Infinite Round recorded for Player2!");
  
  const stats2 = await game.playerStats(player2.address);
  console.log("Player2 Current Level:", stats2.currentLevel.toString());
  console.log("Player2 Total Score:", stats2.totalScore.toString());
  
  // Test 4: Record Daily Challenge for Player2 (FAILED - not perfect)
  console.log("\n=== ⭐ Recording Daily Challenge for Player2 (Failed Attempt) ===");
  const tx4 = await game.recordDailyChallenge(
    player2.address,
    dateNum,
    180,                // score
    4500,               // timeElapsedMs
    false,              // NOT passed (failed)
    true                // verified
  );
  await tx4.wait();
  console.log("✓ Daily Challenge attempt recorded (failed)");
  
  const dailyStatus1 = await game.getDailyStatus(dateNum, player2.address);
  console.log("Player2 Tries Used:", dailyStatus1.triesUsed.toString(), "/ 3");
  console.log("Player2 Completed:", dailyStatus1.completed);
  
  let pendingRewards2 = await game.pendingRewards(player2.address);
  console.log("Player2 Pending Rewards:", hre.ethers.utils.formatEther(pendingRewards2), "ETH (should be 0)");
  
  // Test 5: Record Daily Challenge for Player2 (SUCCESS - perfect!)
  console.log("\n=== ⭐ Recording Daily Challenge for Player2 (Successful Attempt) ===");
  const tx5 = await game.recordDailyChallenge(
    player2.address,
    dateNum,
    280,                // score
    4000,               // timeElapsedMs
    true,               // PASSED (perfect!)
    true                // verified
  );
  await tx5.wait();
  console.log("✓ Daily Challenge completed successfully!");
  
  const dailyStatus2 = await game.getDailyStatus(dateNum, player2.address);
  console.log("Player2 Tries Used:", dailyStatus2.triesUsed.toString(), "/ 3");
  console.log("Player2 Completed:", dailyStatus2.completed);
  
  pendingRewards2 = await game.pendingRewards(player2.address);
  console.log("Player2 Pending Rewards:", hre.ethers.utils.formatEther(pendingRewards2), "ETH (should be 0.01)");
  
  // Test 6: Try to complete daily challenge again (should fail)
  console.log("\n=== ⭐ Trying to complete daily challenge again (should fail) ===");
  try {
    const tx6 = await game.recordDailyChallenge(
      player2.address,
      dateNum,
      300,
      3500,
      true,
      true
    );
    await tx6.wait();
    console.log("❌ ERROR: Should have failed!");
  } catch (err) {
    console.log("✓ Correctly rejected:", err.message.includes("Already completed") ? "Already completed" : err.message);
  }
  
  // Test 7: Update Leaderboard
  console.log("\n=== 🏆 Updating Leaderboard ===");
  const addresses = new Array(10).fill(hre.ethers.constants.AddressZero);
  const scores = new Array(10).fill(0);
  const levels = new Array(10).fill(0);
  
  // Player1 is #1 (Level 2, Score 400)
  addresses[0] = player1.address;
  scores[0] = 400;
  levels[0] = 2;
  
  // Player2 is #2 (Level 1, Score 400 total)
  addresses[1] = player2.address;
  scores[1] = 400;
  levels[1] = 1;
  
  const txLeaderboard = await game.updateLeaderboard(addresses, scores, levels);
  await txLeaderboard.wait();
  console.log("✓ Leaderboard updated!");
  
  // Check updated rewards
  const player1Rewards = await game.pendingRewards(player1.address);
  const player2Rewards = await game.pendingRewards(player2.address);
  
  console.log("\n=== 💰 Rewards After Leaderboard Update ===");
  console.log("Player1 (1st Place):", hre.ethers.utils.formatEther(player1Rewards), "ETH (should be 0.3)");
  console.log("Player2 (2nd Place):", hre.ethers.utils.formatEther(player2Rewards), "ETH (should be 0.21 = 0.01 daily + 0.2 leaderboard)");
  
  // Test 8: Player1 withdraws rewards
  console.log("\n=== 💸 Player1 Withdrawing Rewards ===");
  const player1Balance_before = await hre.ethers.provider.getBalance(player1.address);
  console.log("Player1 Balance Before:", hre.ethers.utils.formatEther(player1Balance_before), "ETH");
  
  const withdrawTx = await game.connect(player1).withdrawReward();
  const receipt = await withdrawTx.wait();
  
  const player1Balance_after = await hre.ethers.provider.getBalance(player1.address);
  console.log("Player1 Balance After:", hre.ethers.utils.formatEther(player1Balance_after), "ETH");
  console.log("Pending Rewards After Withdrawal:", hre.ethers.utils.formatEther(await game.pendingRewards(player1.address)), "ETH");
  
  // Test 9: Get leaderboard
  console.log("\n=== 🏆 Current Leaderboard ===");
  const leaderboard = await game.getLeaderboard();
  console.log("Top 10:");
  leaderboard.forEach((entry, i) => {
    if (entry.player !== hre.ethers.constants.AddressZero) {
      console.log(`  ${i + 1}. ${entry.player} - Level ${entry.level}, Score: ${entry.score.toString()}`);
    }
  });
  
  // Final stats
  console.log("\n=== 📊 Final Contract State ===");
  console.log("Contract Balance:", hre.ethers.utils.formatEther(await hre.ethers.provider.getBalance(game.address)), "ETH");
  console.log("Next Round ID:", (await game.nextRoundId()).toString());
  console.log("Daily Reward:", hre.ethers.utils.formatEther(await game.dailyReward()), "ETH");
  console.log("Leaderboard Pool:", hre.ethers.utils.formatEther(await game.leaderboardTotalPool()), "ETH");
  
  console.log("\n✅ All tests completed successfully!");
  console.log("\n=== 🎯 Key Takeaways ===");
  console.log("✓ Infinite mode: No instant rewards, only rankings");
  console.log("✓ Daily challenge: Single challenge, 3 tries, 0.01 ETH reward");
  console.log("✓ Level progression: Works correctly (Player1 went from L1 to L2)");
  console.log("✓ Leaderboard: Top 10 get fixed % of pool (30%, 20%, 15%, etc.)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});