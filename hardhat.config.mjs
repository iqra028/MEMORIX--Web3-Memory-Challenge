import { defineConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import dotenv from "dotenv";
dotenv.config();

export default defineConfig({
  solidity: {
    compilers: [
      { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 } } },
      { version: "0.8.19", settings: { optimizer: { enabled: true, runs: 200 } } }
    ],
  },
});
