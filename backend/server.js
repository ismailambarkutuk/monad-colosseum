/**
 * Monad Colosseum - Unified Backend Server
 * 
 * Combines Claude API for agent creation + GameEngine for live battles + WebSocket broadcasting
 */

require('dotenv').config();
// Also try loading from root .env if backend/.env has placeholder values
const path = require('path');
const fs = require('fs');

// ─── Process-level Error Handlers (prevent crashes) ──────────────────────────
process.on('unhandledRejection', (err) => {
    console.error('[PROCESS] Unhandled Rejection:', err);
});
process.on('uncaughtException', (err) => {
    console.error('[PROCESS] Uncaught Exception:', err);
});
if (!process.env.PRIVATE_KEY || process.env.PRIVATE_KEY === 'senin_private_keyin') {
    require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: true });
    console.log('[Config] Loaded root .env (backend/.env had placeholder PRIVATE_KEY)');
}

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { ethers } = require('ethers');
const { moltbookAuth, getKarmaTier } = require('./middleware/moltbookAuth');

// Services
const { GameEngine } = require('./services/GameEngine');
const { ArenaManager } = require('./services/ArenaManager');
const { AgentAutonomousLoop } = require('./services/AgentAutonomousLoop');
const createRoutes = require('./routes/api');
const strategies = require('./templates/strategies');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
const MONAD_RPC = process.env.MONAD_RPC || process.env.MONAD_TESTNET_RPC || 'https://rpc.monad.xyz';
const PLATFORM_PRIVATE_KEY = process.env.PRIVATE_KEY || '';

// ─── Blockchain Provider ─────────────────────────────────────────────────────
let provider, platformSigner;
console.log('[Chain] RPC URL:', MONAD_RPC);
console.log('[Chain] PRIVATE_KEY set:', PLATFORM_PRIVATE_KEY ? (PLATFORM_PRIVATE_KEY === 'senin_private_keyin' ? '⚠️ PLACEHOLDER (senin_private_keyin)' : `✅ ${PLATFORM_PRIVATE_KEY.slice(0, 6)}...${PLATFORM_PRIVATE_KEY.slice(-4)}`) : '❌ NOT SET');
try {
    provider = new ethers.JsonRpcProvider(MONAD_RPC);
    // Verify provider actually connects to the network
    provider.getNetwork().then(network => {
        console.log(`[Chain] ✅ Connected to network: chainId=${network.chainId}, name=${network.name}`);
    }).catch(err => {
        console.error(`[Chain] ❌ Provider getNetwork() FAILED:`, err.message);
        console.error('[Chain] ❌ Balance queries and transactions will FAIL!');
    });
    if (PLATFORM_PRIVATE_KEY && PLATFORM_PRIVATE_KEY !== 'senin_private_keyin') {
        platformSigner = new ethers.Wallet(PLATFORM_PRIVATE_KEY, provider);
        console.log('[Chain] ✅ Platform signer:', platformSigner.address);
    } else {
        console.warn('[Chain] ⚠️ No valid PRIVATE_KEY — platformSigner NOT created. Contract calls will be skipped.');
        console.warn('[Chain] ⚠️ Set a real PRIVATE_KEY in backend/.env to enable on-chain operations.');
    }
} catch (e) {
    console.error('[Chain] ❌ Provider init FAILED:', e.message);
}

// AgentRegistry ABI (registerAgent + view functions for recovery)
const AGENT_REGISTRY_ABI = [
    'function registerAgent(address agentWallet, string name, string strategyDescription, tuple(uint8 aggressiveness, uint8 riskTolerance, uint8 briberyPolicy, uint256 profitTarget, uint256 withdrawThreshold, uint8 allianceTendency, uint8 betrayalChance) params) payable returns (uint256)',
    'function getAgent(uint256 agentId) view returns (tuple(address owner, address agentWallet, string name, string strategyDescription, tuple(uint8,uint8,uint8,uint256,uint256,uint8,uint8) params, uint8 status, uint256 budget, uint256 totalEarnings, uint256 totalLosses, uint256 matchesPlayed, uint256 matchesWon, int256 eloRating, uint256 createdAt, bool isExternal))',
    'function creationFee() view returns (uint256)',
    'function depositBudget(uint256 agentId) payable',
    'function totalAgents() view returns (uint256)',
    'function getOwnerAgents(address owner) view returns (uint256[])',
];

// BuffOracle ABI (minimal)
const BUFF_ORACLE_ABI = [
    'function applyBuff(address agent, uint8 buffType) payable',
    'function getActiveBuffs(address agent) view returns (uint16 healthBuff, uint16 armorBuff, uint16 attackBuff, uint16 speedBuff)',
    'function agentTotalBurned(address) view returns (uint256)',
];

// Leaderboard ABI (minimal for recordMatch)
const LEADERBOARD_ABI = [
    'function recordMatch(uint256 winnerId, uint256 loserId, uint256 matchId, int256 winnerNewElo, int256 loserNewElo, uint256 earningsAmount) external',
    'function recordBetrayal(uint256 agentId) external',
];

let registryContract, buffOracleContract, leaderboardContract;
if (platformSigner) {
    if (process.env.AGENT_REGISTRY_ADDRESS) {
        registryContract = new ethers.Contract(process.env.AGENT_REGISTRY_ADDRESS, AGENT_REGISTRY_ABI, platformSigner);
    }
    if (process.env.BUFF_ORACLE_ADDRESS) {
        buffOracleContract = new ethers.Contract(process.env.BUFF_ORACLE_ADDRESS, BUFF_ORACLE_ABI, platformSigner);
    }
    if (process.env.LEADERBOARD_ADDRESS) {
        leaderboardContract = new ethers.Contract(process.env.LEADERBOARD_ADDRESS, LEADERBOARD_ABI, platformSigner);
    }
}

// ─── Service Instances ───────────────────────────────────────────────────────
const gameEngine = new GameEngine({
    geminiApiKey: process.env.GEMINI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    groqApiKey: process.env.GROQ_API_KEY,
});
const arenaManager = new ArenaManager(gameEngine);

// ─── In-memory Storage ───────────────────────────────────────────────────────
const thoughts = {};
const agents = {};
const leaderboard = {};  // agentId → { elo, wins, losses, draws, earnings, betrayals, bribes, streak, maxStreak, lastMatch }
const transferHistory = {}; // agentId → [{ type, amount, txHash, from, to, timestamp }]

// ─── Platform Fee Config ─────────────────────────────────────────────────────
const PLATFORM_FEE_PERCENT = 5; // 5% platform fee on prize pools
const PLATFORM_FEE_ADDRESS = platformSigner ? platformSigner.address : null;

// ═══════════════════════════════════════════════════════════════════════════════
// ON-CHAIN TRANSACTION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Collect entry fee on-chain: agent wallet → platform wallet
 * @param {object} agent - agent object with agentPrivateKey, agentWalletAddress
 * @param {number} entryFeeMON - entry fee in MON
 * @returns {{ txHash: string, success: boolean }} or null on failure
 */
async function collectEntryFeeOnchain(agent, entryFeeMON) {
    if (!provider || !platformSigner || !agent.agentPrivateKey) {
        const missing = [];
        if (!provider) missing.push('provider');
        if (!platformSigner) missing.push('platformSigner');
        if (!agent.agentPrivateKey) missing.push('agentPrivateKey');
        console.warn(`[OnChain] ⚠️ Skipping entry fee tx for ${agent.name || agent.id} — missing: ${missing.join(', ')}`);
        return null;
    }
    try {
        const agentSigner = new ethers.Wallet(agent.agentPrivateKey, provider);
        const value = ethers.parseEther(String(entryFeeMON));
        console.log(`[OnChain] 🎟️ Entry fee tx: ${agent.name} → ${entryFeeMON} MON to platform (${PLATFORM_FEE_ADDRESS})`);
        const tx = await agentSigner.sendTransaction({
            to: PLATFORM_FEE_ADDRESS,
            value,
        });
        console.log(`[OnChain] ⏳ Entry fee TX submitted: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`[OnChain] ✅ Entry fee confirmed: ${tx.hash} (block: ${receipt.blockNumber})`);

        // Record in transfer history
        if (!transferHistory[agent.id]) transferHistory[agent.id] = [];
        transferHistory[agent.id].push({
            type: 'entry_fee',
            amount: entryFeeMON,
            txHash: tx.hash,
            from: agent.agentWalletAddress,
            to: PLATFORM_FEE_ADDRESS,
            timestamp: Date.now(),
        });

        return { txHash: tx.hash, success: true };
    } catch (err) {
        console.error(`[OnChain] ❌ Entry fee tx failed for ${agent.name || agent.id}:`, err.message);
        return { txHash: null, success: false, error: err.message };
    }
}

/**
 * Distribute prizes on-chain after match completes.
 * Deducts platform fee (5%) first, then sends rewards.
 * 
 * @param {object} match - the match object
 * @param {Array} distributions - [{ agentId, amount }] from GameEngine.distributePrize
 * @param {string} arenaId - arena identifier
 * @returns {Array} array of { agentId, amount, txHash, type }
 */
async function distributePrizesOnchain(match, distributions, arenaId) {
    if (!provider || !platformSigner) {
        console.warn(`[OnChain] ⚠️ Skipping prize distribution — missing provider/platformSigner`);
        return [];
    }

    const results = [];
    const totalPool = match.prizePool;
    
    // Calculate 5% platform fee
    const platformFee = totalPool * (PLATFORM_FEE_PERCENT / 100);
    const netPool = totalPool - platformFee;
    
    console.log(`[OnChain] 💰 Prize distribution for ${match.matchId}:`);
    console.log(`[OnChain]    Total pool: ${totalPool} MON | Platform fee (${PLATFORM_FEE_PERCENT}%): ${platformFee.toFixed(4)} MON | Net: ${netPool.toFixed(4)} MON`);

    // Scale distributions to net pool (after fee)
    const totalDistributed = distributions.reduce((s, d) => s + d.amount, 0);
    
    for (const dist of distributions) {
        const agent = agents[dist.agentId];
        if (!agent || !agent.agentWalletAddress) {
            console.warn(`[OnChain] ⚠️ No wallet for ${dist.agentId} — skipping prize send`);
            continue;
        }

        // Scale amount proportionally to net pool
        const scaledAmount = totalDistributed > 0 ? (dist.amount / totalDistributed) * netPool : 0;
        if (scaledAmount <= 0) continue;

        try {
            const value = ethers.parseEther(scaledAmount.toFixed(6));
            console.log(`[OnChain] 🏆 Sending ${scaledAmount.toFixed(4)} MON → ${agent.name} (${agent.agentWalletAddress})`);
            const tx = await platformSigner.sendTransaction({
                to: agent.agentWalletAddress,
                value,
            });
            console.log(`[OnChain] ⏳ Prize TX submitted: ${tx.hash}`);
            const receipt = await tx.wait();
            console.log(`[OnChain] ✅ Prize confirmed: ${tx.hash} (block: ${receipt.blockNumber})`);

            // Record in transfer history
            if (!transferHistory[dist.agentId]) transferHistory[dist.agentId] = [];
            transferHistory[dist.agentId].push({
                type: 'prize_won',
                amount: scaledAmount,
                txHash: tx.hash,
                from: PLATFORM_FEE_ADDRESS,
                to: agent.agentWalletAddress,
                matchId: match.matchId,
                arenaId,
                timestamp: Date.now(),
            });

            results.push({
                agentId: dist.agentId,
                agentName: agent.name,
                amount: scaledAmount,
                txHash: tx.hash,
                wallet: agent.agentWalletAddress,
                type: 'prize_won',
            });
        } catch (err) {
            console.error(`[OnChain] ❌ Prize tx failed for ${agent.name || dist.agentId}:`, err.message);
            results.push({
                agentId: dist.agentId,
                agentName: agent?.name || dist.agentId,
                amount: scaledAmount,
                txHash: null,
                error: err.message,
                type: 'prize_failed',
            });
        }
    }

    // Log platform fee (it stays in platform wallet — no tx needed, it was collected via entry fees)
    if (platformFee > 0) {
        console.log(`[OnChain] 🏦 Platform fee retained: ${platformFee.toFixed(4)} MON in ${PLATFORM_FEE_ADDRESS}`);
        results.push({
            agentId: 'platform',
            agentName: 'Platform Fee',
            amount: platformFee,
            txHash: 'retained',
            wallet: PLATFORM_FEE_ADDRESS,
            type: 'platform_fee',
        });
    }

    // Save transfer history to disk
    saveAgents();

    return results;
}

// ─── Agent Persistence (full data + private keys) ───────────────────────────
const AGENT_KEYS_DIR = path.join(__dirname, 'data');
const AGENT_KEYS_FILE = path.join(AGENT_KEYS_DIR, 'agent-keys.json');
const AGENTS_FILE = path.join(AGENT_KEYS_DIR, 'agents.json');
const LEADERBOARD_FILE = path.join(AGENT_KEYS_DIR, 'leaderboard.json');
const TRANSFER_HISTORY_FILE = path.join(AGENT_KEYS_DIR, 'transfer-history.json');

function loadAgentKeys() {
    try {
        if (fs.existsSync(AGENT_KEYS_FILE)) {
            const data = JSON.parse(fs.readFileSync(AGENT_KEYS_FILE, 'utf-8'));
            console.log(`[Persistence] Loaded ${Object.keys(data).length} agent keys from disk`);
            return data;
        }
    } catch (err) {
        console.error('[Persistence] ❌ Failed to load agent keys:', err.message);
    }
    return {};
}

function saveAgentKeys() {
    try {
        if (!fs.existsSync(AGENT_KEYS_DIR)) {
            fs.mkdirSync(AGENT_KEYS_DIR, { recursive: true });
        }
        // Collect all agent keys: agentWalletAddress → { privateKey, agentId, ownerAddress }
        const keyMap = {};
        for (const agent of Object.values(agents)) {
            if (agent.agentPrivateKey && agent.agentWalletAddress) {
                keyMap[agent.agentWalletAddress.toLowerCase()] = {
                    privateKey: agent.agentPrivateKey,
                    agentId: agent.id,
                    ownerAddress: agent.ownerAddress || null,
                    name: agent.name,
                    onchainId: agent.onchainId || null,
                };
            }
        }
        fs.writeFileSync(AGENT_KEYS_FILE, JSON.stringify(keyMap, null, 2));
        console.log(`[Persistence] Saved ${Object.keys(keyMap).length} agent keys to disk`);
    } catch (err) {
        console.error('[Persistence] ❌ Failed to save agent keys:', err.message);
    }
}

/** Load previously saved keys into memory (call before chain recovery) */
const savedAgentKeys = loadAgentKeys();

// ─── Full Agent Data Persistence ─────────────────────────────────────────────
function saveAgents() {
    try {
        if (!fs.existsSync(AGENT_KEYS_DIR)) {
            fs.mkdirSync(AGENT_KEYS_DIR, { recursive: true });
        }
        // Save agent data WITHOUT private keys
        const safeAgents = {};
        for (const [id, agent] of Object.entries(agents)) {
            const { agentPrivateKey, strategyCode, ...safe } = agent;
            safe._hasStrategyCode = !!strategyCode?.decide;
            safe._strategyRaw = agent.strategy || null;
            safeAgents[id] = safe;
        }
        fs.writeFileSync(AGENTS_FILE, JSON.stringify(safeAgents, null, 2));
        fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(leaderboard, null, 2));
        fs.writeFileSync(TRANSFER_HISTORY_FILE, JSON.stringify(transferHistory, null, 2));
        console.log(`[Persistence] Saved ${Object.keys(safeAgents).length} agents to disk`);
    } catch (err) {
        console.error('[Persistence] ❌ Failed to save agents:', err.message);
    }
}

function loadAgents() {
    try {
        if (fs.existsSync(AGENTS_FILE)) {
            const data = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf-8'));
            let count = 0;
            for (const [id, agent] of Object.entries(data)) {
                if (agents[id]) continue; // already in memory
                // Restore strategy code from raw string
                let strategyCode = {};
                if (agent._strategyRaw) {
                    try {
                        const fn = new Function('return ' + agent._strategyRaw)();
                        strategyCode = { decide: fn };
                    } catch (e) {
                        console.warn(`[Persistence] Strategy parse failed for ${agent.name}:`, e.message);
                    }
                }
                // Restore private key from saved keys
                const walletKey = agent.agentWalletAddress?.toLowerCase();
                const savedKey = walletKey ? savedAgentKeys[walletKey] : null;

                agents[id] = {
                    ...agent,
                    strategyCode,
                    agentPrivateKey: savedKey?.privateKey || null,
                };
                delete agents[id]._hasStrategyCode;
                delete agents[id]._strategyRaw;
                count++;
            }
            console.log(`[Persistence] Loaded ${count} agents from disk`);
        }
        // Load leaderboard
        if (fs.existsSync(LEADERBOARD_FILE)) {
            const lb = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf-8'));
            for (const [id, entry] of Object.entries(lb)) {
                if (!leaderboard[id]) leaderboard[id] = entry;
            }
            console.log(`[Persistence] Loaded ${Object.keys(lb).length} leaderboard entries from disk`);
        }
        // Load transfer history
        if (fs.existsSync(TRANSFER_HISTORY_FILE)) {
            const th = JSON.parse(fs.readFileSync(TRANSFER_HISTORY_FILE, 'utf-8'));
            for (const [id, history] of Object.entries(th)) {
                if (!transferHistory[id]) transferHistory[id] = history;
            }
            console.log(`[Persistence] Loaded transfer history from disk`);
        }
    } catch (err) {
        console.error('[Persistence] ❌ Failed to load agents:', err.message);
    }
}

// Load agents from disk on startup (before chain recovery)
loadAgents();

/**
 * Recover agents from AgentRegistry on-chain contract.
 * Reads totalAgents, then fetches each agent and rebuilds in-memory state.
 * Private keys are loaded from the local agent-keys.json file.
 */
async function loadAgentsFromChain() {
    if (!registryContract || !provider) {
        console.warn('[Recovery] ⚠️ No registry contract or provider — skipping on-chain recovery');
        return;
    }

    try {
        const total = await registryContract.totalAgents();
        const totalNum = Number(total);
        console.log(`[Recovery] Found ${totalNum} agents on-chain, recovering...`);

        let recovered = 0;
        for (let i = 1; i <= totalNum; i++) {
            try {
                const onchainAgent = await registryContract.getAgent(i);

                // Skip decommissioned agents (status 3)
                if (Number(onchainAgent.status) === 3) continue;

                const walletAddr = onchainAgent.agentWallet;
                const ownerAddr = onchainAgent.owner;

                // Check if this agent is already in memory
                const existing = Object.values(agents).find(
                    a => a.agentWalletAddress?.toLowerCase() === walletAddr.toLowerCase()
                );
                if (existing) {
                    // Update onchainId if missing
                    if (!existing.onchainId) {
                        existing.onchainId = i;
                        existing.onchainRegistered = true;
                    }
                    continue;
                }

                // Parse on-chain strategy params
                const params = onchainAgent.params;
                const briberyMap = ['reject', 'accept', 'conditional'];

                const agentId = `agent_recovered_${i}_${Math.random().toString(36).substr(2, 6)}`;

                // Look up private key from saved keys
                const savedKey = savedAgentKeys[walletAddr.toLowerCase()];

                agents[agentId] = {
                    id: agentId,
                    name: onchainAgent.name || `Agent #${i}`,
                    traits: [],
                    strategy: '',
                    strategyCode: {},
                    strategyParams: {
                        aggressiveness: Number(params[0]),
                        riskTolerance: Number(params[1]),
                        briberyPolicy: briberyMap[Number(params[2])] || 'conditional',
                        profitTarget: Number(params[3]),
                        withdrawThreshold: Number(params[4]),
                        allianceTendency: Number(params[5]),
                        betrayalChance: Number(params[6]),
                    },
                    strategyDescription: onchainAgent.strategyDescription || '',
                    ownerAddress: ownerAddr,
                    agentWalletAddress: walletAddr,
                    agentPrivateKey: savedKey?.privateKey || null,
                    createdAt: Number(onchainAgent.createdAt) * 1000 || Date.now(),
                    status: 'idle',
                    onchainId: i,
                    onchainRegistered: true,
                    stats: {
                        wins: Number(onchainAgent.matchesWon) || 0,
                        losses: (Number(onchainAgent.matchesPlayed) || 0) - (Number(onchainAgent.matchesWon) || 0),
                        earnings: 0,
                        betrayals: 0,
                        bribes: 0,
                    },
                    financial: {
                        initialDeposit: 0,
                        totalDeposited: 0,
                        totalWithdrawn: 0,
                    },
                    buffs: { health: 0, armor: 0, attack: 0, speed: 0, expiresAt: 0, matchesLeft: 0 },
                };

                transferHistory[agentId] = [];
                initLeaderboardEntry(agentId);
                // Update leaderboard from on-chain ELO
                if (leaderboard[agentId]) {
                    leaderboard[agentId].elo = Number(onchainAgent.eloRating) || 1000;
                    leaderboard[agentId].wins = Number(onchainAgent.matchesWon) || 0;
                    leaderboard[agentId].losses = (Number(onchainAgent.matchesPlayed) || 0) - (Number(onchainAgent.matchesWon) || 0);
                }

                recovered++;

                if (!savedKey) {
                    console.warn(`[Recovery] ⚠️ Agent #${i} (${onchainAgent.name}) — no private key found in local storage. Withdrawals disabled.`);
                }
            } catch (err) {
                console.error(`[Recovery] ❌ Failed to recover agent #${i}:`, err.message);
            }
        }

        console.log(`[Recovery] ✅ Recovered ${recovered} agents from on-chain (${totalNum} total on registry)`);
    } catch (err) {
        console.error('[Recovery] ❌ On-chain agent recovery failed:', err.message);
    }
}

/**
 * Fetch agents from on-chain for a specific owner wallet.
 * Used as fallback when GET /api/agents/:owner finds nothing in memory.
 */
async function fetchOwnerAgentsFromChain(ownerAddress) {
    if (!registryContract || !provider) return [];

    try {
        const onchainIds = await registryContract.getOwnerAgents(ownerAddress);
        if (!onchainIds || onchainIds.length === 0) return [];

        const results = [];
        for (const id of onchainIds) {
            try {
                const oca = await registryContract.getAgent(id);
                if (Number(oca.status) === 3) continue; // skip decommissioned

                const walletAddr = oca.agentWallet;

                // Check if already in memory
                const existing = Object.values(agents).find(
                    a => a.agentWalletAddress?.toLowerCase() === walletAddr.toLowerCase()
                );
                if (existing) {
                    results.push(existing);
                    continue;
                }

                // Reconstruct agent into memory
                const params = oca.params;
                const briberyMap = ['reject', 'accept', 'conditional'];
                const agentId = `agent_recovered_${Number(id)}_${Math.random().toString(36).substr(2, 6)}`;
                const savedKey = savedAgentKeys[walletAddr.toLowerCase()];

                const recoveredAgent = {
                    id: agentId,
                    name: oca.name || `Agent #${Number(id)}`,
                    traits: [],
                    strategy: '',
                    strategyCode: {},
                    strategyParams: {
                        aggressiveness: Number(params[0]),
                        riskTolerance: Number(params[1]),
                        briberyPolicy: briberyMap[Number(params[2])] || 'conditional',
                        profitTarget: Number(params[3]),
                        withdrawThreshold: Number(params[4]),
                        allianceTendency: Number(params[5]),
                        betrayalChance: Number(params[6]),
                    },
                    strategyDescription: oca.strategyDescription || '',
                    ownerAddress: oca.owner,
                    agentWalletAddress: walletAddr,
                    agentPrivateKey: savedKey?.privateKey || null,
                    createdAt: Number(oca.createdAt) * 1000 || Date.now(),
                    status: 'idle',
                    onchainId: Number(id),
                    onchainRegistered: true,
                    stats: {
                        wins: Number(oca.matchesWon) || 0,
                        losses: (Number(oca.matchesPlayed) || 0) - (Number(oca.matchesWon) || 0),
                        earnings: 0, betrayals: 0, bribes: 0,
                    },
                    financial: { initialDeposit: 0, totalDeposited: 0, totalWithdrawn: 0 },
                    buffs: { health: 0, armor: 0, attack: 0, speed: 0, expiresAt: 0, matchesLeft: 0 },
                };

                // Cache in memory for future requests
                agents[agentId] = recoveredAgent;
                transferHistory[agentId] = [];
                initLeaderboardEntry(agentId);
                if (leaderboard[agentId]) {
                    leaderboard[agentId].elo = Number(oca.eloRating) || 1000;
                }

                results.push(recoveredAgent);
            } catch (err) {
                console.error(`[Recovery] ❌ Failed to fetch agent #${id}:`, err.message);
            }
        }

        console.log(`[Recovery] Fetched ${results.length} agents for owner ${ownerAddress}`);
        return results;
    } catch (err) {
        console.error(`[Recovery] ❌ getOwnerAgents failed for ${ownerAddress}:`, err.message);
        return [];
    }
}

function initLeaderboardEntry(agentId) {
    if (!leaderboard[agentId]) {
        leaderboard[agentId] = {
            agentId,
            elo: 1000,
            wins: 0,
            losses: 0,
            draws: 0,
            earnings: 0,
            betrayals: 0,
            bribes: 0,
            streak: 0,
            maxStreak: 0,
            lastMatch: null,
        };
    }
    return leaderboard[agentId];
}

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());

// Security headers
app.use(helmet({ contentSecurityPolicy: false }));

// Rate limiters (disabled in development)
const isDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;

if (isDev) {
    console.log('[Config] ⚠️ Rate limiting DISABLED (development mode)');
} else {
    const apiLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 1000,
        message: { error: 'Too many requests, please try again later.' },
        standardHeaders: true,
        legacyHeaders: false
    });

    const agentLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 100,
        message: { error: 'Rate limit exceeded.' }
    });

    app.use('/api/', apiLimiter);
    app.use('/api/agents/external', agentLimiter);
}

// Request logging
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

// ─── Health Check Endpoint ───────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
    const health = {
        ok: true,
        timestamp: Date.now(),
        provider: !!provider,
        platformSigner: !!platformSigner,
        registryContract: !!registryContract,
        buffOracleContract: !!buffOracleContract,
        rpcUrl: MONAD_RPC,
        agentCount: Object.keys(agents).length,
    };
    if (provider) {
        try {
            const network = await provider.getNetwork();
            const blockNum = await provider.getBlockNumber();
            health.chainId = Number(network.chainId);
            health.blockNumber = blockNum;
            health.providerConnected = true;
        } catch (err) {
            health.providerConnected = false;
            health.providerError = err.message;
        }
    }
    if (platformSigner) {
        try {
            const bal = await provider.getBalance(platformSigner.address);
            health.platformSignerAddress = platformSigner.address;
            health.platformSignerBalance = ethers.formatEther(bal) + ' MON';
        } catch { /* ignore */ }
    }
    res.json(health);
});

// ─── Claude API Routes ───────────────────────────────────────────────────────

// POST /api/claude - Generate strategy with Claude
app.post('/api/claude', async (req, res) => {
    try {
        const { prompt, traits } = req.body;

        if (!prompt) {
            return res.status(400).json({ error: 'Prompt is required' });
        }

        if (!process.env.ANTHROPIC_API_KEY) {
            return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
        }

        const systemPrompt = `You are a game strategy coder for Monad Colosseum, a gladiator AI battle arena on Monad blockchain.
The agent has these traits: ${traits || 'balanced'}

Write a JavaScript function called "decide" that takes one parameter "gameState" with this shape:
{
  matchId: string,
  currentTurn: number,
  you: { id, hp, alive, turnsAlive, lastAction },
  opponents: [{ id, hp, alive, turnsAlive, lastAction }],
  alliances: [{ id, members: [string], prizeShare: {agentId: number} }],
  prizePool: number,
  history: [last 5 turn records]
}

Available actions the function MUST return as { action, target?, terms?, allianceId?, attackTarget? }:
- { action: 'attack', target: opponentId } — Deal damage to target
- { action: 'defend' } — Reduce incoming damage, recover HP
- { action: 'propose_alliance', target: opponentId, terms: { prizeShare: 50 } } — Propose alliance (prizeShare = your share %)
- { action: 'accept_alliance', proposer: agentId } — Accept pending alliance
- { action: 'betray_alliance', allianceId: string, attackTarget: agentId } — Betray your ally for bonus damage
- { action: 'bribe', target: opponentId, amount: number } — [Future] Bribe opponent not to attack you

Strategy tips:
- Low HP → defend or flee
- Allied → coordinate attacks on weakest non-ally
- Betrayal deals full damage ignoring defense, but breaks alliance
- Last one standing wins the prize pool

Consider the agent's personality traits deeply when making decisions.
Return ONLY the raw function code. No markdown backticks, no explanation.`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 800,
                system: systemPrompt,
                messages: [{ role: 'user', content: prompt }]
            })
        });

        const data = await response.json();

        if (data.error) {
            return res.status(500).json({ error: data.error.message });
        }

        const code = data.content[0].text;
        res.json({ code });
    } catch (error) {
        console.error('Claude API error:', error);
        res.status(500).json({ error: error.message });
    }
});

// POST /api/agent/create - Full agent creation from natural language
// Takes a single text description → Claude parses into params + strategy code
app.post('/api/agent/create', async (req, res) => {
    try {
        const { description, ownerAddress } = req.body;

        if (!description) {
            return res.status(400).json({ error: 'description is required' });
        }

        if (!process.env.ANTHROPIC_API_KEY) {
            return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
        }

        const systemPrompt = `You are the AI agent creator for Monad Colosseum — a gladiator AI battle arena on the Monad blockchain.

The user will describe their agent in natural language. Your job is to:
1. Extract a catchy agent name
2. Determine character traits
3. Parse strategy parameters (0-100 scale)
4. Generate battle strategy code

ARENA RULES:
- Agents fight in turn-based combat. Actions: attack, defend, propose_alliance, accept_alliance, betray_alliance, bribe
- ATTACK deals damage to a target. DEFEND reduces incoming damage and recovers HP.
- Alliances let agents cooperate, but betrayal deals bonus damage ignoring defense.
- Last one standing wins the prize pool.
- Outlaws (low reputation) deal 30% less damage.
- HP starts at 100, attack damage is ~20, defended damage is ~10, recovery is +5 HP.

GAME TYPES:
- "battle": Classic turn-based gladiator combat (multi-agent, last one standing)
- "rps": Rock-Paper-Scissors duels (1v1, best-of-3 rounds)
- "both": Agent enters both battle and RPS arenas (default)

RPS STRATEGY:
- Agents choose rock, paper, or scissors each round.
- Aggressive agents lean toward rock, diplomats toward paper, tricksters play randomly.
- Agents can counter the opponent's last move based on their aggressiveness level.

STRATEGY ARCHETYPES:
- Berserker: High aggression, low alliance, attacks weakest
- Diplomat: High alliance tendency, low betrayal, proposes alliances
- Schemer: Medium aggression, high betrayal chance, forms alliances then betrays
- Tank: Defends often, waits for opponents to weaken each other
- Opportunist: Adapts based on game state, attacks when advantageous

PARAMETER RANGES (0-100):
- aggressiveness: How often to attack vs defend (0=always defend, 100=always attack)
- riskTolerance: Willingness to join expensive arenas (0=only cheap, 100=any)
- allianceTendency: Likelihood of forming alliances (0=never, 100=always)
- betrayalChance: Probability of betraying an alliance (0=loyal, 100=always betray)
- briberyPolicy: "accept" | "reject" | "conditional"
- profitTarget: Target earnings before auto-withdraw (in MON, integer)
- withdrawThreshold: Auto-send to owner when balance exceeds (in MON, integer)
- preferredGameTypes: "battle" | "rps" | "both" (default "both" if user doesn't specify)

You MUST respond with ONLY a valid JSON object (no markdown, no backticks, no explanation):
{
  "name": "Agent Name",
  "traits": ["aggressive", "loyal", "briber", "ambusher", "balanced"],
  "strategyDescription": "Brief description of the strategy",
  "params": {
    "aggressiveness": 0-100,
    "riskTolerance": 0-100,
    "allianceTendency": 0-100,
    "betrayalChance": 0-100,
    "briberyPolicy": "accept" | "reject" | "conditional",
    "profitTarget": integer,
    "withdrawThreshold": integer,
    "preferredGameTypes": "battle" | "rps" | "both"
  },
  "strategyCode": "function decide(gameState) { ... full code ... }"
}`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 2000,
                system: systemPrompt,
                messages: [{ role: 'user', content: description }]
            })
        });

        const data = await response.json();

        if (data.error) {
            return res.status(500).json({ error: data.error.message });
        }

        const rawText = data.content[0].text;

        // Parse JSON response
        let parsed;
        try {
            // Try to extract JSON from potential markdown wrapping
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
            parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
        } catch (parseErr) {
            return res.status(500).json({ error: 'Failed to parse Claude response', raw: rawText });
        }

        // Validate and clamp params
        const params = parsed.params || {};
        const clamp = (v, min, max) => Math.max(min, Math.min(max, parseInt(v) || 50));

        const validatedParams = {
            aggressiveness: clamp(params.aggressiveness, 0, 100),
            riskTolerance: clamp(params.riskTolerance, 0, 100),
            allianceTendency: clamp(params.allianceTendency, 0, 100),
            betrayalChance: clamp(params.betrayalChance, 0, 100),
            briberyPolicy: ['accept', 'reject', 'conditional'].includes(params.briberyPolicy) ? params.briberyPolicy : 'conditional',
            profitTarget: Math.max(0, parseInt(params.profitTarget) || 200),
            withdrawThreshold: Math.max(0, parseInt(params.withdrawThreshold) || 10),
            preferredGameTypes: ['battle', 'rps', 'both'].includes(params.preferredGameTypes) ? params.preferredGameTypes : 'both',
        };

        // Create the agent
        const agentId = `agent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // ── Create autonomous wallet for the agent ──────────────────────
        const agentWallet = ethers.Wallet.createRandom();
        const agentWalletAddress = agentWallet.address;
        const agentPrivateKey = agentWallet.privateKey;

        let strategyCode = {};
        if (parsed.strategyCode) {
            try {
                const fn = new Function('return ' + parsed.strategyCode)();
                strategyCode = { decide: fn };
            } catch (e) {
                console.error('Strategy parse error:', e);
            }
        }

        agents[agentId] = {
            id: agentId,
            name: parsed.name || 'Unnamed Gladiator',
            traits: parsed.traits || [],
            strategy: parsed.strategyCode || '',
            strategyCode,
            strategyParams: validatedParams,
            strategyDescription: parsed.strategyDescription || '',
            ownerAddress: ownerAddress || null,
            agentWalletAddress,
            agentPrivateKey, // stored server-side only, never sent to frontend
            createdAt: Date.now(),
            status: 'idle', // idle | searching | fighting | won | lost
            onchainId: null,
            stats: { wins: 0, losses: 0, earnings: 0, betrayals: 0, bribes: 0 },
            financial: { initialDeposit: 0, totalDeposited: 0, totalWithdrawn: 0 },
            buffs: { health: 0, armor: 0, attack: 0, speed: 0, expiresAt: 0, matchesLeft: 0 },
        };

        transferHistory[agentId] = [];
        initLeaderboardEntry(agentId);

        // Persist agent data + private key to disk
        saveAgentKeys();
        saveAgents();

        // Onchain registration will be done by frontend via user's wallet (wagmi writeContract)
        // Backend only prepares the agent wallet + Claude data

        res.json({
            success: true,
            agent: {
                ...agents[agentId],
                agentPrivateKey: undefined, // never expose private key
            },
            agentWalletAddress,
            parsed: {
                name: parsed.name,
                traits: parsed.traits,
                strategyDescription: parsed.strategyDescription,
                params: validatedParams,
                hasCode: !!parsed.strategyCode,
            }
        });
    } catch (error) {
        console.error('Agent create error:', error);
        res.status(500).json({ error: error.message });
    }
});

// POST /api/agents - Create a new agent (legacy endpoint)
app.post('/api/agents', async (req, res) => {
    try {
        const { name, traits, strategy, ownerAddress, strategyParams } = req.body;

        const agentId = `agent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // ── Create REAL autonomous wallet for the agent ──────────────
        const agentWallet = ethers.Wallet.createRandom();
        const agentWalletAddress = agentWallet.address;
        const agentPrivateKey = agentWallet.privateKey;
        console.log(`[Chain] Legacy agent wallet created: ${agentWalletAddress}`);

        // Parse strategy code into executable function
        let strategyCode = {};
        if (strategy) {
            try {
                const fn = new Function('return ' + strategy)();
                strategyCode = { decide: fn };
            } catch (e) {
                console.error('Strategy parse error:', e);
            }
        }

        // Default strategy params
        const defaultParams = {
            aggressiveness: 50,
            riskTolerance: 50,
            briberyPolicy: 'conditional',
            profitTarget: 200,
            withdrawThreshold: 10,
            allianceTendency: 50,
            betrayalChance: 20,
            preferredGameTypes: 'both',
        };

        agents[agentId] = {
            id: agentId,
            name,
            traits,
            strategy,
            strategyCode,
            strategyParams: { ...defaultParams, ...strategyParams },
            ownerAddress,
            agentWalletAddress,
            agentPrivateKey, // stored server-side only
            createdAt: Date.now(),
            status: 'idle',
            stats: { wins: 0, losses: 0, earnings: 0, betrayals: 0, bribes: 0 },
            financial: { initialDeposit: 0, totalDeposited: 0, totalWithdrawn: 0 },
            buffs: { health: 0, armor: 0, attack: 0, speed: 0, expiresAt: 0, matchesLeft: 0 },
        };

        transferHistory[agentId] = [];
        // Initialize leaderboard entry
        initLeaderboardEntry(agentId);

        // Persist agent data + private key to disk
        saveAgentKeys();
        saveAgents();

        res.json({ success: true, agent: { ...agents[agentId], agentPrivateKey: undefined } });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/agents/:owner - Get agents by owner (memory-first, on-chain fallback)
app.get('/api/agents/:owner', async (req, res) => {
    try {
        const { owner } = req.params;
        let userAgents = Object.values(agents)
            .filter(a => a.ownerAddress?.toLowerCase() === owner.toLowerCase());

        // If nothing in memory, try recovering from on-chain
        if (userAgents.length === 0) {
            console.log(`[API] No agents in memory for ${owner}, checking on-chain...`);
            userAgents = await fetchOwnerAgentsFromChain(owner);
        }

        const safeAgents = userAgents.map(({ agentPrivateKey, ...safe }) => safe); // NEVER expose private key
        res.json(safeAgents);
    } catch (err) {
        console.error('[API] Error fetching agents:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/templates - Return preset strategies
app.get('/api/templates', (req, res) => {
    res.json(strategies);
});

// POST /api/agents/external - Register an external agent (supports Moltbook token auth)
app.post('/api/agents/external', moltbookAuth, async (req, res) => {
    try {
        const { walletAddress, callbackUrl } = req.body;
        let { name, platformOrigin } = req.body;

        // If Moltbook-authenticated, pull info from verified token
        const moltbookAgent = req.bot || null;
        if (moltbookAgent) {
            name = name || moltbookAgent.name;
            platformOrigin = 'moltbook';
            console.log(`[Moltbook] Registering verified agent: ${moltbookAgent.name} (karma: ${moltbookAgent.karma})`);
        }

        if (!walletAddress || !name) {
            return res.status(400).json({ error: 'walletAddress and name are required' });
        }

        const agentId = `ext_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Generate REAL managed wallet for external agent (platform-side)
        const managedWalletObj = ethers.Wallet.createRandom();
        const managedWallet = managedWalletObj.address;
        const managedWalletPrivateKey = managedWalletObj.privateKey;
        console.log(`[Chain] External agent real wallet created: ${managedWallet}`);

        const defaultParams = {
            aggressiveness: 50,
            riskTolerance: 50,
            briberyPolicy: 'conditional',
            profitTarget: 0,
            withdrawThreshold: 0,
            allianceTendency: 50,
            betrayalChance: 20,
        };

        // Moltbook karma tier for reward multiplier
        const karmaTier = moltbookAgent ? getKarmaTier(moltbookAgent.karma) : null;

        agents[agentId] = {
            id: agentId,
            name,
            traits: moltbookAgent ? (moltbookAgent.stats.traits || []) : [],
            strategy: null,
            strategyCode: {},
            strategyParams: defaultParams,
            ownerAddress: walletAddress,
            agentWalletAddress: managedWallet,
            agentPrivateKey: managedWalletPrivateKey, // stored server-side only
            managedWallet,
            createdAt: Date.now(),
            isExternal: true,
            callbackUrl: callbackUrl || null,
            platformOrigin: platformOrigin || 'unknown',
            stats: { wins: 0, losses: 0, earnings: 0, betrayals: 0, bribes: 0 },
            financial: { initialDeposit: 0, totalDeposited: 0, totalWithdrawn: 0 },
            buffs: { health: 0, armor: 0, attack: 0, speed: 0, expiresAt: 0, matchesLeft: 0 },
            // Moltbook-specific fields
            moltbook: moltbookAgent ? {
                agentId: moltbookAgent.id,
                karma: moltbookAgent.karma,
                tier: karmaTier.tier,
                freeEntry: karmaTier.freeEntry,
                rewardMultiplier: karmaTier.rewardMultiplier,
            } : null,
        };

        // If callbackUrl provided, create a webhook-based strategy
        if (callbackUrl) {
            agents[agentId].strategyCode = {
                decide: async (gameState) => {
                    try {
                        const controller = new AbortController();
                        const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout
                        const resp = await fetch(callbackUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ gameState, agentId }),
                            signal: controller.signal
                        });
                        clearTimeout(timeout);
                        const data = await resp.json();
                        return data.action ? data : { action: 'defend' };
                    } catch (err) {
                        console.warn(`[Webhook] ${agentId} timeout/error, defaulting to defend:`, err.message);
                        return { action: 'defend' };
                    }
                }
            };
        }

        initLeaderboardEntry(agentId);
        transferHistory[agentId] = [];

        const { agentPrivateKey: _pk, ...safeAgent } = agents[agentId];

        // Build response with Moltbook info if applicable
        const response = {
            success: true,
            agent: safeAgent,
            managedWallet,
            note: callbackUrl ? 'Webhook-based decisions enabled (5s timeout, fallback: defend)' : 'No callbackUrl — agent will use default defend strategy'
        };

        if (moltbookAgent && karmaTier) {
            response.moltbook = {
                verified: true,
                karma: moltbookAgent.karma,
                tier: karmaTier.tier,
                perks: {
                    freeEntry: karmaTier.freeEntry,
                    rewardMultiplier: `${Math.round(karmaTier.rewardMultiplier * 100)}%`,
                },
            };
        }

        res.json(response);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/heartbeat - Store agent thoughts (for spectate mode)
app.post('/api/heartbeat', async (req, res) => {
    try {
        const { agent, thought, action, arena, round } = req.body;

        const arenaId = arena || 'default';
        if (!thoughts[arenaId]) {
            thoughts[arenaId] = [];
        }

        thoughts[arenaId].push({
            agent,
            thought,
            action,
            round,
            timestamp: Date.now()
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Heartbeat error:', error);
        res.status(500).json({ error: error.message });
    }
});

// GET /api/thoughts/:arenaId - Get thoughts for an arena
app.get('/api/thoughts/:arenaId', (req, res) => {
    const { arenaId } = req.params;
    res.json(thoughts[arenaId] || []);
});

// GET /api/arenas - List all arenas with live status
app.get('/api/arenas', (req, res) => {
    try {
        const statusFilter = req.query.status || null;
        const gameTypeFilter = req.query.gameType || null;
        const allArenas = arenaManager.listArenas(statusFilter, gameTypeFilter);
        const result = allArenas.map(arena => {
            const lobby = arenaManager.getLobby(arena.arenaId);
            return {
                arenaId: arena.arenaId,
                name: arena.name,
                tier: arena.tier,
                gameType: arena.gameType,
                entryFee: arena.entryFee,
                maxAgents: arena.maxAgents,
                minAgents: arena.minAgents,
                prizePool: arena.prizePool,
                status: arena.status,
                matchId: arena.matchId,
                createdAt: arena.createdAt,
                agentCount: lobby ? lobby.agents.length : 0,
                agents: lobby ? lobby.agents.map(a => ({ id: a.id, name: a.name })) : [],
            };
        });
        // Sort: in_progress first, then lobby, then open, then completed
        const statusOrder = { in_progress: 0, lobby: 1, open: 2, completed: 3 };
        result.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));
        res.json({ ok: true, arenas: result, total: result.length });
    } catch (err) {
        console.error('[API] /api/arenas error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Leaderboard API Routes ──────────────────────────────────────────────────

// GET /api/agents - Get all agents (supports ?wallet= filter)
app.get('/api/agents', (req, res) => {
    try {
        let result = Object.values(agents);
        if (req.query.wallet) {
            result = result.filter(a => a.ownerAddress?.toLowerCase() === req.query.wallet.toLowerCase());
        }
        const safeAgents = result.map(({ agentPrivateKey, ...safe }) => safe);
        res.json({ ok: true, agents: safeAgents });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /api/leaderboard - Get sorted leaderboard
app.get('/api/leaderboard', (req, res) => {
    const sortBy = req.query.sort || 'elo';
    const limit = parseInt(req.query.limit) || 50;

    let entries = Object.values(leaderboard);

    // Enrich with agent names
    entries = entries.map(e => ({
        ...e,
        name: agents[e.agentId]?.name || 'Unknown',
        traits: agents[e.agentId]?.traits || '',
        owner: agents[e.agentId]?.ownerAddress || null,
    }));

    // Sort
    switch (sortBy) {
        case 'wins': entries.sort((a, b) => b.wins - a.wins); break;
        case 'earnings': entries.sort((a, b) => b.earnings - a.earnings); break;
        case 'betrayals': entries.sort((a, b) => b.betrayals - a.betrayals); break;
        case 'streak': entries.sort((a, b) => b.maxStreak - a.maxStreak); break;
        case 'elo':
        default: entries.sort((a, b) => b.elo - a.elo); break;
    }

    res.json({ ok: true, leaderboard: entries.slice(0, limit) });
});

// GET /api/leaderboard/:agentId - Get single agent leaderboard entry
app.get('/api/leaderboard/:agentId', (req, res) => {
    const entry = leaderboard[req.params.agentId];
    if (!entry) return res.status(404).json({ ok: false, error: 'Agent not on leaderboard' });

    const agent = agents[req.params.agentId];
    res.json({
        ok: true,
        entry: {
            ...entry,
            name: agent?.name || 'Unknown',
            traits: agent?.traits || '',
            owner: agent?.ownerAddress || null,
        }
    });
});

// POST /api/leaderboard/record - Record match result (internal use or testing)
app.post('/api/leaderboard/record', (req, res) => {
    try {
        const { winnerId, loserIds, prizeAmount, betrayals, bribes } = req.body;

        // Update winner
        if (winnerId) {
            const w = initLeaderboardEntry(winnerId);
            w.wins++;
            w.streak++;
            w.maxStreak = Math.max(w.maxStreak, w.streak);
            w.earnings += prizeAmount || 0;
            w.lastMatch = Date.now();
            // ELO calculation (simplified K=32)
            const avgLoserElo = loserIds?.length > 0
                ? loserIds.reduce((s, id) => s + (leaderboard[id]?.elo || 1000), 0) / loserIds.length
                : 1000;
            const expected = 1 / (1 + Math.pow(10, (avgLoserElo - w.elo) / 400));
            w.elo = Math.round(w.elo + 32 * (1 - expected));

            if (agents[winnerId]) agents[winnerId].stats.wins++;
        }

        // Update losers
        if (loserIds) {
            for (const loserId of loserIds) {
                const l = initLeaderboardEntry(loserId);
                l.losses++;
                l.streak = 0;
                l.lastMatch = Date.now();
                const winnerElo = winnerId ? (leaderboard[winnerId]?.elo || 1000) : 1000;
                const expected = 1 / (1 + Math.pow(10, (winnerElo - l.elo) / 400));
                l.elo = Math.max(100, Math.round(l.elo + 32 * (0 - expected)));

                if (agents[loserId]) agents[loserId].stats.losses++;
            }
        }

        // Record betrayals & bribes
        if (betrayals) {
            for (const { agentId } of betrayals) {
                const e = initLeaderboardEntry(agentId);
                e.betrayals++;
                if (agents[agentId]) agents[agentId].stats.betrayals = (agents[agentId].stats.betrayals || 0) + 1;
            }
        }
        if (bribes) {
            for (const { agentId } of bribes) {
                const e = initLeaderboardEntry(agentId);
                e.bribes++;
                if (agents[agentId]) agents[agentId].stats.bribes = (agents[agentId].stats.bribes || 0) + 1;
            }
        }

        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── GameEngine API Routes ───────────────────────────────────────────────────
app.use('/api', createRoutes(arenaManager, gameEngine));

// ─── HTTP Server ─────────────────────────────────────────────────────────────
const server = http.createServer(app);

// ─── WebSocket Server ────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

// Track client subscriptions: ws → Set<arenaId>
const subscriptions = new Map();
const wildcardClients = new Set(); // Clients that subscribed with '*'

wss.on('connection', (ws) => {
    subscriptions.set(ws, new Set());
    console.log(`[WS] Client connected (total: ${wss.clients.size})`);

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);
            handleWsMessage(ws, msg);
        } catch {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        }
    });

    ws.on('close', () => {
        subscriptions.delete(ws);
        wildcardClients.delete(ws);
        console.log(`[WS] Client disconnected (total: ${wss.clients.size})`);
    });

    // Welcome message
    ws.send(JSON.stringify({
        type: 'welcome',
        timestamp: Date.now(),
        openArenas: arenaManager.listArenas('open').map((a) => a.arenaId),
    }));
});

function handleWsMessage(ws, msg) {
    switch (msg.type) {
        case 'subscribe': {
            const subs = subscriptions.get(ws);
            if (msg.arenaId === '*') {
                // Subscribe to all current arenas
                for (const [arenaId] of arenaManager.arenas) {
                    subs.add(arenaId);
                }
                wildcardClients.add(ws);
                ws.send(JSON.stringify({ type: 'subscribed', arenaId: '*', count: subs.size }));
            } else if (msg.arenaId) {
                subs.add(msg.arenaId);
                ws.send(JSON.stringify({ type: 'subscribed', arenaId: msg.arenaId }));
            }
            break;
        }
        case 'unsubscribe': {
            const subs = subscriptions.get(ws);
            if (msg.arenaId) subs.delete(msg.arenaId);
            ws.send(JSON.stringify({ type: 'unsubscribed', arenaId: msg.arenaId }));
            break;
        }
        case 'ping':
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            break;
        default:
            ws.send(JSON.stringify({ type: 'error', message: `Unknown type: ${msg.type}` }));
    }
}

/**
 * Broadcast an event to all clients subscribed to a specific arena.
 */
function broadcastToArena(arenaId, event) {
    try {
        const payload = JSON.stringify(event);
        for (const [ws, subs] of subscriptions) {
            try {
                if (ws.readyState === WebSocket.OPEN && subs.has(arenaId)) {
                    ws.send(payload);
                }
            } catch (wsErr) {
                console.error('[WS] Send error to client:', wsErr.message);
            }
        }
    } catch (err) {
        console.error('[WS] broadcastToArena error:', err.message);
    }
}

/**
 * Broadcast to ALL connected clients.
 */
function broadcastAll(event) {
    try {
        const payload = JSON.stringify(event);
        for (const client of wss.clients) {
            try {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(payload);
                }
            } catch (wsErr) {
                console.error('[WS] Send error to client:', wsErr.message);
            }
        }
    } catch (err) {
        console.error('[WS] broadcastAll error:', err.message);
    }
}

// ─── Wire Events → WebSocket ─────────────────────────────────────────────────

arenaManager.on('arenaCreated', (arena) => {
    broadcastAll({ type: 'arena:created', arena });
    // Auto-subscribe wildcard clients to new arenas
    for (const ws of wildcardClients) {
        const subs = subscriptions.get(ws);
        if (subs) subs.add(arena.arenaId);
    }
});

arenaManager.on('agentJoined', async (data) => {
    broadcastToArena(data.arenaId, { type: 'arena:agentJoined', ...data });

    // ── On-chain entry fee collection ──
    if (!data.isExternal) {
        const agent = agents[data.agentId];
        const arena = arenaManager.getArena(data.arenaId);
        if (agent && arena && arena.entryFee > 0) {
            const feeResult = await collectEntryFeeOnchain(agent, arena.entryFee);
            if (feeResult && feeResult.success) {
                broadcastToArena(data.arenaId, {
                    type: 'tx:entryFee',
                    agentId: data.agentId,
                    agentName: agent.name,
                    amount: arena.entryFee,
                    txHash: feeResult.txHash,
                    arenaId: data.arenaId,
                });
                console.log(`[OnChain] ✅ Entry fee broadcast: ${agent.name} paid ${arena.entryFee} MON (tx: ${feeResult.txHash})`);
            }
        }
    }
});

arenaManager.on('agentLeft', (data) => {
    broadcastToArena(data.arenaId, { type: 'arena:agentLeft', ...data });
});

arenaManager.on('countdownStarted', (data) => {
    broadcastToArena(data.arenaId, { type: 'arena:countdown', ...data });
});

arenaManager.on('matchLaunching', (data) => {
    broadcastToArena(data.arenaId, { type: 'match:launching', ...data });
});

arenaManager.on('turnCompleted', (data) => {
    // Find arenaId from matchId
    for (const [arenaId, arena] of arenaManager.arenas) {
        if (arena.matchId === data.matchId) {
            broadcastToArena(arenaId, { type: 'match:turn', ...data });
            break;
        }
    }
});

arenaManager.on('matchCompleted', (data) => {
    broadcastToArena(data.arenaId, { type: 'match:completed', ...data });
});

arenaManager.on('matchError', (data) => {
    broadcastToArena(data.arenaId, { type: 'match:error', ...data });
});

// ── On-chain prize distribution when GameEngine distributes prizes ──
gameEngine.on('prizeDistributed', async (data) => {
    const { matchId, distributions } = data;
    if (!distributions || distributions.length === 0) return;

    // Find the match and arenaId
    const match = gameEngine.getMatch(matchId);
    if (!match) return;

    let arenaId = null;
    for (const [aId, arena] of arenaManager.arenas) {
        if (arena.matchId === matchId) { arenaId = aId; break; }
    }

    console.log(`[OnChain] 💰 prizeDistributed event for ${matchId} — ${distributions.length} recipients`);
    const txResults = await distributePrizesOnchain(match, distributions, arenaId);

    // Broadcast to all clients with tx hashes
    broadcastAll({
        type: 'prize:distributed',
        matchId,
        arenaId,
        totalPool: match.prizePool,
        platformFee: (match.prizePool * PLATFORM_FEE_PERCENT / 100),
        distributions: txResults,
        timestamp: Date.now(),
    });
    console.log(`[OnChain] 📡 Prize distribution broadcast: ${txResults.length} entries`);
});

gameEngine.on('agentDied', (data) => {
    broadcastAll({ type: 'agent:died', ...data });
});

gameEngine.on('agentReasoning', (data) => {
    // Broadcast AI reasoning to all clients for spectate display
    broadcastAll({ type: 'agent:reasoning', ...data });
});

gameEngine.on('rpsRound', (data) => {
    // Broadcast RPS round result to arena subscribers
    for (const [arenaId, arena] of arenaManager.arenas) {
        if (arena.matchId === data.matchId) {
            broadcastToArena(arenaId, { type: 'rps:round', ...data });
            break;
        }
    }
});

gameEngine.on('allianceFormed', (data) => {
    broadcastAll({ type: 'alliance:formed', ...data });
});

gameEngine.on('betrayal', (data) => {
    broadcastAll({ type: 'alliance:betrayal', ...data });
    // Auto-update leaderboard betrayal count + ELO penalty
    const e = initLeaderboardEntry(data.betrayer);
    e.betrayals++;
    e.elo = Math.max(100, e.elo - 15); // -15 ELO penalty for betrayal
    console.log(`[Leaderboard] Betrayal ELO penalty: ${data.betrayer} → ELO now ${e.elo}`);
});

// Auto-record match results on matchEnded
gameEngine.on('matchEnded', (data) => {
  try {
    const match = gameEngine.getMatch(data.matchId);
    if (!match) return;

    const winnerId = data.winner?.id || null;
    const loserIds = match.agents.filter(a => a.id !== winnerId).map(a => a.id);

    if (winnerId) {
        const w = initLeaderboardEntry(winnerId);
        w.wins++;
        w.streak++;
        w.maxStreak = Math.max(w.maxStreak, w.streak);
        w.earnings += match.prizePool || 0;
        w.lastMatch = Date.now();
        const avgLoserElo = loserIds.length > 0
            ? loserIds.reduce((s, id) => s + (leaderboard[id]?.elo || 1000), 0) / loserIds.length
            : 1000;
        const expected = 1 / (1 + Math.pow(10, (avgLoserElo - w.elo) / 400));
        w.elo = Math.round(w.elo + 32 * (1 - expected));
        if (agents[winnerId]) agents[winnerId].stats.wins++;
    }

    for (const loserId of loserIds) {
        const l = initLeaderboardEntry(loserId);
        l.losses++;
        l.streak = 0;
        l.lastMatch = Date.now();
        const winnerElo = winnerId ? (leaderboard[winnerId]?.elo || 1000) : 1000;
        const expected = 1 / (1 + Math.pow(10, (winnerElo - l.elo) / 400));
        l.elo = Math.max(100, Math.round(l.elo + 32 * (0 - expected)));
        if (agents[loserId]) agents[loserId].stats.losses++;
    }

    // ── On-chain Leaderboard.recordMatch() ──
    // Persist results to Leaderboard.sol so data survives server restarts
    if (leaderboardContract && winnerId) {
        const winnerAgent = agents[winnerId];
        const winnerOnchainId = winnerAgent?.onchainId;
        const w = leaderboard[winnerId];
        for (const loserId of loserIds) {
            const loserAgent = agents[loserId];
            const loserOnchainId = loserAgent?.onchainId;
            const l = leaderboard[loserId];
            if (winnerOnchainId && loserOnchainId) {
                leaderboardContract.recordMatch(
                    winnerOnchainId,
                    loserOnchainId,
                    data.matchId.replace(/\D/g, '').slice(0, 10) || '0', // numeric matchId
                    w.elo,
                    l.elo,
                    ethers.parseEther(String(match.prizePool || 0))
                ).then(tx => tx.wait()).then(() => {
                    console.log(`[Leaderboard] ✅ On-chain recordMatch: winner=${winnerOnchainId} loser=${loserOnchainId}`);
                }).catch(err => {
                    console.warn(`[Leaderboard] ⚠️ On-chain recordMatch failed:`, err.message);
                });
            }
        }
    }

    // Persist updated agent stats to disk
    saveAgents();
  } catch (err) {
    console.error('[matchEnded] Error processing match result:', err.message);
  }
});

// ─── Autonomous Agent Loop ───────────────────────────────────────────────────
const autonomousLoop = new AgentAutonomousLoop(arenaManager, agents, leaderboard, {
    SCAN_INTERVAL_MS: parseInt(process.env.AUTONOMOUS_SCAN_INTERVAL || '10000'),
    MATCH_COOLDOWN_MS: parseInt(process.env.AUTONOMOUS_COOLDOWN || '30000'),
    checkProfitWithdraw, // injected for auto-withdraw after matches
});

// Wire autonomous loop events to WebSocket
autonomousLoop.on('agentAutoJoined', (data) => {
    broadcastAll({ type: 'autonomous:joined', ...data });
});

// API: start/stop/status autonomous loop
app.post('/api/autonomous/start', (req, res) => {
    autonomousLoop.start();
    res.json({ ok: true, status: 'running' });
});

app.post('/api/autonomous/stop', (req, res) => {
    autonomousLoop.stop();
    res.json({ ok: true, status: 'stopped' });
});

app.get('/api/autonomous/status', (req, res) => {
    res.json({ ok: true, ...autonomousLoop.getStats() });
});

// ─── Demo Battle (No Wallet Required) ────────────────────────────────────────

app.post('/api/demo/quick-battle', (req, res) => {
    try {
        // Pick 2 different random strategies from templates
        const shuffled = [...strategies].sort(() => Math.random() - 0.5);
        const picks = shuffled.slice(0, 2);

        const createdAgents = picks.map((template, idx) => {
            const agentId = `demo_${Date.now()}_${idx}_${Math.random().toString(36).substr(2, 6)}`;

            // Parse strategy code into executable function
            let strategyCode = {};
            try {
                const fn = new Function('return ' + template.code)();
                strategyCode = { decide: fn };
            } catch (e) {
                console.error(`[Demo] Strategy parse error for ${template.name}:`, e.message);
            }

            agents[agentId] = {
                id: agentId,
                name: template.name,
                traits: template.traits || [],
                strategy: template.code,
                strategyCode,
                strategyParams: { ...template.strategyParams },
                ownerAddress: 'demo_user',
                agentWalletAddress: null,
                agentPrivateKey: null,
                createdAt: Date.now(),
                status: 'fighting',
                onchainId: null,
                stats: { wins: 0, losses: 0, earnings: 0, betrayals: 0, bribes: 0 },
                financial: { initialDeposit: 0, totalDeposited: 0, totalWithdrawn: 0 },
                buffs: { health: 0, armor: 0, attack: 0, speed: 0, expiresAt: 0, matchesLeft: 0 },
            };

            transferHistory[agentId] = [];
            initLeaderboardEntry(agentId);

            return {
                id: agentId,
                name: template.name,
                traits: template.traits,
                description: template.description,
                strategyParams: template.strategyParams,
            };
        });

        // Create a dedicated demo arena (2 players, instant start)
        const demoArena = arenaManager.createArena({
            tier: 'bronze',
            name: '🎮 Demo Arena',
            entryFee: 0,
            maxAgents: 2,
            minAgents: 2,
        });

        const demoArenaId = demoArena.arenaId;

        // Wire up broadcastAll for this demo arena's events so frontend receives them
        // without needing explicit arena subscription
        const onTurn = (data) => {
            // Find which arenaId this turn belongs to
            for (const [aId, arena] of arenaManager.arenas) {
                if (arena.matchId === data.matchId && aId === demoArenaId) {
                    // Include agent HP states for frontend HP bar updates
                    const match = gameEngine.getMatch(data.matchId);
                    const agentStates = match ? match.agents.map(a => ({
                        id: a.id,
                        name: a.name,
                        hp: a.hp,
                        alive: a.alive,
                    })) : [];
                    broadcastAll({ type: 'match:turn', arenaId: demoArenaId, ...data, agentStates });
                    break;
                }
            }
        };
        const onLaunching = (data) => {
            if (data.arenaId === demoArenaId) {
                broadcastAll({ type: 'match:launching', arenaId: demoArenaId, ...data });
            }
        };
        const onCompleted = (data) => {
            if (data.arenaId === demoArenaId) {
                broadcastAll({ type: 'match:completed', arenaId: demoArenaId, ...data });
                // Cleanup listeners
                arenaManager.removeListener('turnCompleted', onTurn);
                arenaManager.removeListener('matchLaunching', onLaunching);
                arenaManager.removeListener('matchCompleted', onCompleted);
            }
        };
        arenaManager.on('turnCompleted', onTurn);
        arenaManager.on('matchLaunching', onLaunching);
        arenaManager.on('matchCompleted', onCompleted);

        // Directly join both agents — joining the 2nd triggers auto-start
        createdAgents.forEach(a => {
            const ag = agents[a.id];
            arenaManager.joinArena(demoArenaId, {
                id: ag.id,
                name: ag.name,
                owner: ag.ownerAddress,
                strategyCode: ag.strategyCode,
                strategyParams: ag.strategyParams || {},
                strategyDescription: ag.strategyDescription || '',
                traits: ag.traits || [],
                buffs: ag.buffs || { health: 0, armor: 0, attack: 0, speed: 0 },
            });
        });

        console.log(`[Demo] Quick battle started: ${createdAgents.map(a => a.name).join(' vs ')} in ${demoArenaId}`);

        res.json({
            ok: true,
            agents: createdAgents,
            arenaId: demoArenaId,
            message: `${createdAgents[0].name} vs ${createdAgents[1].name} — Demo battle started!`,
        });
    } catch (error) {
        console.error('[Demo] Quick battle error:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── Agent Activate / Deactivate / Status ────────────────────────────────────

// POST /api/agent/:id/activate - Start autonomous loop for this agent
app.post('/api/agent/:id/activate', (req, res) => {
    const agent = agents[req.params.id];
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    agent.status = 'searching';

    // Ensure autonomous loop is running
    if (!autonomousLoop.running) {
        autonomousLoop.start();
    }

    // Broadcast status change
    broadcastAll({ type: 'agent:statusChanged', agentId: agent.id, status: 'searching' });

    res.json({ ok: true, status: 'searching', message: `${agent.name} activated. Searching for arena...` });
});

// POST /api/agent/:id/deactivate - Stop autonomous loop for this agent
app.post('/api/agent/:id/deactivate', (req, res) => {
    const agent = agents[req.params.id];
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    agent.status = 'idle';

    // Remove from autonomous loop state
    const state = autonomousLoop.agentStates.get(agent.id);
    if (state) {
        state.inMatch = false;
    }

    broadcastAll({ type: 'agent:statusChanged', agentId: agent.id, status: 'idle' });

    res.json({ ok: true, status: 'idle', message: `${agent.name} deactivated.` });
});

// GET /api/agent/:id/status - Get agent's current status
app.get('/api/agent/:id/status', (req, res) => {
    const agent = agents[req.params.id];
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const lb = leaderboard[agent.id] || {};
    res.json({
        ok: true,
        agentId: agent.id,
        name: agent.name,
        status: agent.status || 'idle',
        agentWalletAddress: agent.agentWalletAddress || null,
        stats: agent.stats,
        buffs: agent.buffs || {},
        elo: lb.elo || 1000,
        earnings: lb.earnings || 0,
    });
});

// ─── Buff / Burn Endpoints ───────────────────────────────────────────────────

// POST /api/agent/:id/buff - Apply a buff by burning MON
app.post('/api/agent/:id/buff', async (req, res) => {
    try {
        const agent = agents[req.params.id];
        if (!agent) return res.status(404).json({ error: 'Agent not found' });

        const { buffType, amount } = req.body;
        // buffType: 'health' | 'armor' | 'attack' | 'speed'
        // amount: MON amount as number (e.g. 0.5)

        if (!['health', 'armor', 'attack', 'speed'].includes(buffType)) {
            return res.status(400).json({ error: 'Invalid buffType. Use: health, armor, attack, speed' });
        }
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'amount must be > 0' });
        }

        const buffTypeMap = { health: 0, armor: 1, attack: 2, speed: 3 };

        // Calculate magnitude: 0.1 MON → 10 pts, 1 MON → 100 pts, 5 MON → 500 (cap)
        const rawMagnitude = Math.round(amount * 100); // 0.1→10, 1→100, 5→500
        const magnitude = Math.min(rawMagnitude, 500);

        // Apply buff in-memory
        if (!agent.buffs) {
            agent.buffs = { health: 0, armor: 0, attack: 0, speed: 0, expiresAt: 0, matchesLeft: 0 };
        }
        agent.buffs[buffType] += magnitude;
        agent.buffs.matchesLeft = 3;
        agent.buffs.expiresAt = Date.now() + 3600_000; // 1 hour

        // On-chain buff (if available)
        let txHash = null;
        if (buffOracleContract && platformSigner && agent.agentWalletAddress) {
            try {
                const tx = await buffOracleContract.applyBuff(
                    agent.agentWalletAddress,
                    buffTypeMap[buffType],
                    { value: ethers.parseEther(String(amount)) }
                );
                console.log(`[Chain] ⏳ Buff TX submitted: ${tx.hash} — waiting for confirmation...`);
                const receipt = await tx.wait();
                txHash = tx.hash;
                console.log(`[Chain] ✅ Buff confirmed: ${tx.hash} (block: ${receipt.blockNumber}, gas: ${receipt.gasUsed.toString()})`);
            } catch (chainErr) {
                console.error('[Chain] Buff tx failed:', chainErr.message);
            }
        }

        broadcastAll({ type: 'agent:buffed', agentId: agent.id, buffType, magnitude, amount });

        res.json({
            ok: true,
            buffType,
            magnitude,
            totalBuffs: agent.buffs,
            txHash,
            message: `${agent.name} +${magnitude} ${buffType} buff received! (${amount} MON burned)`,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/agent/:id/confirm-onchain - Confirm onchain registration tx
app.post('/api/agent/:id/confirm-onchain', (req, res) => {
    const agent = agents[req.params.id];
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const { txHash, onchainId } = req.body;
    if (txHash) agent.onchainTxHash = txHash;
    if (onchainId) agent.onchainId = onchainId;
    agent.onchainRegistered = true;

    // Persist updated onchainId mapping
    saveAgentKeys();
    saveAgents();

    console.log(`[Chain] Agent ${agent.id} onchain confirmed: ${txHash}`);
    res.json({ ok: true, message: 'Onchain registration confirmed' });
});

// GET /api/agent/:id/balance - Get real-time wallet balance
app.get('/api/agent/:id/balance', async (req, res) => {
    try {
        const agent = agents[req.params.id];
        if (!agent) return res.status(404).json({ error: 'Agent not found' });
        if (!agent.agentWalletAddress) {
            console.log('[Balance] ❌ No wallet address for', req.params.id);
            return res.status(400).json({ ok: false, error: 'Agent has no wallet address', balanceMON: 0 });
        }
        if (!provider) {
            console.error('[Balance] ❌ Provider not initialized! MONAD_RPC:', MONAD_RPC);
            return res.status(503).json({ ok: false, error: 'Blockchain provider not ready', balanceMON: 0 });
        }
        const bal = await provider.getBalance(agent.agentWalletAddress);
        const balMON = parseFloat(ethers.formatEther(bal));
        console.log(`[Balance] ${agent.name} (${agent.agentWalletAddress}): ${balMON} MON (${bal} wei)`);
        res.json({ ok: true, balance: bal.toString(), balanceMON: Math.round(balMON * 10000) / 10000 });
    } catch (err) {
        console.error('[Balance] Error for', req.params.id, ':', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/agent/:id/transfers - Get transfer history
app.get('/api/agent/:id/transfers', (req, res) => {
    const agent = agents[req.params.id];
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const history = transferHistory[agent.id] || [];
    const financial = agent.financial || { initialDeposit: 0, totalDeposited: 0, totalWithdrawn: 0 };
    res.json({ ok: true, transfers: history, financial });
});

// POST /api/agent/:id/record-deposit - Record a deposit (called after frontend tx)
app.post('/api/agent/:id/record-deposit', (req, res) => {
    const agent = agents[req.params.id];
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const { amount, txHash } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    if (!agent.financial) agent.financial = { initialDeposit: 0, totalDeposited: 0, totalWithdrawn: 0 };
    if (!transferHistory[agent.id]) transferHistory[agent.id] = [];

    agent.financial.totalDeposited += amount;
    if (agent.financial.initialDeposit === 0) agent.financial.initialDeposit = amount;

    transferHistory[agent.id].push({
        type: 'deposit',
        amount,
        txHash: txHash || null,
        from: agent.ownerAddress,
        to: agent.agentWalletAddress,
        timestamp: Date.now(),
    });

    broadcastAll({ type: 'agent:deposit', agentId: agent.id, amount });
    saveAgents();
    res.json({ ok: true, financial: agent.financial });
});

// POST /api/agent/:id/settings - Update agent's profit/withdraw settings
app.post('/api/agent/:id/settings', (req, res) => {
    const agent = agents[req.params.id];
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const { profitTarget, withdrawThreshold } = req.body;
    if (!agent.strategyParams) agent.strategyParams = {};

    if (profitTarget !== undefined) {
        agent.strategyParams.profitTarget = Math.max(0, parseFloat(profitTarget) || 0);
    }
    if (withdrawThreshold !== undefined) {
        agent.strategyParams.withdrawThreshold = Math.max(0, parseFloat(withdrawThreshold) || 0);
    }

    console.log(`[Settings] ${agent.name}: profitTarget=${agent.strategyParams.profitTarget}, withdrawThreshold=${agent.strategyParams.withdrawThreshold}`);

    saveAgents();

    res.json({
        ok: true,
        profitTarget: agent.strategyParams.profitTarget,
        withdrawThreshold: agent.strategyParams.withdrawThreshold,
        message: 'Settings updated',
    });
});

// POST /api/agent/:id/withdraw - Manual withdraw MON to owner wallet
app.post('/api/agent/:id/withdraw', async (req, res) => {
    try {
        const agent = agents[req.params.id];
        if (!agent) return res.status(404).json({ error: 'Agent not found' });
        if (!agent.agentPrivateKey || !agent.agentWalletAddress || !provider) {
            return res.status(400).json({ error: 'Agent wallet not available or provider not ready' });
        }
        if (!agent.ownerAddress) {
            return res.status(400).json({ error: 'Owner address not set' });
        }

        const { amount, withdrawAll } = req.body;
        const bal = await provider.getBalance(agent.agentWalletAddress);
        const balMON = parseFloat(ethers.formatEther(bal));
        const gasReserve = 0.01; // keep some for gas

        let withdrawMON;
        if (withdrawAll) {
            withdrawMON = Math.max(0, balMON - gasReserve);
        } else {
            withdrawMON = parseFloat(amount) || 0;
        }

        if (withdrawMON <= 0) {
            return res.status(400).json({ error: 'Insufficient balance (0.01 MON needed for gas)' });
        }
        if (withdrawMON > balMON - gasReserve) {
            return res.status(400).json({ error: `Max withdrawal: ${(balMON - gasReserve).toFixed(4)} MON (gas: ${gasReserve})` });
        }

        const isActive = agent.status === 'searching' || agent.status === 'fighting';

        const agentSigner = new ethers.Wallet(agent.agentPrivateKey, provider);
        console.log(`[Withdraw] Sending tx: ${withdrawMON.toFixed(6)} MON from ${agent.agentWalletAddress} → ${agent.ownerAddress}`);
        const tx = await agentSigner.sendTransaction({
            to: agent.ownerAddress,
            value: ethers.parseEther(String(withdrawMON.toFixed(6))),
        });
        console.log(`[Withdraw] ⏳ TX submitted: ${tx.hash} — waiting for confirmation...`);
        const receipt = await tx.wait();
        console.log(`[Withdraw] ✅ TX confirmed: ${tx.hash} (block: ${receipt.blockNumber}, gas: ${receipt.gasUsed.toString()})`);

        if (!agent.financial) agent.financial = { initialDeposit: 0, totalDeposited: 0, totalWithdrawn: 0 };
        agent.financial.totalWithdrawn += withdrawMON;

        if (!transferHistory[agent.id]) transferHistory[agent.id] = [];
        transferHistory[agent.id].push({
            type: 'manual_withdraw',
            amount: withdrawMON,
            txHash: tx.hash,
            from: agent.agentWalletAddress,
            to: agent.ownerAddress,
            timestamp: Date.now(),
        });

        broadcastAll({
            type: 'agent:withdraw',
            agentId: agent.id,
            amount: withdrawMON,
            txHash: tx.hash,
            ownerAddress: agent.ownerAddress,
        });

        res.json({
            ok: true,
            amount: withdrawMON,
            txHash: tx.hash,
            wasActive: isActive,
            message: `${withdrawMON.toFixed(4)} MON withdrawn`,
        });
    } catch (err) {
        console.error('[Withdraw] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/agent/:id/buffs - Get agent's active buffs
app.get('/api/agent/:id/buffs', (req, res) => {
    const agent = agents[req.params.id];
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const buffs = agent.buffs || { health: 0, armor: 0, attack: 0, speed: 0, expiresAt: 0, matchesLeft: 0 };

    // Check expiry
    const now = Date.now();
    const expired = buffs.expiresAt > 0 && now > buffs.expiresAt;
    const matchesExpired = buffs.matchesLeft <= 0 && buffs.expiresAt > 0;

    if (expired || matchesExpired) {
        agent.buffs = { health: 0, armor: 0, attack: 0, speed: 0, expiresAt: 0, matchesLeft: 0 };
    }

    res.json({ ok: true, buffs: agent.buffs });
});

// ─── Profit Target Auto-Withdraw Helper ──────────────────────────────────────
async function checkProfitWithdraw(agentId) {
    const agent = agents[agentId];
    if (!agent || !agent.agentPrivateKey || !agent.agentWalletAddress || !provider) {
        console.log(`[AutoWithdraw] Skipped ${agentId}: missing wallet/provider`);
        return;
    }

    const params = agent.strategyParams || {};
    const profitTarget = parseFloat(params.profitTarget) || 0;
    const withdrawThreshold = parseFloat(params.withdrawThreshold) || 0;
    if (profitTarget <= 0 || withdrawThreshold <= 0) {
        console.log(`[AutoWithdraw] ${agent.name}: no profitTarget(${profitTarget}) or withdrawThreshold(${withdrawThreshold})`);
        return;
    }
    if (!agent.ownerAddress) return;
    if (!agent.financial) agent.financial = { initialDeposit: 0, totalDeposited: 0, totalWithdrawn: 0 };
    if (!transferHistory[agentId]) transferHistory[agentId] = [];

    try {
        const bal = await provider.getBalance(agent.agentWalletAddress);
        const balMON = parseFloat(ethers.formatEther(bal));
        const initialDeposit = agent.financial.initialDeposit || 0;
        const profit = balMON - initialDeposit;

        console.log(`[AutoWithdraw] ${agent.name}: balance=${balMON} MON, initial=${initialDeposit}, profit=${profit.toFixed(4)}, target=${profitTarget}`);

        if (profit >= profitTarget) {
            const gasReserve = 0.01;
            const withdrawMON = Math.min(withdrawThreshold, balMON - gasReserve);
            if (withdrawMON <= 0) {
                console.log(`[AutoWithdraw] ${agent.name}: insufficient balance for withdrawal after gas reserve`);
                return;
            }

            const agentSigner = new ethers.Wallet(agent.agentPrivateKey, provider);
            console.log(`[AutoWithdraw] Sending tx: ${withdrawMON.toFixed(6)} MON from ${agent.agentWalletAddress} → ${agent.ownerAddress}`);
            const tx = await agentSigner.sendTransaction({
                to: agent.ownerAddress,
                value: ethers.parseEther(withdrawMON.toFixed(6)),
            });
            console.log(`[AutoWithdraw] ⏳ TX submitted: ${tx.hash} — waiting for confirmation...`);
            const receipt = await tx.wait();
            console.log(`[AutoWithdraw] ✅ ${agent.name}: ${withdrawMON.toFixed(4)} MON → ${agent.ownerAddress} (tx: ${tx.hash}, block: ${receipt.blockNumber})`);

            agent.financial.totalWithdrawn += withdrawMON;
            transferHistory[agentId].push({
                type: 'auto_withdraw',
                amount: withdrawMON,
                txHash: tx.hash,
                from: agent.agentWalletAddress,
                to: agent.ownerAddress,
                timestamp: Date.now(),
            });

            broadcastAll({
                type: 'agent:autoWithdraw',
                agentId,
                agentName: agent.name,
                amount: withdrawMON,
                txHash: tx.hash,
                ownerAddress: agent.ownerAddress,
            });
        }
    } catch (err) {
        console.error(`[AutoWithdraw] ${agent.name} error:`, err.message);
    }
}

// Expose checkProfitWithdraw for AgentAutonomousLoop
module.exports.checkProfitWithdraw = checkProfitWithdraw;

// Auto-start the loop if configured
if (process.env.AUTONOMOUS_AUTOSTART === 'true') {
    try {
        autonomousLoop.start();
    } catch (err) {
        console.error('[AutonomousLoop] Failed to auto-start:', err.message);
    }
}

// ─── Start ───────────────────────────────────────────────────────────────────
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.warn(`[Server] ⚠️ Port ${PORT} already in use, attempting to free...`);
        try {
            require('child_process').execSync(`npx kill-port ${PORT}`, { stdio: 'ignore' });
            console.log(`[Server] ✅ Port ${PORT} freed, restarting in 1s...`);
            setTimeout(() => server.listen(PORT), 1000);
        } catch (killErr) {
            console.error(`[Server] ❌ Failed to free port ${PORT}:`, killErr.message);
            process.exit(1);
        }
    } else {
        console.error('[Server] ❌ Server error:', err);
        process.exit(1);
    }
});

server.listen(PORT, async () => {
    console.log(`
  ⚔️  Monad Colosseum - Unified Server
  ─────────────────────────────────────
  HTTP API  : http://localhost:${PORT}/api
  WebSocket : ws://localhost:${PORT}/ws
  Claude    : http://localhost:${PORT}/api/claude
  Health    : http://localhost:${PORT}/api/health
  `);

    // ── Startup blockchain health check ──────────────────────────
    console.log('[Startup] ── Blockchain Health Check ──');
    console.log('[Startup] RPC URL:', MONAD_RPC);
    console.log('[Startup] Platform signer:', platformSigner ? `✅ ${platformSigner.address}` : '❌ NOT AVAILABLE');
    console.log('[Startup] AgentRegistry:', registryContract ? `✅ ${process.env.AGENT_REGISTRY_ADDRESS}` : '❌ NOT AVAILABLE');
    console.log('[Startup] BuffOracle:', buffOracleContract ? `✅ ${process.env.BUFF_ORACLE_ADDRESS}` : '❌ NOT AVAILABLE');
    console.log('[Startup] Leaderboard:', leaderboardContract ? `✅ ${process.env.LEADERBOARD_ADDRESS}` : '❌ NOT AVAILABLE');

    if (provider) {
        try {
            const network = await provider.getNetwork();
            const blockNum = await provider.getBlockNumber();
            console.log(`[Startup] ✅ Provider connected: chainId=${network.chainId}, block=#${blockNum}`);

            if (platformSigner) {
                const signerBal = await provider.getBalance(platformSigner.address);
                console.log(`[Startup] ✅ Platform signer balance: ${ethers.formatEther(signerBal)} MON`);
            }
        } catch (err) {
            console.error(`[Startup] ❌ Provider health check FAILED:`, err.message);
        }
    } else {
        console.error('[Startup] ❌ No provider — all blockchain operations will fail!');
    }
    console.log('[Startup] ── End Health Check ──');

    // ── Recover agents from on-chain + local keys ────────────────
    try {
        await loadAgentsFromChain();
        console.log(`[Startup] ✅ Total agents in memory: ${Object.keys(agents).length}`);
        // Persist all agents (including on-chain recovered ones) to disk
        saveAgents();
    } catch (err) {
        console.error('[Startup] ❌ Agent recovery failed:', err.message);
    }

    // ── Fix strategyCode for agents missing decide function ────
    const strategies = require('./templates/strategies');
    let assignedStrategyCount = 0;
    for (const agent of Object.values(agents)) {
        if (!agent.strategyCode?.decide) {
            // First try to rebuild from agent.strategy raw string
            if (agent.strategy && typeof agent.strategy === 'string') {
                try {
                    const fn = new Function('return ' + agent.strategy)();
                    if (typeof fn === 'function') {
                        agent.strategyCode = { decide: fn };
                        assignedStrategyCount++;
                        console.log(`[Startup] 🔧 Rebuilt strategyCode from raw string for ${agent.name} (${agent.id})`);
                        continue;
                    }
                } catch (e) {
                    console.warn(`[Startup] ⚠️ Raw strategy eval failed for ${agent.name}: ${e.message}`);
                }
            }
            // Fallback: pick a random strategy template
            const template = strategies[Math.floor(Math.random() * strategies.length)];
            try {
                const fn = new Function('return ' + template.code)();
                agent.strategyCode = { decide: fn };
                agent.strategy = template.code;
                agent.strategyDescription = agent.strategyDescription || template.description;
                if (!agent.traits || agent.traits.length === 0) {
                    agent.traits = template.traits || [];
                }
                if (!agent.strategyParams || agent.strategyParams.aggressiveness === 50) {
                    agent.strategyParams = { ...agent.strategyParams, ...template.strategyParams };
                }
                assignedStrategyCount++;
                console.log(`[Startup] 🎲 Assigned strategy "${template.name}" to ${agent.name} (${agent.id})`);
            } catch (e) {
                console.error(`[Startup] ❌ Failed to assign strategy to ${agent.name}:`, e.message);
            }
        }
    }
    if (assignedStrategyCount > 0) {
        console.log(`[Startup] ✅ Fixed strategyCode for ${assignedStrategyCount} agents`);
        saveAgents();
    }

    // ── Clean up stale agent states ─────────────────────────────
    let staleFixed = 0;
    for (const agent of Object.values(agents)) {
        const staleStatuses = ['fighting', 'won', 'lost'];
        if (staleStatuses.includes(agent.status)) {
            const wasInArena = arenaManager.isAgentInArena(agent.id);
            if (!wasInArena) {
                console.log(`[Startup] 🧹 Stale state: ${agent.name} (${agent.id}) was '${agent.status}' → searching`);
                agent.status = 'searching';
                staleFixed++;
            }
        }
    }
    if (staleFixed > 0) {
        console.log(`[Startup] ✅ Fixed ${staleFixed} agents with stale status → searching`);
    }

    // ── Activate all loaded agents (set to searching) ────────────
    let activatedCount = 0;
    for (const agent of Object.values(agents)) {
        if (agent.strategyCode?.decide && (agent.status === 'idle' || !agent.status)) {
            agent.status = 'searching';
            activatedCount++;
        }
    }
    if (activatedCount > 0) {
        console.log(`[Startup] ✅ Activated ${activatedCount} agents → status: searching`);
    }

    // ── Auto-start autonomous loop ─────────────────────────────
    try {
        autonomousLoop.start();
        console.log('[Startup] ✅ Autonomous loop started');
    } catch (err) {
        console.error('[Startup] ❌ Autonomous loop start failed:', err.message);
    }
});

module.exports = { app, server, wss, gameEngine, arenaManager };