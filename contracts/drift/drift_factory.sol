// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./drift_controller.sol";

contract DriftFactory {
    address public immutable cpi_program;
    mapping(address => address) public controllers;

    event ControllerCreated(address indexed user, address controller);

    constructor(address _cpi_program) {
        cpi_program = _cpi_program;
    }

    function create_controller() external returns (address) {
        require(controllers[msg.sender] == address(0), "controller exists");
        DriftController controller = new DriftController(cpi_program);
        controllers[msg.sender] = address(controller);
        emit ControllerCreated(msg.sender, address(controller));
        return address(controller);
    }

    function get_controller(address user) external view returns (address) {
        return controllers[user];
    }
}
