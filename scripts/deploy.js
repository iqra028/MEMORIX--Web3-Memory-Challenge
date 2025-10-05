const hre = require("hardhat");

async function main() {
  console.log("Deploying MemorixGame contract...");
  
  const MemorixGame = await hre.ethers.getContractFactory("MemorixGame");
  const game = await MemorixGame.deploy();

  await game.deployed();
  
  console.log("MemorixGame deployed to:", game.address);
  
  // Fund the contract with initial ETH
  const [owner] = await hre.ethers.getSigners();
  console.log("Funding contract with 50 ETH...");
  
  const fundTx = await owner.sendTransaction({
    to: game.address,
    value: hre.ethers.utils.parseEther("50")
  });
  await fundTx.wait();
  
  const balance = await hre.ethers.provider.getBalance(game.address);
  console.log("Contract balance:", hre.ethers.utils.formatEther(balance), "ETH");
  
  // Set up today's daily challenge
  console.log("\nSetting up daily challenge...");
  const today = new Date();
  const dateNum = parseInt(
    today.getFullYear().toString() +
    (today.getMonth() + 1).toString().padStart(2, '0') +
    today.getDate().toString().padStart(2, '0')
  );
  
  const dailyChallengeTx = await game.setDailyChallenge(
    dateNum,
    4,      // 4x4 grid
    8,      // 8 steps
    400,    // 400ms show duration
    250     // 250ms interval
  );
  await dailyChallengeTx.wait();
  
  // Fund daily challenge
  const fundDailyTx = await game.fundDailyChallenge(dateNum, {
    value: hre.ethers.utils.parseEther("5")
  });
  await fundDailyTx.wait();
  
  console.log("Daily challenge set for date:", dateNum);
  
  // Display contract info
  console.log("\n=== Contract Deployment Info ===");
  console.log("Contract Address:", game.address);
  console.log("Owner Address:", owner.address);
  console.log("Network:", hre.network.name);
  console.log("Base Reward Per Step:", hre.ethers.utils.formatEther(await game.baseRewardPerStep()), "ETH");
  console.log("Daily Challenge Reward:", hre.ethers.utils.formatEther(await game.dailyChallengeRewardPerCompletion()), "ETH");
  console.log("Leaderboard Pool:", hre.ethers.utils.formatEther(await game.leaderboardRewardPool()), "ETH");
  
  // Save deployment info
  const fs = require('fs');
  const deploymentInfo = {
    contractAddress: game.address,
    contractABI: require('../artifacts/contracts/MemorixGame.sol/MemorixGame.json').abi,
    ownerAddress: owner.address,
    network: hre.network.name,
    dailyChallengeDate: dateNum,
    deployedAt: new Date().toISOString()
  };
  
  fs.writeFileSync(
    'deployment-info.json',
    JSON.stringify(deploymentInfo, null, 2)
  );
  
  console.log("\nDeployment info saved to deployment-info.json");
  console.log("\n✅ Setup complete! You can now:");
  console.log("1. Start the backend: node server.js");
  console.log("2. Open the game: http://localhost:8000");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
