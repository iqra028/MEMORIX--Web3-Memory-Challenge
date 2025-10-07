const hre = require("hardhat");
const fs = require("fs");

async function main() {
  console.log("🚀 Deploying MemorixGame contract...\n");
  
  const MemorixGame = await hre.ethers.getContractFactory("MemorixGame");
  const game = await MemorixGame.deploy();

  await game.deployed();
  
  console.log("✅ MemorixGame deployed to:", game.address);
  
  // Fund the contract
  const [owner] = await hre.ethers.getSigners();
  console.log("\n💰 Funding contract with 100 ETH...");
  
  const fundTx = await owner.sendTransaction({
    to: game.address,
    value: hre.ethers.utils.parseEther("100")
  });
  await fundTx.wait();
  
  const balance = await hre.ethers.provider.getBalance(game.address);
  console.log("✅ Contract balance:", hre.ethers.utils.formatEther(balance), "ETH");
  
  // Display contract info
  console.log("\n=== 📋 Contract Deployment Info ===");
  console.log("Contract Address:", game.address);
  console.log("Owner Address:", owner.address);
  console.log("Network:", hre.network.name);
  console.log("ChainId:", (await hre.ethers.provider.getNetwork()).chainId);
  
  // Load and update game config
  const config = JSON.parse(fs.readFileSync('game-config.json', 'utf8'));
  config.blockchain.contractAddress = game.address;
  fs.writeFileSync('game-config.json', JSON.stringify(config, null, 2));
  console.log("\n✅ Updated game-config.json with contract address");
  
  // Save deployment info
  const deploymentInfo = {
    contractAddress: game.address,
    contractABI: require('../artifacts/contracts/MemorixGame.sol/MemorixGame.json').abi,
    ownerAddress: owner.address,
    network: hre.network.name,
    chainId: (await hre.ethers.provider.getNetwork()).chainId,
    deployedAt: new Date().toISOString(),
    config: {
      dailyReward: hre.ethers.utils.formatEther(await game.dailyReward()),
      leaderboardPool: hre.ethers.utils.formatEther(await game.leaderboardTotalPool())
    }
  };
  
  fs.writeFileSync(
    'deployment-info.json',
    JSON.stringify(deploymentInfo, null, 2)
  );
  
  console.log("\n=== 💎 Reward Configuration ===");
  console.log("Daily Challenge Reward:", deploymentInfo.config.dailyReward, "ETH");
  console.log("Leaderboard Total Pool:", deploymentInfo.config.leaderboardPool, "ETH");
  console.log("  - 1st Place: 30% (0.3 ETH)");
  console.log("  - 2nd Place: 20% (0.2 ETH)");
  console.log("  - 3rd Place: 15% (0.15 ETH)");
  console.log("  - 4th-10th: 8%, 6%, 4%, 3%, 2%, 2%");
  
  console.log("\n✅ Deployment info saved to deployment-info.json");
  console.log("\n=== 🎮 Next Steps ===");
  console.log("1. Terminal 1: Keep Hardhat node running (npx hardhat node)");
  console.log("2. Terminal 2: Start backend server (node server.js)");
  console.log("3. Terminal 3: Start frontend (cd public && python3 -m http.server 8000)");
  console.log("4. Browser: Open http://localhost:8000");
  console.log("\n🎉 Setup complete! Ready to play!");
  console.log("\n⚠️  IMPORTANT NOTES:");
  console.log("- Infinite Mode: No instant rewards, only leaderboard rankings");
  console.log("- Daily Challenge: Single challenge per day, 3 tries, 0.01 ETH reward");
  console.log("- Leaderboard: Top 10 players get rewards distributed daily at 23:59 UTC");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});