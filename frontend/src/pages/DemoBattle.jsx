/**
 * DemoBattle.jsx — Wallet-Free Demo Battle Page
 * 
 * Creates 2 preset agents and shows live battle via WebSocket.
 * No wallet, no deposit, no Claude API required.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Arena3DViewer } from '../components/Arena3DViewer';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001/ws';

// ─── Action Icons ────────────────────────────────────────────────────────────

const ACTION_ICONS = {
    attack: '💥',
    defend: '🛡️',
    betrayal: '🗡️',
    propose_alliance: '🤝',
    alliance_formed: '🤝',
    accept_alliance: '✅',
    death: '☠️',
    recovery: '💚',
    match_start: '⚔️',
    match_end: '👑',
    bribe: '💰',
    fled: '🏃',
};

// ─── Main Component ──────────────────────────────────────────────────────────

export default function DemoBattle() {
    const [phase, setPhase] = useState('idle'); // idle | loading | fighting | finished
    const [agents, setAgents] = useState([]);
    const [agentHP, setAgentHP] = useState({});
    const [combatLog, setCombatLog] = useState([]);
    const [winner, setWinner] = useState(null);
    const [currentTurn, setCurrentTurn] = useState(0);
    const [lastTurnEvents, setLastTurnEvents] = useState([]);
    const [error, setError] = useState('');
    const wsRef = useRef(null);
    const logEndRef = useRef(null);
    const agentNamesRef = useRef({}); // id -> name lookup

    // Auto-scroll combat log
    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [combatLog]);

    // Helper: resolve agent ID to name
    const getName = (id) => agentNamesRef.current[id] || id;

    // WebSocket connection
    useEffect(() => {
        if (phase !== 'fighting') return;

        let ws;
        let reconnectTimer;

        const connect = () => {
            ws = new WebSocket(WS_URL);
            wsRef.current = ws;

            ws.onopen = () => {
                console.log('[Demo WS] Connected');
                ws.send(JSON.stringify({ type: 'subscribe', arenaId: '*' }));
            };

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    handleWsMessage(msg);
                } catch (e) {
                    console.error('[Demo WS] Parse error:', e);
                }
            };

            ws.onclose = () => {
                if (phase === 'fighting') {
                    reconnectTimer = setTimeout(connect, 2000);
                }
            };

            ws.onerror = (err) => console.error('[Demo WS] Error:', err);
        };

        connect();

        return () => {
            if (ws) ws.close();
            if (reconnectTimer) clearTimeout(reconnectTimer);
        };
    }, [phase]);

    const handleWsMessage = useCallback((msg) => {
        switch (msg.type) {
            case 'autonomous:joined': {
                addLog('🏟️', `${msg.agentName} joined the arena!`, 'join');
                break;
            }
            case 'match:launching': {
                setPhase('fighting');
                addLog('⚔️', `Match starting! ${msg.agentCount || 2} gladiators in the arena!`, 'start');
                break;
            }
            case 'match:turn': {
                setCurrentTurn(msg.turn || 0);
                if (msg.events) {
                    setLastTurnEvents(msg.events);
                    msg.events
                        .filter(e => e.type !== 'recovery') // skip noisy recovery events
                        .forEach(e => {
                            const icon = ACTION_ICONS[e.type] || '📢';
                            const text = formatEvent(e, msg.turn);
                            const type = e.type === 'death' ? 'death' : e.type === 'betrayal' ? 'betrayal' : 'action';
                            addLog(icon, text, type);
                        });
                }
                // Update HP from agent states
                if (msg.agentStates) {
                    const hpMap = {};
                    msg.agentStates.forEach(a => {
                        hpMap[a.id] = { hp: a.hp, alive: a.alive };
                    });
                    setAgentHP(prev => ({ ...prev, ...hpMap }));
                }
                break;
            }
            case 'agent:died': {
                addLog('☠️', `${msg.agentName || msg.agentId} eliminated! (Turn ${msg.turn})`, 'death');
                setAgentHP(prev => ({
                    ...prev,
                    [msg.agentId]: { hp: 0, alive: false }
                }));
                break;
            }
            case 'alliance:formed': {
                const members = msg.alliance?.members?.join(' & ') || '?';
                addLog('🤝', `Alliance formed: ${members}`, 'alliance');
                break;
            }
            case 'alliance:betrayal': {
                addLog('🗡️', `${msg.betrayer} BETRAYED ${msg.victim}!`, 'betrayal');
                break;
            }
            case 'match:completed': {
                const w = msg.result?.winner;
                setWinner(w ? { id: w.id, name: w.name || w.id } : null);
                setPhase('finished');
                if (w) {
                    addLog('👑', `🏆 Winner: ${w.name || w.id}!`, 'winner');
                } else {
                    addLog('🏁', `Match ended — Draw!`, 'draw');
                }
                break;
            }
            case 'agent:statusChanged': {
                // Ignore status updates during battle
                break;
            }
            default:
                break;
        }
    }, []);

    const addLog = (icon, text, type = 'info') => {
        setCombatLog(prev => [...prev, { icon, text, type, time: new Date().toLocaleTimeString('en-US') }]);
    };

    const formatEvent = (e, turn) => {
        switch (e.type) {
            case 'attack':
                return `${getName(e.attackerId)} → ${getName(e.defenderId)} (${e.damage} dmg${e.defended ? ', blocked!' : ''})`;
            case 'defend':
                return `${getName(e.agentId)} defending (+5 HP)`;
            case 'betrayal':
                return `${getName(e.betrayer)} BETRAYAL → ${getName(e.victim)} (${e.damage} dmg!)`;
            case 'propose_alliance':
                return `${getName(e.from)} proposes alliance → ${getName(e.to)}`;
            case 'alliance_formed':
                return `Alliance formed: ${e.alliance?.members?.map(getName).join(' & ') || '?'}`;
            case 'death':
                return `${getName(e.agentId)} eliminated!`;
            case 'match_end':
                return e.winner ? `🏆 Winner: ${getName(e.winner)}!` : 'Draw!';
            default:
                return `Turn ${turn}: ${e.type}`;
        }
    };

    // ─── Start Demo Battle ───────────────────────────────────────────────────

    const startBattle = async () => {
        setPhase('loading');
        setError('');
        setCombatLog([]);
        setWinner(null);
        setCurrentTurn(0);
        setLastTurnEvents([]);
        setAgentHP({});

        try {
            const res = await fetch(`${BACKEND_URL}/api/demo/quick-battle`, { method: 'POST' });
            const data = await res.json();

            if (!data.ok) {
                throw new Error(data.error || 'Failed to start demo battle');
            }

            setAgents(data.agents);

            // Build name lookup
            const names = {};
            data.agents.forEach(a => { names[a.id] = a.name; });
            agentNamesRef.current = names;

            // Initialize HP
            const hpMap = {};
            data.agents.forEach(a => {
                hpMap[a.id] = { hp: 100, alive: true };
            });
            setAgentHP(hpMap);

            addLog('🎮', data.message, 'start');
            addLog('⚔️', 'Match starting!', 'start');
            setPhase('fighting');
        } catch (err) {
            setError(err.message || 'An error occurred');
            setPhase('idle');
        }
    };

    // ─── Render ──────────────────────────────────────────────────────────────

    return (
        <div style={{ maxWidth: '1000px', margin: '0 auto', padding: '1.5rem' }}>
            {/* Header */}
            <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
                <h1 style={{
                    fontSize: '2.5rem', fontWeight: 900,
                    background: 'linear-gradient(135deg, #3b82f6 0%, #06b6d4 50%, #8b5cf6 100%)',
                    WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                    marginBottom: '0.5rem',
                }}>
                    ⚔️ Demo Battle
                </h1>
                <p className="mc-text-secondary" style={{ fontSize: '1.1rem' }}>
                    Watch two AI gladiators battle without connecting a wallet!
                </p>
            </div>

            {/* Idle — Start Button */}
            {phase === 'idle' && (
                <div className="mc-card" style={{ padding: '3rem', textAlign: 'center' }}>
                    <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>🏟️</div>
                    <h2 className="mc-title" style={{ marginBottom: '1rem' }}>Ready?</h2>
                    <p className="mc-text-secondary" style={{ marginBottom: '2rem', maxWidth: '500px', margin: '0 auto 2rem' }}>
                        Two random AI gladiators will be created and battle in the Bronze Arena.
                        No wallet connection or deposit required!
                    </p>

                    {error && <div className="mc-error" style={{ marginBottom: '1rem' }}>{error}</div>}

                    <button onClick={startBattle} className="mc-btn mc-btn-primary" style={{
                        fontSize: '1.2rem', padding: '1rem 3rem',
                        background: 'linear-gradient(135deg, #3b82f6, #2563eb)',
                        border: 'none',
                        boxShadow: '0 4px 24px rgba(59, 130, 246, 0.35)',
                    }}>
                        🎮 Start Quick Demo Battle
                    </button>
                </div>
            )}

            {/* Loading */}
            {phase === 'loading' && (
                <div className="mc-card" style={{ padding: '3rem', textAlign: 'center' }}>
                    <div className="demo-spinner" />
                    <p className="mc-text-secondary" style={{ marginTop: '1rem' }}>
                        Preparing gladiators...
                    </p>
                </div>
            )}

            {/* Battle Active: fighting | finished */}
            {(phase === 'fighting' || phase === 'finished') && (
                <>
                    {/* 3D Arena View */}
                    <div style={{
                        width: '100%',
                        maxWidth: '900px',
                        aspectRatio: '16/9',
                        maxHeight: '60vh',
                        margin: '0 auto 2rem',
                        position: 'relative'
                    }}>
                        <Arena3DViewer
                            agents={agents}
                            events={lastTurnEvents}
                            isLive={false} // DemoBattle handles WS
                            className="demo-arena-viewer"
                            style={{ width: '100%', height: '100%' }}
                        />
                    </div>

                    {/* Agent Cards */}
                    <div className="demo-agents-row">
                        {agents.map((agent, idx) => {
                            const hp = agentHP[agent.id] || { hp: 100, alive: true };
                            const hpPercent = Math.max(0, hp.hp);
                            const hpColor = hpPercent > 60 ? '#22c55e' : hpPercent > 30 ? '#eab308' : '#ef4444';

                            return (
                                <React.Fragment key={agent.id}>
                                    {idx === 1 && (
                                        <div className="demo-vs-badge">
                                            <span>VS</span>
                                        </div>
                                    )}
                                    <div className={`demo-agent-card ${!hp.alive ? 'demo-agent-dead' : ''} ${winner?.id === agent.id ? 'demo-agent-winner' : ''}`}>
                                        {winner?.id === agent.id && <div className="demo-winner-crown">👑</div>}
                                        {!hp.alive && <div className="demo-dead-overlay">☠️</div>}

                                        <h3 style={{ fontSize: '1.3rem', margin: '0 0 0.25rem' }}>{agent.name}</h3>
                                        <p className="mc-text-muted" style={{ fontSize: '0.8rem', margin: '0 0 0.75rem' }}>
                                            {agent.description}
                                        </p>

                                        {/* Traits */}
                                        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.75rem', justifyContent: 'center' }}>
                                            {agent.traits?.map(t => (
                                                <span key={t} className="mc-badge" style={{ fontSize: '0.7rem' }}>{t}</span>
                                            ))}
                                        </div>

                                        {/* HP Bar */}
                                        <div className="demo-hp-bar-container">
                                            <div className="demo-hp-bar-fill" style={{
                                                width: `${hpPercent}%`,
                                                background: `linear-gradient(90deg, ${hpColor}, ${hpColor}dd)`,
                                            }} />
                                            <span className="demo-hp-text">{hp.hp} HP</span>
                                        </div>

                                        {/* Strategy Params */}
                                        <div className="demo-params">
                                            <div className="demo-param">
                                                <span className="demo-param-label">⚔️ Aggression</span>
                                                <div className="demo-param-bar">
                                                    <div style={{ width: `${agent.strategyParams?.aggressiveness || 50}%`, background: '#ef4444' }} />
                                                </div>
                                            </div>
                                            <div className="demo-param">
                                                <span className="demo-param-label">🤝 Alliance</span>
                                                <div className="demo-param-bar">
                                                    <div style={{ width: `${agent.strategyParams?.allianceTendency || 50}%`, background: '#3b82f6' }} />
                                                </div>
                                            </div>
                                            <div className="demo-param">
                                                <span className="demo-param-label">🗡️ Betrayal</span>
                                                <div className="demo-param-bar">
                                                    <div style={{ width: `${agent.strategyParams?.betrayalChance || 20}%`, background: '#9b5de5' }} />
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </React.Fragment>
                            );
                        })}
                    </div>

                    {/* Status Bar */}
                    <div className="demo-status-bar">
                        {phase === 'fighting' && (
                            <>
                                <span className="demo-live-dot" />
                                <span>LIVE — Turn {currentTurn}</span>
                            </>
                        )}
                        {phase === 'finished' && (
                            <span>🏁 Match complete!</span>
                        )}
                    </div>

                    {/* Combat Log */}
                    <div className="mc-card demo-combat-log">
                        <h3 style={{ margin: '0 0 1rem', fontSize: '1rem' }}>📜 Combat Log</h3>
                        <div className="demo-log-entries">
                            {combatLog.length === 0 ? (
                                <p className="mc-text-muted" style={{ textAlign: 'center', padding: '2rem 0' }}>
                                    Waiting for battle events...
                                </p>
                            ) : (
                                combatLog.map((entry, i) => (
                                    <div key={i} className={`demo-log-entry demo-log-${entry.type}`}>
                                        <span className="demo-log-time">{entry.time}</span>
                                        <span className="demo-log-icon">{entry.icon}</span>
                                        <span className="demo-log-text">{entry.text}</span>
                                    </div>
                                ))
                            )}
                            <div ref={logEndRef} />
                        </div>
                    </div>

                    {/* Replay Button */}
                    {phase === 'finished' && (
                        <div style={{ textAlign: 'center', marginTop: '1.5rem' }}>
                            <button onClick={startBattle} className="mc-btn mc-btn-primary" style={{
                                fontSize: '1.1rem', padding: '0.9rem 2.5rem',
                                background: 'linear-gradient(135deg, #3b82f6, #2563eb)',
                                border: 'none',
                            }}>
                                🔄 Battle Again
                            </button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}