const hre = require("hardhat");
const fs = require("fs");

async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 DEPLOYING MEMORIX GAME CONTRACT");
  console.log("=".repeat(60) + "\n");
  
  // Get deployer account
  const [deployer] = await hre.ethers.getSigners();
  console.log("👤 Deployer account:", deployer.address);
  
  const balance = await deployer.getBalance();
  console.log("💰 Deployer balance:", hre.ethers.utils.formatEther(balance), "ETH\n");
  
  // Deploy contract
  console.log("📦 Deploying MemorixGame contract...");
  const MemorixGame = await hre.ethers.getContractFactory("MemorixGame");
  const game = await MemorixGame.deploy();
  
  await game.deployed();
  
  console.log("✅ Contract deployed to:", game.address);
  
  // Verify deployment
  console.log("\n🔍 Verifying deployment...");
  const code = await hre.ethers.provider.getCode(game.address);
  if (code === '0x') {
    console.error("❌ Contract deployment failed - no code at address!");
    process.exit(1);
  }
  console.log("✅ Contract code verified");
  
  // Test contract functions
  console.log("\n🧪 Testing contract functions...");
  
  try {
    const owner = await game.owner();
    console.log("✅ owner():", owner);
    
    const playerCount = await game.getPlayerCount();
    console.log("✅ getPlayerCount():", playerCount.toString());
    
    const allPlayers = await game.getAllPlayers();
    console.log("✅ getAllPlayers(): []", allPlayers.length, "players");
    
    const dailyReward = await game.dailyReward();
    console.log("✅ dailyReward():", hre.ethers.utils.formatEther(dailyReward), "ETH");
    
    const leaderboardPool = await game.leaderboardTotalPool();
    console.log("✅ leaderboardTotalPool():", hre.ethers.utils.formatEther(leaderboardPool), "ETH");
    
  } catch (err) {
    console.error("❌ Contract function test failed:", err.message);
    process.exit(1);
  }
  
  // Fund the contract
  console.log("\n💸 Funding contract with 100 ETH...");
  const fundTx = await deployer.sendTransaction({
    to: game.address,
    value: hre.ethers.utils.parseEther("100")
  });
  await fundTx.wait();
  
  const contractBalance = await hre.ethers.provider.getBalance(game.address);
  console.log("✅ Contract balance:", hre.ethers.utils.formatEther(contractBalance), "ETH");
  
  // Save deployment info
  console.log("\n💾 Saving deployment information...");
  
  const deploymentInfo = {
    contractAddress: game.address,
    ownerAddress: deployer.address,
    network: hre.network.name,
    chainId: (await hre.ethers.provider.getNetwork()).chainId,
    deployedAt: new Date().toISOString(),
    balance: hre.ethers.utils.formatEther(contractBalance),
    config: {
      dailyReward: hre.ethers.utils.formatEther(await game.dailyReward()),
      leaderboardPool: hre.ethers.utils.formatEther(await game.leaderboardTotalPool())
    }
  };
  
  fs.writeFileSync(
    'deployment-info.json',
    JSON.stringify(deploymentInfo, null, 2)
  );
  console.log("✅ Saved deployment-info.json");
  
  // Update game-config.json
  let config;
  try {
    config = JSON.parse(fs.readFileSync('game-config.json', 'utf8'));
    config.blockchain.contractAddress = game.address;
    fs.writeFileSync('game-config.json', JSON.stringify(config, null, 2));
    console.log("✅ Updated game-config.json");
  } catch (err) {
    console.warn("⚠️  Could not update game-config.json:", err.message);
  }
  
  // Display summary
  console.log("\n" + "=".repeat(60));
  console.log("🎉 DEPLOYMENT SUCCESSFUL!");
  console.log("=".repeat(60));
  console.log("\n📋 CONTRACT DETAILS:");
  console.log("   Address:", game.address);
  console.log("   Owner:", deployer.address);
  console.log("   Network:", hre.network.name);
  console.log("   Chain ID:", deploymentInfo.chainId);
  console.log("   Balance:", hre.ethers.utils.formatEther(contractBalance), "ETH");
  
  console.log("\n💎 REWARD CONFIGURATION:");
  console.log("   Daily Challenge:", deploymentInfo.config.dailyReward, "ETH");
  console.log("   Leaderboard Pool:", deploymentInfo.config.leaderboardPool, "ETH");
  console.log("   Top 10 Distribution:");
  console.log("     1st: 30% (0.3 ETH)");
  console.log("     2nd: 20% (0.2 ETH)");
  console.log("     3rd: 15% (0.15 ETH)");
  console.log("     4th-10th: 10%, 8%, 6%, 4%, 3%, 2%, 2%");
  
  console.log("\n🚀 NEXT STEPS:");
  console.log("   1. Keep Hardhat node running (Terminal 1)");
  console.log("   2. Start backend: node server.js (Terminal 2)");
  console.log("   3. Verify contract: node fix-contract.js");
  console.log("   4. Open game: http://localhost:8000");
  
  console.log("\n✅ Ready to play!\n");
}

main().catch((error) => {
  console.error("\n❌ DEPLOYMENT FAILED:");
  console.error(error);
  process.exitCode = 1;
});