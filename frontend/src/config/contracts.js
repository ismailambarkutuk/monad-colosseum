/**
 * Contract addresses and ABIs for frontend interaction
 * AgentRegistry is called from the user's wallet via wagmi
 */

// Deployed contract addresses (Monad Mainnet)
export const CONTRACTS = {
    AGENT_REGISTRY: '0x8162b8E7ea285A8D62B8D1600E41beED8Aa426Ce',
}

// AgentRegistry ABI — only the functions needed by frontend
export const AGENT_REGISTRY_ABI = [
    {
        name: 'registerAgent',
        type: 'function',
        stateMutability: 'payable',
        inputs: [
            { name: 'agentWallet', type: 'address' },
            { name: 'name', type: 'string' },
            { name: 'strategyDescription', type: 'string' },
            {
                name: 'params',
                type: 'tuple',
                components: [
                    { name: 'aggressiveness', type: 'uint8' },
                    { name: 'riskTolerance', type: 'uint8' },
                    { name: 'briberyPolicy', type: 'uint8' },       // 0=reject, 1=accept, 2=conditional
                    { name: 'profitTarget', type: 'uint256' },       // in wei
                    { name: 'withdrawThreshold', type: 'uint256' },  // in wei
                    { name: 'allianceTendency', type: 'uint8' },
                    { name: 'betrayalChance', type: 'uint8' },
                ],
            },
        ],
        outputs: [{ name: 'agentId', type: 'uint256' }],
    },
    {
        name: 'creationFee',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'uint256' }],
    },
    {
        name: 'depositBudget',
        type: 'function',
        stateMutability: 'payable',
        inputs: [{ name: 'agentId', type: 'uint256' }],
        outputs: [],
    },
    {
        name: 'getAgent',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'agentId', type: 'uint256' }],
        outputs: [
            {
                name: '',
                type: 'tuple',
                components: [
                    { name: 'owner', type: 'address' },
                    { name: 'agentWallet', type: 'address' },
                    { name: 'name', type: 'string' },
                    { name: 'strategyDescription', type: 'string' },
                    {
                        name: 'params',
                        type: 'tuple',
                        components: [
                            { name: 'aggressiveness', type: 'uint8' },
                            { name: 'riskTolerance', type: 'uint8' },
                            { name: 'briberyPolicy', type: 'uint8' },
                            { name: 'profitTarget', type: 'uint256' },
                            { name: 'withdrawThreshold', type: 'uint256' },
                            { name: 'allianceTendency', type: 'uint8' },
                            { name: 'betrayalChance', type: 'uint8' },
                        ],
                    },
                    { name: 'status', type: 'uint8' },
                    { name: 'budget', type: 'uint256' },
                    { name: 'totalEarnings', type: 'uint256' },
                    { name: 'totalLosses', type: 'uint256' },
                    { name: 'matchesPlayed', type: 'uint256' },
                    { name: 'matchesWon', type: 'uint256' },
                    { name: 'eloRating', type: 'int256' },
                    { name: 'createdAt', type: 'uint256' },
                    { name: 'isExternal', type: 'bool' },
                ],
            },
        ],
    },
    {
        name: 'totalAgents',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'uint256' }],
    },
]
