// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MemorixRewards {
    address public owner;
    mapping(address => uint256) public rewards;

    event RewardGranted(address indexed player, uint256 amount);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not authorized");
        _;
    }

    function grantReward(address player, uint256 amount) external onlyOwner {
        rewards[player] += amount;
        emit RewardGranted(player, amount);
    }

    function withdraw() external {
        uint256 amount = rewards[msg.sender];
        require(amount > 0, "Nothing to withdraw");
        rewards[msg.sender] = 0;
        payable(msg.sender).transfer(amount);
    }

    receive() external payable {}
}
