/**
 * Arena3DViewer.jsx - 3D Battle Visualization for Spectate Mode
 * 
 * Wraps Opus ArenaScene for React integration
 */

import React, { useEffect, useRef, useState } from 'react';
import { ArenaR3F } from './r3f/ArenaR3F';

// WebSocket client
class SpectateWsClient {
    constructor() {
        this.ws = null;
        this.listeners = {};
        this.reconnectAttempts = 0;
        this.maxReconnects = 5;
    }

    connect(url = 'ws://localhost:3001/ws') {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
            console.log('[WS] Connected');
            this.reconnectAttempts = 0;
            this._emit('_connected', {});
        };

        this.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                this._emit(msg.type, msg);
            } catch (e) {
                console.error('[WS] Parse error:', e);
            }
        };

        this.ws.onclose = () => {
            console.log('[WS] Disconnected');
            this._emit('_disconnected', {});
            if (this.reconnectAttempts < this.maxReconnects) {
                setTimeout(() => {
                    this.reconnectAttempts++;
                    this.connect(url);
                }, 2000);
            }
        };

        this.ws.onerror = (error) => {
            console.error('[WS] Error:', error);
        };
    }

    subscribe(arenaId) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'subscribe', arenaId }));
        }
    }

    on(event, callback) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(callback);
    }

    off(event, callback) {
        if (this.listeners[event]) {
            this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
        }
    }

    _emit(event, data) {
        if (this.listeners[event]) {
            this.listeners[event].forEach(cb => cb(data));
        }
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

// Global WS instance
const wsClient = new SpectateWsClient();

export function Arena3DViewer({ agents, events, isLive = false, arenaId, className, style }) {
    const canvasRef = useRef(null);
    // Initialize 3D scene (Removed Legacy ArenaScene)
    // ArenaR3F handles its own initialization via React Lifecycle

    // Process incoming events
    // ArenaR3F handles this via props. We just need to ensure 'events' prop is up to date.
    // In live mode, we accumulate events in battleLog, but for animations we usually want 'latest' events.
    // ArenaR3F expects 'events' to trigger animations.
    // If isLive, 'battleLog' grows. Passing entire battleLog to ArenaR3F is bad (re-runs all animations).
    // We should pass 'lastEvents' state.

    // For DemoBattle (isLive=false), 'events' prop is passed from parent (lastTurnEvents).
    // For Spectate (isLive=true), we need to track 'lastEvents' from WS.

    const [isConnected, setIsConnected] = useState(false);
    const [currentTurn, setCurrentTurn] = useState(0);
    const [battleLog, setBattleLog] = useState([]);
    const [lastWsEvents, setLastWsEvents] = useState([]);

    useEffect(() => {
        if (!isLive) return;
        // If not live, rely on props
    }, [isLive]);

    // WebSocket connection for live mode
    useEffect(() => {
        if (!isLive) return;

        wsClient.connect();

        const handleConnected = () => setIsConnected(true);
        const handleDisconnected = () => setIsConnected(false);

        const handleTurn = (msg) => {
            setCurrentTurn(msg.turn);
            if (msg.events && Array.isArray(msg.events)) {
                setBattleLog(prev => [...(prev || []), ...msg.events]);
                setLastWsEvents(msg.events);
            }
        };

        wsClient.on('_connected', handleConnected);
        wsClient.on('_disconnected', handleDisconnected);
        wsClient.on('match:turn', handleTurn);

        if (arenaId) {
            wsClient.subscribe(arenaId);
        }

        return () => {
            wsClient.off('_connected', handleConnected);
            wsClient.off('_disconnected', handleDisconnected);
            wsClient.off('match:turn', handleTurn);
        };
    }, [isLive, arenaId, agents]);

    return (
        <div className={`arena-3d-viewer ${className || ''}`} style={style}>
            <div className="arena-3d-header">
                <h3>🎮 3D Arena View</h3>
                <div className="arena-3d-status">
                    {isLive && (
                        <span className={`ws-status ${isConnected ? 'connected' : 'disconnected'}`}>
                            {isConnected ? '🟢 Live' : '🔴 Offline'}
                        </span>
                    )}
                    <span className="turn-info">Turn: {currentTurn}</span>
                </div>
            </div>

            {/* R3F Arena */}
            <div style={{ width: '100%', height: '650px', position: 'relative' }}>
                <ArenaR3F
                    agents={agents.map((a, i) => ({
                        ...a,
                        id: a.id || a.address || `agent_${i}`,
                        name: a.name || a.id || a.address || `Agent ${i + 1}`
                    }))}
                    events={isLive ? lastWsEvents : events}
                    className="r3f-canvas-container"
                    style={{ width: '100%', height: '100%' }}
                />
            </div>

            {(battleLog || []).length > 0 && (
                <div className="arena-3d-log">
                    {(battleLog || []).slice(-5).map((evt, i) => (
                        <div key={i} className={`log-item ${evt.type}`}>
                            {evt.type === 'attack' && `⚔️ ${evt.attackerId} → ${evt.defenderId} (-${evt.damage})`}
                            {evt.type === 'defend' && `🛡️ ${evt.agentId} defended`}
                            {evt.type === 'death' && `☠️ ${evt.agentId} eliminated!`}
                            {evt.type === 'betrayal' && `🗡️ ${evt.betrayer} betrayed ${evt.victim}!`}
                            {evt.type === 'bribe' && `💰 ${evt.offerer || evt.attackerId} bribed ${evt.target || evt.defenderId}`}
                            {evt.type === 'alliance_formed' && `🤝 Alliance: ${evt.alliance?.members?.join(' & ')}`}
                        </div>
                    ))}
                </div>
            )}

            <style>{`
                .arena-3d-viewer {
                    background: var(--bg-secondary, #1a1a2e);
                    border-radius: 12px;
                    overflow: hidden;
                    border: 1px solid var(--border-color, #2a2a4e);
                }
                .arena-3d-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 0.75rem 1rem;
                    background: var(--bg-tertiary, #0f0f1a);
                    border-bottom: 1px solid var(--border-color, #2a2a4e);
                }
                .arena-3d-header h3 {
                    margin: 0;
                    color: var(--accent-primary, #8b5cf6);
                    font-size: 1rem;
                }
                .arena-3d-status {
                    display: flex;
                    gap: 1rem;
                    font-size: 0.85rem;
                }
                .ws-status {
                    padding: 0.25rem 0.5rem;
                    border-radius: 4px;
                }
                .ws-status.connected { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
                .ws-status.disconnected { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
                .turn-info { color: var(--text-secondary, #94a3b8); }
                .arena-3d-log {
                    padding: 0.5rem 1rem;
                    background: var(--bg-tertiary, #0f0f1a);
                    max-height: 100px;
                    overflow-y: auto;
                    font-size: 0.8rem;
                    font-family: monospace;
                }
                .log-item { padding: 0.25rem 0; color: var(--text-secondary, #94a3b8); }
                .log-item.attack { color: #ef4444; }
                .log-item.death { color: #f59e0b; }
                .log-item.betrayal { color: #dc2626; }
            `}</style>
        </div>
    );
}

export default Arena3DViewer;