/**
 * Spectate.jsx - Live Combat Stream Integration
 * 
 * Real-time arena viewer with:
 * - Live combat log from BattleNarrator
 * - Buff application effects from BuffOracle
 * - Agent stats display
 * - Viewer buff panel for engagement
 * 
 * @author Monad Colosseum Team
 */

import React, { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import { Arena3DViewer } from './components/Arena3DViewer';

// ═══════════════════════════════════════════════════════════════════════════════
// CONTRACT ADDRESSES (Monad Mainnet)
// ═══════════════════════════════════════════════════════════════════════════════

const ARENA_ADDRESS = import.meta.env.VITE_ARENA_ADDRESS || '0x0000000000000000000000000000000000000001';
const NARRATOR_ADDRESS = import.meta.env.VITE_NARRATOR_ADDRESS || '0x0000000000000000000000000000000000000002';
const BUFF_ORACLE_ADDRESS = import.meta.env.VITE_BUFF_ORACLE_ADDRESS || '0x0000000000000000000000000000000000000003';
const ESCROW_ADDRESS = import.meta.env.VITE_ESCROW_ADDRESS || '0x0000000000000000000000000000000000000004';
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001/ws';
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

// ═══════════════════════════════════════════════════════════════════════════════
// ABIs (Minimal)
// ═══════════════════════════════════════════════════════════════════════════════

const ArenaABI = [
    "function getCurrentRound() view returns (uint256)",
    "function getRound(uint256 roundId) view returns (tuple(uint256 id, address[] participants, uint256 startTime, uint256 endTime, uint256 prizePool, address winner, uint8 status))",
    "event DamageDealt(uint256 indexed roundId, address indexed attacker, address indexed target, uint256 damage, uint256 remainingHealth)",
    "event AgentEliminated(address indexed agent, address indexed killer, uint256 indexed roundId)"
];

const NarratorABI = [
    "function getTimeline(uint256 limit) view returns (tuple(uint8 eventType, address primaryActor, address secondaryActor, uint256 value, uint256 timestamp, uint256 roundId, bytes32 metadata)[])",
    "event NarrativeRecorded(uint256 indexed eventIndex, uint8 indexed eventType, address indexed primaryActor, address secondaryActor, uint256 value, uint256 roundId)"
];

const BuffOracleABI = [
    "function applyBuff(address agent, address viewer, uint96 tokenAmount, uint8 buffType, uint256 roundId) payable",
    "event BuffApplied(address indexed agent, address indexed viewer, uint96 tokensBurned, uint8 buffType, uint16 magnitude, uint256 indexed roundId)"
];

// ═══════════════════════════════════════════════════════════════════════════════
// EVENT TYPE MAPPING
// ═══════════════════════════════════════════════════════════════════════════════

const EVENT_TYPES = {
    0: 'BATTLE_START',
    1: 'ATTACK',
    2: 'DEFEND',
    3: 'BRIBE_OFFERED',
    4: 'BRIBE_ACCEPTED',
    5: 'BETRAYAL',
    6: 'OUTLAW_DECLARED',
    7: 'BOUNTY_CLAIMED',
    8: 'AGENT_DEATH',
    9: 'CHAMPION_CROWNED',
    10: 'BUFF_RECEIVED',
    11: 'DRAMATIC_MOMENT',
    12: 'RPS_ROUND',
    13: 'RPS_MATCH_END',
    14: 'AI_REASONING'
};

const EVENT_ICONS = {
    'BATTLE_START': '⚔️',
    'ATTACK': '💥',
    'DEFEND': '🛡️',
    'BRIBE_OFFERED': '💰',
    'BRIBE_ACCEPTED': '🤝',
    'BETRAYAL': '🗡️',
    'OUTLAW_DECLARED': '🤠',
    'BOUNTY_CLAIMED': '💀',
    'AGENT_DEATH': '☠️',
    'CHAMPION_CROWNED': '👑',
    'BUFF_RECEIVED': '✨',
    'DRAMATIC_MOMENT': '🎭',
    'RPS_ROUND': '✊',
    'RPS_MATCH_END': '🏆',
    'AI_REASONING': '🧠'
};

const RPS_MOVE_ICONS = {
    rock: '🪨',
    paper: '📄',
    scissors: '✂️',
};

const BUFF_TYPES = {
    0: 'HEALTH',
    1: 'ARMOR',
    2: 'ATTACK',
    3: 'SPEED'
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function Spectate() {
    const [wsConnected, setWsConnected] = useState(false);
    const [liveArenas, setLiveArenas] = useState([]);
    const [selectedArena, setSelectedArena] = useState(null);
    const [currentRound, setCurrentRound] = useState({
        id: 0,
        participants: [],
        startTime: Date.now(),
        endTime: 0,
        status: 'WAITING',
        prizePool: '0',
        winner: ''
    });
    const [agents, setAgents] = useState([]);
    const [combatLog, setCombatLog] = useState([]);
    const [activeBuffs, setActiveBuffs] = useState({});
    const [view3D, setView3D] = useState(false);

    // Fetch live arenas from API (real data, no mock)
    useEffect(() => {
        const fetchLiveArenas = () => {
            fetch(`${BACKEND_URL}/api/arenas`)
                .then(res => res.json())
                .then(data => {
                    if (data.ok) {
                        setLiveArenas(data.arenas);
                        // Auto-select first in_progress arena if none selected
                        if (!selectedArena) {
                            const live = data.arenas.find(a => a.status === 'in_progress');
                            if (live) setSelectedArena(live.arenaId);
                        }
                    }
                })
                .catch(() => { });
        };
        fetchLiveArenas();
        const interval = setInterval(fetchLiveArenas, 4000);
        return () => clearInterval(interval);
    }, [selectedArena]);

    // Always connect WebSocket — real data only
    useEffect(() => {

        let ws;
        let reconnectTimer;

        const connect = () => {
            ws = new WebSocket(WS_URL);

            ws.onopen = () => {
                console.log('[WS] Connected to battle server');
                setWsConnected(true);
                // Subscribe to all arena events (wildcard)
                ws.send(JSON.stringify({ type: 'subscribe', arenaId: '*' }));
            };

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    handleLiveEvent(msg);
                } catch (e) {
                    console.error('[WS] Parse error:', e);
                }
            };

            ws.onclose = () => {
                console.log('[WS] Disconnected, reconnecting in 3s...');
                setWsConnected(false);
                reconnectTimer = setTimeout(connect, 3000);
            };

            ws.onerror = (err) => {
                console.error('[WS] Error:', err);
            };
        };

        const handleLiveEvent = (msg) => {
            switch (msg.type) {
                case 'match:turn': {
                    // Update agent states from live data
                    if (msg.agents && Array.isArray(msg.agents)) {
                        setAgents(msg.agents.map(a => ({
                            address: a.id,
                            id: a.id,
                            name: a.name || a.id,
                            health: a.hp ?? 100,
                            maxHealth: a.maxHp || 100,
                            armor: 50,
                            attack: 50,
                            speed: 50,
                            charisma: 50,
                            reputation: 50,
                            isOutlaw: false,
                            isAlive: a.alive !== false,
                            lastAction: a.lastAction || null,
                        })));
                        setCurrentRound(prev => ({
                            ...prev,
                            id: msg.turn || prev.id,
                            status: 'IN_PROGRESS',
                        }));
                    }
                    // Map turn events to combat log entries
                    if (msg.events) {
                        const newEntries = msg.events
                            .filter(e => e.type !== 'recovery')
                            .map(e => ({
                                type: mapEventType(e.type),
                                primaryActor: e.attackerId || e.agentId || e.betrayer || '',
                                secondaryActor: e.defenderId || e.victim || '',
                                value: String(e.damage || 0),
                                description: formatLiveEvent(e),
                                timestamp: Date.now(),
                                roundId: msg.turn,
                            }));
                        setCombatLog(prev => [...newEntries, ...prev].slice(0, 30));
                    }
                    break;
                }
                case 'agent:died': {
                    setCombatLog(prev => [{
                        type: 'AGENT_DEATH',
                        primaryActor: msg.agentId,
                        secondaryActor: '',
                        value: '0',
                        description: `☠️ ${msg.agentId} has been eliminated! (Turn ${msg.turn})`,
                        timestamp: Date.now(),
                        roundId: msg.turn,
                    }, ...prev].slice(0, 30));
                    break;
                }
                case 'alliance:formed': {
                    const a = msg.alliance;
                    setCombatLog(prev => [{
                        type: 'BRIBE_ACCEPTED',
                        primaryActor: a.members[0],
                        secondaryActor: a.members[1],
                        value: '0',
                        description: `🤝 Alliance formed: ${a.members.join(' & ')}`,
                        timestamp: Date.now(),
                        roundId: 0,
                    }, ...prev].slice(0, 30));
                    break;
                }
                case 'alliance:betrayal': {
                    setCombatLog(prev => [{
                        type: 'BETRAYAL',
                        primaryActor: msg.betrayer,
                        secondaryActor: msg.victim,
                        value: '0',
                        description: `🗡️ ${msg.betrayer} BETRAYED ${msg.victim}!`,
                        timestamp: Date.now(),
                        roundId: 0,
                    }, ...prev].slice(0, 30));
                    break;
                }
                case 'match:completed': {
                    setCurrentRound(prev => ({
                        ...prev,
                        status: 'COMPLETED',
                        winner: msg.result?.winner?.id || '',
                    }));
                    setCombatLog(prev => [{
                        type: 'CHAMPION_CROWNED',
                        primaryActor: msg.result?.winner?.id || '',
                        secondaryActor: '',
                        value: '0',
                        description: `👑 Match over! Winner: ${msg.result?.winner?.id || 'Draw'}`,
                        timestamp: Date.now(),
                        roundId: 0,
                    }, ...prev].slice(0, 30));
                    break;
                }
                case 'rps:round': {
                    // RPS round result
                    const moves = msg.moves || {};
                    const agentIds = Object.keys(moves);
                    const [id1, id2] = agentIds;
                    const move1 = moves[id1];
                    const move2 = moves[id2];
                    const moveIcon = (m) => RPS_MOVE_ICONS[m] || m;
                    const winnerText = msg.winner ? `${msg.winner} wins!` : 'Draw!';

                    setCombatLog(prev => [{
                        type: 'RPS_ROUND',
                        primaryActor: id1 || '',
                        secondaryActor: id2 || '',
                        value: String(msg.round || 0),
                        description: `✊ Round ${msg.round}: ${id1?.slice(-6)} ${moveIcon(move1)} vs ${moveIcon(move2)} ${id2?.slice(-6)} — ${winnerText}`,
                        timestamp: Date.now(),
                        roundId: msg.round,
                    }, ...prev].slice(0, 30));
                    break;
                }
                case 'agent:reasoning': {
                    // AI agent thought process — show in combat log
                    const name = msg.agentName || msg.agentId?.slice(-8) || 'Agent';
                    const reasoning = msg.reasoning || '';
                    const action = msg.action || '';
                    const fallbackTag = msg.isFallback ? ' [fallback]' : '';
                    setCombatLog(prev => [{
                        type: 'AI_REASONING',
                        primaryActor: msg.agentId || '',
                        secondaryActor: '',
                        value: action,
                        description: `🧠 ${name} thinks: "${reasoning}"${fallbackTag}`,
                        timestamp: Date.now(),
                        roundId: msg.turn || 0,
                    }, ...prev].slice(0, 40));
                    break;
                }
                case 'prize:distributed': {
                    // On-chain prize distribution with tx hashes
                    const txs = msg.distributions || [];
                    const prizeEntries = txs
                        .filter(d => d.type === 'prize_won' || d.type === 'platform_fee')
                        .map(d => {
                            const shortHash = d.txHash ? `${d.txHash.slice(0, 10)}...${d.txHash.slice(-6)}` : 'N/A';
                            const explorerUrl = d.txHash && d.txHash !== 'retained'
                                ? `https://monadvision.com/tx/${d.txHash}` : null;
                            const desc = d.type === 'platform_fee'
                                ? `🏦 Platform fee: ${d.amount.toFixed(4)} MON (retained)`
                                : `💰 Prize: ${d.amount.toFixed(4)} MON → ${d.agentName}${explorerUrl ? ` (tx: ${shortHash})` : ''}`;
                            return {
                                type: d.type === 'platform_fee' ? 'DRAMATIC_MOMENT' : 'CHAMPION_CROWNED',
                                primaryActor: d.agentId || '',
                                secondaryActor: '',
                                value: String(d.amount || 0),
                                description: desc,
                                timestamp: Date.now(),
                                roundId: 0,
                                txHash: d.txHash,
                                explorerUrl,
                            };
                        });
                    if (prizeEntries.length > 0) {
                        setCombatLog(prev => [...prizeEntries, ...prev].slice(0, 40));
                    }
                    break;
                }
                case 'tx:entryFee': {
                    // On-chain entry fee payment
                    const shortHash = msg.txHash ? `${msg.txHash.slice(0, 10)}...${msg.txHash.slice(-6)}` : '';
                    const explorerUrl = msg.txHash ? `https://monadvision.com/tx/${msg.txHash}` : null;
                    setCombatLog(prev => [{
                        type: 'DRAMATIC_MOMENT',
                        primaryActor: msg.agentId || '',
                        secondaryActor: '',
                        value: String(msg.amount || 0),
                        description: `🎟️ ${msg.agentName} paid ${msg.amount} MON entry fee (tx: ${shortHash})`,
                        timestamp: Date.now(),
                        roundId: 0,
                        txHash: msg.txHash,
                        explorerUrl,
                    }, ...prev].slice(0, 40));
                    break;
                }
                default:
                    break;
            }
        };

        const mapEventType = (type) => {
            const map = {
                'attack': 'ATTACK',
                'defend': 'DEFEND',
                'betrayal': 'BETRAYAL',
                'alliance_formed': 'BRIBE_ACCEPTED',
                'propose_alliance': 'BRIBE_OFFERED',
                'death': 'AGENT_DEATH',
                'match_end': 'CHAMPION_CROWNED',
                'rps_round': 'RPS_ROUND',
                'rps_match_end': 'RPS_MATCH_END',
            };
            return map[type] || 'DRAMATIC_MOMENT';
        };

        const formatLiveEvent = (e) => {
            switch (e.type) {
                case 'attack':
                    return `💥 ${e.attackerId} attacks → ${e.defenderId} (${e.damage} dmg${e.defended ? ', blocked!' : ''})`;
                case 'defend':
                    return `🛡️ ${e.agentId} is defending`;
                case 'betrayal':
                    return `🗡️ ${e.betrayer} BETRAYAL → ${e.victim} (${e.damage} dmg!)`;
                case 'death':
                    return `☠️ ${e.agentId} eliminated!`;
                case 'match_end':
                    return `👑 Winner: ${e.winner || 'Draw'}`;
                case 'rps_round': {
                    const mi = (m) => RPS_MOVE_ICONS[m] || m;
                    return `✊ ${e.moveA?.agentId?.slice(-6)} ${mi(e.moveA?.move)} vs ${mi(e.moveB?.move)} ${e.moveB?.agentId?.slice(-6)} — ${e.winner === 'draw' ? 'Draw!' : e.winner?.slice(-6) + ' wins!'}`;
                }
                case 'rps_match_end':
                    return `🏆 RPS Winner: ${e.winner || 'Draw'} (${JSON.stringify(e.finalScore)})`;
                default:
                    return `${e.type}: ${JSON.stringify(e)}`;
            }
        };

        connect();

        return () => {
            if (ws) ws.close();
            if (reconnectTimer) clearTimeout(reconnectTimer);
        };
    }, []);

    // ═══════════════════════════════════════════════════════════════════════════
    // RENDER
    // ═══════════════════════════════════════════════════════════════════════════

    return (
        <div className="spectate-container">
            <header className="spectate-header">
                <h1>🏛️ Monad Colosseum</h1>
                <div className="header-right">
                    <div className="connection-status">
                        {wsConnected ? (
                            <span className="connected">🟢 Live</span>
                        ) : (
                            <span style={{ color: '#ef4444' }}>🔴 Connecting...</span>
                        )}
                    </div>
                </div>
            </header>

            {/* Live Arena Picker */}
            {liveArenas.length > 0 && (
                <div style={{
                    display: 'flex', gap: '0.5rem', padding: '0.75rem 1rem',
                    overflowX: 'auto', background: 'rgba(0,0,0,0.3)',
                    borderBottom: '1px solid var(--border-primary)',
                    alignItems: 'center', flexWrap: 'wrap',
                }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem', fontWeight: 600, marginRight: '0.25rem' }}>ARENAS:</span>
                    {liveArenas.filter(a => a.status === 'in_progress' || a.status === 'lobby').map(arena => (
                        <button
                            key={arena.arenaId}
                            onClick={() => setSelectedArena(arena.arenaId)}
                            style={{
                                padding: '0.3rem 0.75rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600,
                                cursor: 'pointer', transition: 'all 0.2s ease',
                                border: selectedArena === arena.arenaId ? '1px solid var(--accent-orange)' : '1px solid var(--border-primary)',
                                background: selectedArena === arena.arenaId ? 'var(--accent-orange-dim)' : 'transparent',
                                color: selectedArena === arena.arenaId ? 'var(--accent-orange)' : 'var(--text-secondary)',
                            }}
                        >
                            {arena.status === 'in_progress' ? '🔴' : '⏳'} {arena.name} ({arena.agentCount}/{arena.maxAgents})
                        </button>
                    ))}
                    {liveArenas.filter(a => a.status === 'in_progress' || a.status === 'lobby').length === 0 && (
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>No active matches — waiting for agents to join arenas...</span>
                    )}
                </div>
            )}

            <div className="spectate-grid">
                {/* Left Panel: Combat Log */}
                <div className="combat-log-panel">
                    <CombatLog events={combatLog} />
                </div>

                {/* Center Panel: Arena View */}
                <div className="arena-panel">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                        <RoundInfo round={currentRound} />
                        <button
                            onClick={() => setView3D(!view3D)}
                            className="view-toggle-btn"
                            style={{
                                padding: '0.5rem 1rem',
                                background: view3D ? '#8b5cf6' : 'transparent',
                                border: '1px solid #8b5cf6',
                                borderRadius: '8px',
                                color: '#fff',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.5rem'
                            }}
                        >
                            {view3D ? '🎮 3D View' : '📊 2D View'}
                        </button>
                    </div>

                    {view3D ? (
                        <Arena3DViewer
                            agents={agents}
                            events={combatLog.slice(0, 10).map(e => ({
                                type: e.type.toLowerCase(),
                                attackerId: e.primaryActor,
                                defenderId: e.secondaryActor,
                                agentId: e.primaryActor,
                                damage: parseInt(e.value) || 0
                            }))}
                            isLive={wsConnected}
                            arenaId={selectedArena || 'arena_0'}
                        />
                    ) : (
                        <AgentGrid agents={agents} activeBuffs={activeBuffs} />
                    )}
                </div>

                {/* Right Panel: Viewer Buff Interface */}
                <div className="buff-panel">
                    <ViewerBuffPanel
                        agents={agents}
                        currentRound={currentRound.id}
                        isDemoMode={false}
                        onBuffSent={(agent, buffType) => {
                            setActiveBuffs(prev => ({
                                ...prev,
                                [agent]: [...(prev[agent] || []), { type: buffType, magnitude: 100, viewer: 'You', timestamp: Date.now() }]
                            }));
                            setCombatLog(prev => [{
                                type: 'BUFF_RECEIVED',
                                primaryActor: agent,
                                secondaryActor: 'You',
                                value: '0.1',
                                description: `✨ ${agent} received +100 ${BUFF_TYPES[buffType]} from You!`,
                                timestamp: Date.now(),
                                roundId: 47
                            }, ...prev.slice(0, 19)]);
                        }}
                    />
                </div>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

function CombatLog({ events }) {
    return (
        <div className="combat-log">
            <h3>⚔️ Live Combat Feed</h3>
            <div className="log-entries">
                {events.length === 0 ? (
                    <div className="no-events">Waiting for battle events...</div>
                ) : (
                    events.map((event, i) => (
                        <div key={i} className={`log-entry ${event.type.toLowerCase()}`}>
                            <span className="timestamp">
                                {formatTimestamp(event.timestamp)}
                            </span>
                            <span className="icon">{EVENT_ICONS[event.type] || '📢'}</span>
                            <p className="description">
                                {event.description}
                                {event.explorerUrl && (
                                    <a
                                        href={event.explorerUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        style={{
                                            marginLeft: '0.4rem',
                                            color: '#8b5cf6',
                                            fontSize: '0.7rem',
                                            textDecoration: 'underline',
                                        }}
                                    >
                                        🔗 View TX
                                    </a>
                                )}
                            </p>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}

function RoundInfo({ round }) {
    if (!round) {
        return <div className="round-info">No active round</div>;
    }

    return (
        <div className="round-info">
            <h2>Round #{round.id}</h2>
            <div className="round-stats">
                <span className={`status ${round.status.toLowerCase()}`}>
                    {round.status}
                </span>
                <span className="prize">💰 {round.prizePool} MONAD</span>
                {round.winner && round.winner !== ethers.ZeroAddress && (
                    <span className="winner">👑 Winner: {round.winner}</span>
                )}
            </div>
        </div>
    );
}

function AgentGrid({ agents, activeBuffs }) {
    return (
        <div className="agent-grid">
            {agents.map((agent) => (
                <AgentCard
                    key={agent.address}
                    agent={agent}
                    buffs={activeBuffs[agent.address] || []}
                />
            ))}
        </div>
    );
}

function AgentCard({ agent, buffs }) {
    const healthPercent = (agent.health / agent.maxHealth) * 100;

    return (
        <div
            className={`agent-card ${!agent.isAlive ? 'dead' : ''} ${agent.isOutlaw ? 'outlaw' : ''}`}
            data-agent={agent.address}
        >
            <div className="agent-header">
                <span className="address">{agent.address}</span>
                {agent.isOutlaw && <span className="outlaw-badge">🤠 OUTLAW</span>}
            </div>

            <div className="health-bar">
                <div className="health-fill" style={{ width: `${healthPercent}%` }} />
                <span className="health-text">{agent.health} / {agent.maxHealth}</span>
            </div>

            <div className="stats">
                <div className="stat">
                    <span className="label">⚔️</span>
                    <span className="value">{agent.attack}</span>
                </div>
                <div className="stat">
                    <span className="label">🛡️</span>
                    <span className="value">{agent.armor}</span>
                </div>
                <div className="stat">
                    <span className="label">⚡</span>
                    <span className="value">{agent.speed}</span>
                </div>
                <div className="stat">
                    <span className="label">💬</span>
                    <span className="value">{agent.charisma}</span>
                </div>
                <div className="stat">
                    <span className="label">⭐</span>
                    <span className={`value ${agent.reputation < 20 ? 'low' : agent.reputation > 70 ? 'high' : ''}`}>
                        {agent.reputation}
                    </span>
                </div>
            </div>

            {buffs.length > 0 && (
                <div className="active-buffs">
                    {buffs.slice(-3).map((buff, i) => (
                        <span key={i} className={`buff ${BUFF_TYPES[buff.type].toLowerCase()}`}>
                            +{buff.magnitude} {BUFF_TYPES[buff.type]}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

function ViewerBuffPanel({ agents, currentRound, isDemoMode, onBuffSent }) {
    const [selectedAgent, setSelectedAgent] = useState('');
    const [buffType, setBuffType] = useState(0);
    const [tokenAmount, setTokenAmount] = useState('0.1');
    const [isSending, setIsSending] = useState(false);

    const sendBuff = async () => {
        if (!selectedAgent || !tokenAmount) return;

        setIsSending(true);

        if (isDemoMode) {
            // Demo mode: simulate buff
            setTimeout(() => {
                onBuffSent(selectedAgent, buffType);
                setIsSending(false);
                alert('🔥 Buff sent! (Demo mode)');
            }, 1000);
            return;
        }

        try {
            // Real mode: call contract
            // const buffOracle = new ethers.Contract(BUFF_ORACLE_ADDRESS, BuffOracleABI, signer);
            // const tx = await buffOracle.applyBuff(...);
            // await tx.wait();
            alert('Buff sent! 🔥');
        } catch (error) {
            console.error('Failed to send buff:', error);
            alert('Failed to send buff');
        } finally {
            setIsSending(false);
        }
    };

    return (
        <div className="viewer-buff-panel">
            <h3>💪 Buff Your Gladiator</h3>

            <div className="form-group">
                <label>Select Agent</label>
                <select
                    value={selectedAgent}
                    onChange={(e) => setSelectedAgent(e.target.value)}
                >
                    <option value="">Choose a gladiator...</option>
                    {agents.filter(a => a.isAlive).map(a => (
                        <option key={a.address} value={a.address}>
                            {a.address} - HP: {a.health}
                        </option>
                    ))}
                </select>
            </div>

            <div className="form-group">
                <label>Buff Type</label>
                <select
                    value={buffType}
                    onChange={(e) => setBuffType(Number(e.target.value))}
                >
                    <option value={0}>❤️ Health (+HP)</option>
                    <option value={1}>🛡️ Armor (+DEF)</option>
                    <option value={2}>⚔️ Attack (+ATK)</option>
                    <option value={3}>⚡ Speed (+SPD)</option>
                </select>
            </div>

            <div className="form-group">
                <label>Tokens to Burn</label>
                <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={tokenAmount}
                    onChange={(e) => setTokenAmount(e.target.value)}
                    placeholder="0.1"
                />
                <span className="token-symbol">MONAD</span>
            </div>

            <button
                onClick={sendBuff}
                disabled={isSending || !selectedAgent}
                className="send-buff-btn"
            >
                {isSending ? 'Sending...' : '🔥 Burn & Buff'}
            </button>

            <div className="buff-info">
                <p>💡 Burn tokens to instantly buff your favorite gladiator!</p>
                <p>⚡ Effect: +{Math.floor(parseFloat(tokenAmount || '0') * 1000)} to selected stat</p>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function formatTimestamp(ts) {
    const date = new Date(ts);
    return date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

export default Spectate;
