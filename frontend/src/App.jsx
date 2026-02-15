/**
 * Gladiator Factory - Main Application
 * Fixed Tier Arenas & Agent Creation
 */

import React, { useState, useEffect, useCallback } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { parseEther } from 'viem'
import { WalletButton } from './components/WalletButton'
import { ErrorBoundary } from './components/ErrorBoundary'
import { SkeletonArenaCard, SkeletonList } from './components/Skeleton'
import Spectate from './Spectate'
import MyAgents from './pages/MyAgents'
import DemoBattle from './pages/DemoBattle'
import ApiDocs from './pages/ApiDocs'
import { CONTRACTS, AGENT_REGISTRY_ABI } from './config/contracts'

// Contract Config
const FACTORY_ADDRESS = import.meta.env.VITE_FACTORY_ADDRESS || '0xc44e17b36B6bafB742b7AD729B9C5d9392Cf1894'
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

// Fixed Tier Arenas
const TIER_ARENAS = [
    { id: 'bronze', name: '🥉 Bronze Arena', tier: 'bronze', entryFee: '0.1', maxPlayers: 8, color: '#CD7F32', desc: 'For beginners' },
    { id: 'silver', name: '🥈 Silver Arena', tier: 'silver', entryFee: '0.3', maxPlayers: 6, color: '#C0C0C0', desc: 'Mid-level gladiators' },
    { id: 'gold', name: '🥇 Gold Arena', tier: 'gold', entryFee: '0.5', maxPlayers: 4, color: '#FFD700', desc: 'Battle of champions' },
    { id: 'platinum', name: '💎 Platinum Arena', tier: 'platinum', entryFee: '1', maxPlayers: 4, color: '#E5E4E2', desc: 'Elite gladiators league' },
    { id: 'diamond', name: '💠 Diamond Arena', tier: 'diamond', entryFee: '2', maxPlayers: 2, color: '#B9F2FF', desc: 'Duel of legends' },
]

const CHARACTER_TRAITS = [
    { id: 'aggressive', emoji: '⚔️', name: 'Aggressive', desc: 'Attacks relentlessly' },
    { id: 'loyal', emoji: '🤝', name: 'Loyal', desc: 'Stays true to alliances' },
    { id: 'briber', emoji: '💰', name: 'Briber', desc: 'Tries to buy off opponents' },
    { id: 'ambusher', emoji: '🎭', name: 'Ambusher', desc: 'Strikes at unexpected moments' },
    { id: 'balanced', emoji: '⚖️', name: 'Balanced', desc: 'Adapts to the situation' }
]

// Main App
export default function App() {
    const [page, setPage] = useState('home')

    return (
        <div className="spectate-container">
            <Header page={page} setPage={setPage} />
            <ErrorBoundary>
                <main style={{ padding: '1rem' }}>
                    {page === 'home' && <HomePage setPage={setPage} />}
                    {page === 'demo' && <DemoBattle />}
                    {page === 'create' && <CreateAgentPage />}
                    {page === 'arenas' && <ArenasPage onNavigate={setPage} />}
                    {page === 'leaderboard' && <LeaderboardPage />}
                    {page === 'myagents' && <MyAgents onNavigate={setPage} />}
                    {page === 'spectate' && <Spectate />}
                    {page === 'docs' && <ApiDocs />}
                </main>
            </ErrorBoundary>
        </div>
    )
}

// Header
function Header({ page, setPage }) {
    return (
        <header className="spectate-header">
            <h1 onClick={() => setPage('home')}>⚔️ Monad Colosseum</h1>
            <nav>
                {[
                    { id: 'home', icon: '🏠', label: 'Home' },
                    { id: 'demo', icon: '🎮', label: 'Demo Battle' },
                    { id: 'create', icon: '🧠', label: 'Create Agent' },
                    { id: 'arenas', icon: '🏟️', label: 'Arenas' },
                    { id: 'leaderboard', icon: '🏆', label: 'Leaderboard' },
                    { id: 'myagents', icon: '🃏', label: 'My Agents' },
                    { id: 'spectate', icon: '📺', label: 'Spectate' },
                    { id: 'docs', icon: '📡', label: 'API Docs' }
                ].map(p => (
                    <button
                        key={p.id}
                        onClick={() => setPage(p.id)}
                        style={{
                            background: page === p.id ? 'var(--accent-orange-dim)' : 'transparent',
                            border: page === p.id ? '1px solid var(--border-active)' : '1px solid transparent',
                            color: page === p.id ? 'var(--accent-orange)' : 'var(--text-secondary)',
                        }}
                    >
                        {p.icon} {p.label}
                    </button>
                ))}
            </nav>
            <div className="header-right">
                <WalletButton />
            </div>
        </header>
    )
}

// Home Page
function HomePage({ setPage }) {
    const { isConnected } = useAccount()

    return (
        <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '2rem' }}>
            {/* Hero */}
            <section style={{ textAlign: 'center', padding: '5rem 0 3rem' }}>
                <h1 style={{
                    fontSize: '3.5rem', fontWeight: 900, letterSpacing: '-0.03em',
                    background: 'linear-gradient(135deg, var(--text-primary) 0%, var(--accent-orange) 60%, var(--accent-violet) 100%)',
                    WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                    marginBottom: '0.75rem', lineHeight: 1.1
                }}>
                    Monad Colosseum
                </h1>
                <p style={{ fontSize: '1.3rem', color: 'var(--accent-orange)', fontWeight: 500, margin: '1rem 0' }}>
                    AI Agent Arena Battle Platform
                </p>
                <p className="mc-text-secondary" style={{ maxWidth: '640px', margin: '0 auto 2.5rem', lineHeight: 1.8 }}>
                    Create autonomous AI gladiators powered by Claude. Send them into tiered arenas.
                    Track their earnings. Bribe, form alliances, betray.
                </p>
                {!isConnected ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', alignItems: 'center' }}>
                        <button onClick={() => setPage('demo')} className="mc-btn-primary"
                            style={{
                                fontSize: '1.15rem', padding: '1.1rem 3rem',
                                background: 'linear-gradient(135deg, #3b82f6, #2563eb)',
                                border: 'none',
                                boxShadow: '0 4px 24px rgba(59, 130, 246, 0.35)',
                                animation: 'demoPulse 2s ease-in-out infinite',
                            }}>
                            🎮 Demo Battle — No Wallet Needed!
                        </button>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                            <span className="mc-text-muted" style={{ fontSize: '0.85rem' }}>or</span>
                            <WalletButton />
                        </div>
                    </div>
                ) : (
                    <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                        <button onClick={() => setPage('demo')} className="mc-btn-primary"
                            style={{
                                fontSize: '1rem', padding: '1rem 2.5rem',
                                background: 'linear-gradient(135deg, #3b82f6, #2563eb)',
                                border: 'none',
                            }}>
                            🎮 Demo Battle
                        </button>
                        <button onClick={() => setPage('create')} className="mc-btn-primary"
                            style={{ fontSize: '1rem', padding: '1rem 2.5rem' }}>
                            🧠 Create Agent
                        </button>
                        <button onClick={() => setPage('arenas')} className="mc-btn-secondary"
                            style={{ fontSize: '1rem', padding: '1rem 2.5rem' }}>
                            🏟️ Go to Arenas
                        </button>
                    </div>
                )}
            </section>

            {/* How it Works */}
            <section style={{ marginTop: '4rem' }}>
                <h2 className="mc-title" style={{ textAlign: 'center', fontSize: '1.5rem', marginBottom: '2rem' }}>How It Works</h2>
                <div className="agent-grid">
                    {[
                        { icon: '🧠', title: '1. Create Agent', desc: 'Write a strategy with Claude. Set personality & battle parameters.' },
                        { icon: '🏟️', title: '2. Enter Arena', desc: 'Choose from Bronze, Silver, or Gold arenas.' },
                        { icon: '⚔️', title: '3. Battle', desc: 'Attack, defend, form alliances, bribe, betray!' },
                        { icon: '💰', title: '4. Earn', desc: 'Collect the prize pool. Rise in the ELO rankings.' }
                    ].map((f, i) => (
                        <div key={i} className="agent-card" style={{ textAlign: 'center', padding: '2rem' }}>
                            <span style={{ fontSize: '2.8rem', display: 'block', marginBottom: '0.5rem' }}>{f.icon}</span>
                            <h3 className="mc-title" style={{ fontSize: '1rem', margin: '0.75rem 0 0.5rem' }}>{f.title}</h3>
                            <p className="mc-text-secondary">{f.desc}</p>
                        </div>
                    ))}
                </div>
            </section>

            {/* Tier Preview */}
            <section style={{ marginTop: '4rem' }}>
                <h2 className="mc-title" style={{ textAlign: 'center', fontSize: '1.5rem', marginBottom: '2rem' }}>Arena Tiers</h2>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '1.5rem' }}>
                    {TIER_ARENAS.map(arena => (
                        <div key={arena.id} className="agent-card" style={{
                            textAlign: 'center', padding: '2rem',
                            borderTop: `3px solid ${arena.color}`
                        }}>
                            <h3 style={{ fontSize: '1.3rem', color: arena.color, fontWeight: 700 }}>{arena.name}</h3>
                            <p className="mc-text-secondary" style={{ margin: '0.5rem 0' }}>{arena.desc}</p>
                            <div style={{ marginTop: '1.25rem' }}>
                                <span style={{ color: 'var(--accent-green)', fontWeight: 700, fontSize: '1.5rem', fontFamily: 'var(--font-mono)' }}>
                                    {arena.entryFee} MON
                                </span>
                                <p className="mc-text-muted" style={{ marginTop: '0.25rem' }}>entry fee</p>
                            </div>
                        </div>
                    ))}
                </div>
            </section>
        </div>
    )
}

// Create Agent Page — Natural Language → Claude → Confirm → Onchain via User Wallet
function CreateAgentPage() {
    const { address, isConnected } = useAccount()
    const [description, setDescription] = useState('')
    const [isGenerating, setIsGenerating] = useState(false)
    const [parsedAgent, setParsedAgent] = useState(null)  // Claude's parsed result (pre-confirm)
    const [confirmedAgent, setConfirmedAgent] = useState(null)  // After onchain tx
    const [error, setError] = useState('')
    const [txStep, setTxStep] = useState('') // '' | 'signing' | 'confirming' | 'done'

    // wagmi write contract hook
    const { data: txHash, writeContract, isPending: isSigning, error: writeError } = useWriteContract()
    const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({ hash: txHash })

    // When tx confirmed, finalize
    useEffect(() => {
        if (isConfirmed && txHash && parsedAgent && !confirmedAgent) {
            setTxStep('done')
            setConfirmedAgent({ ...parsedAgent, onchainTxHash: txHash })
            // Notify backend of onchain confirmation
            fetch(`${BACKEND_URL}/api/agent/${parsedAgent.agent.id}/confirm-onchain`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ txHash }),
            }).catch(() => { })
        }
    }, [isConfirmed, txHash, parsedAgent, confirmedAgent])

    // Track write error
    useEffect(() => {
        if (writeError) {
            setError('MetaMask error: ' + (writeError.shortMessage || writeError.message))
            setTxStep('')
        }
    }, [writeError])

    // Track tx steps
    useEffect(() => {
        if (isSigning) setTxStep('signing')
        else if (isConfirming && txHash) setTxStep('confirming')
    }, [isSigning, isConfirming, txHash])

    const generateAgent = async () => {
        if (!description.trim()) return
        setIsGenerating(true)
        setError('')
        setParsedAgent(null)
        setConfirmedAgent(null)
        setTxStep('')
        try {
            const res = await fetch(`${BACKEND_URL}/api/agent/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ description, ownerAddress: address })
            })
            const data = await res.json()
            if (data.error) {
                setError(data.error)
                return
            }
            if (data.success) {
                setParsedAgent(data)
            }
        } catch (err) {
            setError('Backend connection error. Is the backend running?')
        } finally {
            setIsGenerating(false)
        }
    }

    const confirmAndRegisterOnchain = async () => {
        if (!parsedAgent) return
        setError('')
        setTxStep('signing')

        const params = parsedAgent.parsed.params
        const briberyPolicyMap = { reject: 0, accept: 1, conditional: 2 }

        try {
            writeContract({
                address: CONTRACTS.AGENT_REGISTRY,
                abi: AGENT_REGISTRY_ABI,
                functionName: 'registerAgent',
                args: [
                    parsedAgent.agentWalletAddress,
                    parsedAgent.parsed.name,
                    parsedAgent.parsed.strategyDescription || '',
                    {
                        aggressiveness: params.aggressiveness,
                        riskTolerance: params.riskTolerance,
                        briberyPolicy: briberyPolicyMap[params.briberyPolicy] ?? 2,
                        profitTarget: parseEther(String(params.profitTarget || 200)),
                        withdrawThreshold: parseEther(String(params.withdrawThreshold || 10)),
                        allianceTendency: params.allianceTendency,
                        betrayalChance: params.betrayalChance,
                    },
                ],
                value: parseEther('0.01'), // creation fee
            })
        } catch (err) {
            setError('Failed to initiate transaction: ' + err.message)
            setTxStep('')
        }
    }

    if (!isConnected) {
        return <div className="mc-card" style={{ margin: '2rem auto', maxWidth: '700px', padding: '3rem', textAlign: 'center' }}>
            <h2 className="mc-title">Create Agent</h2>
            <p className="mc-text-secondary" style={{ margin: '1rem 0' }}>Connect your wallet to create an agent.</p>
            <WalletButton />
        </div>
    }

    return (
        <div style={{ maxWidth: '800px', margin: '0 auto', padding: '1.5rem' }}>
            <h1 className="mc-title" style={{ marginBottom: '0.5rem' }}>Create New Gladiator</h1>
            <p className="mc-text-secondary" style={{ marginBottom: '2rem' }}>
                Describe your agent in natural language. Claude will automatically generate its strategy, parameters, and battle code.
            </p>

            {/* Input Phase */}
            {!parsedAgent && !confirmedAgent && (
                <div className="mc-card" style={{ padding: '2rem' }}>
                    <label className="mc-label">Describe Your Agent</label>
                    <textarea
                        placeholder={`Example:\n\n"I want a very aggressive gladiator. It should attack constantly but switch to defense when health drops below 30%. If offered an alliance, accept it but betray at the best moment. Should not accept bribes. Name it 'Iron Fist'."\n\nOr:\n\n"A diplomatic agent. First offer alliances to everyone, then coordinate attacks against the strongest opponent. Stay loyal, never betray. Enter low-risk arenas."`}
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        className="mc-textarea"
                        style={{ minHeight: '220px' }}
                    />

                    {error && (
                        <div className="mc-error" style={{ marginTop: '1rem' }}>{error}</div>
                    )}

                    <button
                        onClick={generateAgent}
                        disabled={isGenerating || !description.trim()}
                        className="mc-btn mc-btn-primary"
                        style={{ width: '100%', marginTop: '1.5rem' }}
                    >
                        {isGenerating ? (
                            <span className="mc-loading-text">Claude is analyzing<span className="mc-dots"></span></span>
                        ) : (
                            'Create Agent'
                        )}
                    </button>

                    <div className="mc-hint" style={{ marginTop: '1rem' }}>
                        <p>Claude will extract the following from your description:</p>
                        <ul>
                            <li>Agent name and character traits</li>
                            <li>Aggressiveness, risk tolerance, alliance tendency, betrayal chance</li>
                            <li>Bribery policy, profit target</li>
                            <li>Full battle strategy code</li>
                        </ul>
                    </div>
                </div>
            )}

            {/* Preview + Confirm Phase */}
            {parsedAgent && !confirmedAgent && (
                <div>
                    <div className="mc-card" style={{ padding: '2rem', marginBottom: '1.5rem', border: '1px solid var(--accent-orange)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
                            <div className="mc-avatar">⚔️</div>
                            <div>
                                <h2 className="mc-title" style={{ margin: 0 }}>{parsedAgent.parsed.name}</h2>
                                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
                                    {parsedAgent.parsed.traits?.map(t => (
                                        <span key={t} className="mc-badge">{t}</span>
                                    ))}
                                </div>
                            </div>
                        </div>

                        <p className="mc-text-secondary" style={{ marginBottom: '1.5rem', fontStyle: 'italic' }}>
                            "{parsedAgent.parsed.strategyDescription}"
                        </p>

                        <div className="mc-params-grid">
                            {[
                                { label: 'Aggressiveness', value: parsedAgent.parsed.params.aggressiveness, icon: '⚔️' },
                                { label: 'Risk Tolerance', value: parsedAgent.parsed.params.riskTolerance, icon: '🎲' },
                                { label: 'Alliance Tendency', value: parsedAgent.parsed.params.allianceTendency, icon: '🤝' },
                                { label: 'Betrayal Chance', value: parsedAgent.parsed.params.betrayalChance, icon: '🗡️' },
                            ].map(p => (
                                <div key={p.label} className="mc-param-item">
                                    <div className="mc-param-header">
                                        <span>{p.icon} {p.label}</span>
                                        <span className="mc-param-value">{p.value}%</span>
                                    </div>
                                    <div className="mc-param-bar">
                                        <div className="mc-param-fill" style={{ width: `${p.value}%` }} />
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="mc-params-meta">
                            <span>💰 Bribery: <strong>{parsedAgent.parsed.params.briberyPolicy}</strong></span>
                            <span>🎯 Profit Target: <strong>{parsedAgent.parsed.params.profitTarget} MON</strong></span>
                        </div>

                        {/* Agent Wallet Address */}
                        <div style={{
                            background: 'var(--bg-tertiary)', padding: '1rem',
                            borderRadius: 'var(--border-radius-sm)', marginTop: '1.5rem',
                            border: '1px solid var(--accent-gold, #ffd700)'
                        }}>
                            <p className="mc-label" style={{ marginBottom: '0.25rem' }}>💳 Agent Wallet Address</p>
                            <code style={{
                                color: 'var(--accent-gold)', fontSize: '0.8rem',
                                fontFamily: 'var(--font-mono)', wordBreak: 'break-all', display: 'block',
                            }}>
                                {parsedAgent.agentWalletAddress}
                            </code>
                            <button
                                onClick={() => navigator.clipboard.writeText(parsedAgent.agentWalletAddress)}
                                className="mc-btn mc-btn-secondary"
                                style={{ marginTop: '0.5rem', fontSize: '0.75rem', padding: '0.3rem 0.75rem' }}
                            >
                                📋 Copy
                            </button>
                        </div>
                    </div>

                    {/* Transaction Status */}
                    {txStep && (
                        <div className="mc-card" style={{
                            padding: '1rem 1.5rem', marginBottom: '1rem',
                            border: txStep === 'done' ? '1px solid #22c55e' : '1px solid var(--accent-orange)',
                            background: txStep === 'done' ? 'rgba(34,197,94,0.05)' : 'rgba(234,179,8,0.05)',
                        }}>
                            <p style={{ color: txStep === 'done' ? '#22c55e' : 'var(--accent-orange)', fontWeight: 600 }}>
                                {txStep === 'signing' && '✍️ Waiting for signature in MetaMask...'}
                                {txStep === 'confirming' && '⏳ Transaction is being confirmed...'}
                                {txStep === 'done' && '✅ Transaction confirmed!'}
                            </p>
                            {txHash && (
                                <a
                                    href={`https://testnet.monadvision.com/tx/${txHash}`}
                                    target="_blank" rel="noreferrer"
                                    style={{ color: 'var(--accent-cyan)', fontSize: '0.8rem', fontFamily: 'var(--font-mono)' }}
                                >
                                    TX: {txHash.slice(0, 12)}...{txHash.slice(-8)}
                                </a>
                            )}
                        </div>
                    )}

                    {error && <div className="mc-error" style={{ marginBottom: '1rem' }}>{error}</div>}

                    {/* Confirm Button */}
                    {!txStep && (
                        <div style={{ display: 'flex', gap: '1rem' }}>
                            <button
                                onClick={() => { setParsedAgent(null); setDescription(''); }}
                                className="mc-btn mc-btn-secondary"
                                style={{ flex: 1 }}
                            >
                                ← Edit
                            </button>
                            <button
                                onClick={confirmAndRegisterOnchain}
                                disabled={isSigning || isConfirming}
                                className="mc-btn mc-btn-primary"
                                style={{ flex: 2 }}
                            >
                                ✅ Confirm & Register (MetaMask)
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* Confirmed — Show wallet + success */}
            {confirmedAgent && (
                <div>
                    <div className="mc-card mc-card-success" style={{ padding: '2rem', marginBottom: '1.5rem' }}>
                        <p className="mc-text-success" style={{ fontSize: '1.2rem', marginBottom: '1rem', textAlign: 'center' }}>
                            ✅ {confirmedAgent.parsed.name} created successfully!
                        </p>

                        {/* Agent Wallet Address */}
                        <div style={{
                            background: 'var(--bg-tertiary)', padding: '1.25rem',
                            borderRadius: 'var(--border-radius-sm)', marginBottom: '1.5rem',
                            border: '1px solid var(--accent-gold, #ffd700)'
                        }}>
                            <p className="mc-label" style={{ marginBottom: '0.5rem' }}>💳 Agent Wallet Address</p>
                            <code style={{
                                color: 'var(--accent-gold)', fontSize: '0.85rem',
                                fontFamily: 'var(--font-mono)', wordBreak: 'break-all',
                                display: 'block',
                            }}>
                                {confirmedAgent.agentWalletAddress}
                            </code>
                            <p className="mc-text-muted" style={{ marginTop: '0.75rem', fontSize: '0.8rem' }}>
                                Send MON to this address to fund your agent.
                                The agent will use this wallet for arena entry fees and battle transactions.
                            </p>
                            <button
                                onClick={() => navigator.clipboard.writeText(confirmedAgent.agentWalletAddress)}
                                className="mc-btn mc-btn-secondary"
                                style={{ marginTop: '0.75rem', fontSize: '0.8rem', padding: '0.4rem 1rem' }}
                            >
                                📋 Copy Address
                            </button>
                        </div>

                        {/* Onchain TX */}
                        {confirmedAgent.onchainTxHash && (
                            <div style={{ marginBottom: '1rem', fontSize: '0.8rem' }}>
                                <span className="mc-text-muted">Onchain TX: </span>
                                <a
                                    href={`https://testnet.monadvision.com/tx/${confirmedAgent.onchainTxHash}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    style={{ color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}
                                >
                                    {confirmedAgent.onchainTxHash.slice(0, 10)}...{confirmedAgent.onchainTxHash.slice(-8)}
                                </a>
                            </div>
                        )}

                        <div style={{ textAlign: 'center', marginTop: '1rem' }}>
                            <p className="mc-text-secondary">
                                Now go to "My Agents" page to activate your agent.
                                The agent will automatically select arenas based on its risk tolerance.
                            </p>
                        </div>
                    </div>

                    <button
                        onClick={() => { setParsedAgent(null); setConfirmedAgent(null); setDescription(''); setTxStep(''); }}
                        className="mc-btn mc-btn-secondary"
                        style={{ width: '100%', marginTop: '1rem' }}
                    >
                        Create New Agent
                    </button>
                </div>
            )}
        </div>
    )
}

// Arenas Page — Spectate Only (agents auto-select arenas)
function ArenasPage({ onNavigate }) {
    const { isConnected } = useAccount()
    const [arenas, setArenas] = useState([])
    const [gameTypeFilter, setGameTypeFilter] = useState('all') // 'all' | 'battle' | 'rps'

    useEffect(() => {
        const fetchArenas = () => {
            fetch(`${BACKEND_URL}/api/arenas`)
                .then(res => res.json())
                .then(data => { if (data.ok) setArenas(data.arenas) })
                .catch(() => { })
        }
        fetchArenas()
        const interval = setInterval(fetchArenas, 3000) // refresh every 3s
        return () => clearInterval(interval)
    }, [])

    // Filter arenas by game type
    const filteredArenas = gameTypeFilter === 'all'
        ? arenas
        : arenas.filter(a => a.gameType === gameTypeFilter)

    // Sort: in_progress first, then lobby, then open
    const sortedArenas = [...filteredArenas].sort((a, b) => {
        const order = { in_progress: 0, lobby: 1, open: 2, completed: 3 }
        return (order[a.status] ?? 9) - (order[b.status] ?? 9)
    })

    const statusBadge = (status, gameType) => {
        const configs = {
            in_progress: { bg: 'rgba(239,68,68,0.2)', color: '#ef4444', icon: '🔴', label: gameType === 'rps' ? 'RPS In Progress' : 'In Battle' },
            lobby: { bg: 'rgba(245,158,11,0.2)', color: '#f59e0b', icon: '⏳', label: 'Lobby' },
            open: { bg: 'rgba(34,197,94,0.2)', color: '#22c55e', icon: '🟢', label: 'Waiting' },
            completed: { bg: 'rgba(107,114,128,0.2)', color: '#6b7280', icon: '✅', label: 'Completed' },
        }
        const c = configs[status] || configs.open
        return (
            <span style={{
                padding: '0.2rem 0.6rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 700,
                background: c.bg, color: c.color, display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
            }}>
                {c.icon} {c.label}
            </span>
        )
    }

    const inProgressCount = arenas.filter(a => a.status === 'in_progress').length
    const lobbyCount = arenas.filter(a => a.status === 'lobby').length
    const openCount = arenas.filter(a => a.status === 'open').length

    return (
        <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '1rem' }}>
            <h1 className="mc-title" style={{ fontSize: '1.75rem', marginBottom: '0.5rem' }}>🏟️ Live Arenas</h1>
            <p className="mc-text-secondary" style={{ marginBottom: '1rem' }}>
                Real-time arena status. Agents autonomously join and battle.
            </p>

            {/* Stats Bar */}
            <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
                <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '8px', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ color: '#ef4444', fontWeight: 700, fontFamily: 'var(--font-mono)', fontSize: '1.25rem' }}>{inProgressCount}</span>
                    <span className="mc-text-muted" style={{ fontSize: '0.8rem' }}>In Battle</span>
                </div>
                <div style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: '8px', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ color: '#f59e0b', fontWeight: 700, fontFamily: 'var(--font-mono)', fontSize: '1.25rem' }}>{lobbyCount}</span>
                    <span className="mc-text-muted" style={{ fontSize: '0.8rem' }}>In Lobby</span>
                </div>
                <div style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', borderRadius: '8px', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ color: '#22c55e', fontWeight: 700, fontFamily: 'var(--font-mono)', fontSize: '1.25rem' }}>{openCount}</span>
                    <span className="mc-text-muted" style={{ fontSize: '0.8rem' }}>Waiting</span>
                </div>
            </div>

            {/* Game Type Filter Tabs */}
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
                {[
                    { key: 'all', label: '🎯 All' },
                    { key: 'battle', label: '⚔️ Battle' },
                    { key: 'rps', label: '✊ RPS' },
                ].map(tab => (
                    <button
                        key={tab.key}
                        onClick={() => setGameTypeFilter(tab.key)}
                        style={{
                            padding: '0.5rem 1.25rem',
                            borderRadius: 'var(--border-radius-sm)',
                            border: gameTypeFilter === tab.key ? '1px solid var(--accent-orange)' : '1px solid var(--border-primary)',
                            background: gameTypeFilter === tab.key ? 'var(--accent-orange-dim)' : 'transparent',
                            color: gameTypeFilter === tab.key ? 'var(--accent-orange)' : 'var(--text-secondary)',
                            cursor: 'pointer',
                            fontWeight: gameTypeFilter === tab.key ? 700 : 400,
                            fontSize: '0.9rem',
                            transition: 'all 0.2s ease',
                        }}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* Arena Cards Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '1rem' }}>
                {sortedArenas.map(arena => {
                    const tierColors = { bronze: '#CD7F32', silver: '#C0C0C0', gold: '#FFD700', platinum: '#E5E4E2', diamond: '#B9F2FF' }
                    const tierColor = tierColors[arena.tier] || 'var(--accent-blue)'
                    const isLive = arena.status === 'in_progress'
                    const isLobby = arena.status === 'lobby'

                    return (
                        <div key={arena.arenaId} className="agent-card" style={{
                            padding: '1.25rem',
                            borderTop: `3px solid ${isLive ? '#ef4444' : tierColor}`,
                            position: 'relative',
                            animation: isLive ? 'pulse 2s ease-in-out infinite' : 'none',
                        }}>
                            {/* Top Row: Status + Tier */}
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                                {statusBadge(arena.status, arena.gameType)}
                                <span style={{
                                    background: tierColor, color: arena.tier === 'silver' || arena.tier === 'gold' || arena.tier === 'platinum' ? '#000' : '#fff',
                                    padding: '0.15rem 0.5rem', borderRadius: '4px',
                                    fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase',
                                }}>
                                    {arena.tier || 'custom'}
                                </span>
                            </div>

                            {/* Arena Name */}
                            <h3 style={{ fontWeight: 700, fontSize: '1rem', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>
                                {arena.gameType === 'rps' ? '✊' : '⚔️'} {arena.name}
                            </h3>

                            {/* Agents Progress */}
                            <div style={{ marginBottom: '0.75rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '0.3rem' }}>
                                    <span className="mc-text-muted">Agents</span>
                                    <span style={{ color: arena.agentCount > 0 ? 'var(--accent-orange)' : 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                                        {arena.agentCount} / {arena.maxAgents}
                                    </span>
                                </div>
                                <div style={{ background: 'var(--bg-tertiary)', borderRadius: '4px', height: '6px', overflow: 'hidden' }}>
                                    <div style={{
                                        width: `${(arena.agentCount / arena.maxAgents) * 100}%`,
                                        height: '100%',
                                        borderRadius: '4px',
                                        background: isLive ? '#ef4444' : isLobby ? '#f59e0b' : '#22c55e',
                                        transition: 'width 0.3s ease',
                                    }} />
                                </div>
                            </div>

                            {/* Agent Names (if any) */}
                            {arena.agents && arena.agents.length > 0 && (
                                <div style={{ marginBottom: '0.75rem', display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                                    {arena.agents.map(a => (
                                        <span key={a.id} style={{
                                            padding: '0.1rem 0.4rem', borderRadius: '3px', fontSize: '0.65rem',
                                            background: 'var(--bg-tertiary)', color: 'var(--text-secondary)',
                                            border: '1px solid var(--border-primary)',
                                        }}>
                                            {a.name}
                                        </span>
                                    ))}
                                </div>
                            )}

                            {/* Fee + Prize */}
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.75rem' }}>
                                <div style={{ background: 'var(--bg-tertiary)', borderRadius: '6px', padding: '0.5rem', textAlign: 'center' }}>
                                    <p className="mc-text-muted" style={{ fontSize: '0.65rem', margin: '0 0 0.15rem' }}>Entry Fee</p>
                                    <p style={{ color: 'var(--text-primary)', fontWeight: 700, fontFamily: 'var(--font-mono)', fontSize: '0.9rem', margin: 0 }}>{arena.entryFee} MON</p>
                                </div>
                                <div style={{ background: 'var(--bg-tertiary)', borderRadius: '6px', padding: '0.5rem', textAlign: 'center' }}>
                                    <p className="mc-text-muted" style={{ fontSize: '0.65rem', margin: '0 0 0.15rem' }}>Prize Pool</p>
                                    <p style={{ color: 'var(--accent-gold)', fontWeight: 700, fontFamily: 'var(--font-mono)', fontSize: '0.9rem', margin: 0 }}>{arena.prizePool} MON</p>
                                </div>
                            </div>

                            {/* Action Button */}
                            {isLive ? (
                                <button
                                    onClick={() => onNavigate && onNavigate('spectate')}
                                    className="mc-btn-primary"
                                    style={{ width: '100%', background: '#ef4444', borderColor: '#ef4444' }}
                                >
                                    📺 Watch Live
                                </button>
                            ) : isLobby ? (
                                <div style={{ textAlign: 'center', padding: '0.5rem', color: '#f59e0b', fontSize: '0.8rem', fontWeight: 600 }}>
                                    ⏳ Waiting for more agents... ({arena.agentCount}/{arena.minAgents} min)
                                </div>
                            ) : arena.status === 'completed' ? (
                                <div style={{ textAlign: 'center', padding: '0.5rem', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                                    ✅ Match completed
                                </div>
                            ) : (
                                <div style={{ textAlign: 'center', padding: '0.5rem', color: '#22c55e', fontSize: '0.8rem' }}>
                                    🟢 Waiting for agents
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>

            {sortedArenas.length === 0 && (
                <div className="mc-card" style={{ textAlign: 'center', padding: '3rem' }}>
                    <p className="mc-text-muted">No arenas found. The server might not be running.</p>
                </div>
            )}
        </div>
    )
}

// Leaderboard Page
function LeaderboardPage() {
    const [entries, setEntries] = useState([])
    const [sortBy, setSortBy] = useState('elo')
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        setLoading(true)
        fetch(`${BACKEND_URL}/api/leaderboard?sort=${sortBy}&limit=50`)
            .then(res => res.json())
            .then(data => {
                if (data.ok) setEntries(data.leaderboard)
            })
            .catch(() => { })
            .finally(() => setLoading(false))
    }, [sortBy])

    const sortOptions = [
        { key: 'elo', label: '🏆 ELO', icon: '🏆' },
        { key: 'wins', label: '⚔️ Wins', icon: '⚔️' },
        { key: 'earnings', label: '💰 Earnings', icon: '💰' },
        { key: 'betrayals', label: '🗡️ Betrayals', icon: '🗡️' },
        { key: 'streak', label: '🔥 Streak', icon: '🔥' },
    ]

    const getRankBadge = (index) => {
        if (index === 0) return '🥇'
        if (index === 1) return '🥈'
        if (index === 2) return '🥉'
        return `#${index + 1}`
    }

    const getEloColor = (elo) => {
        if (elo >= 1500) return '#FFD700'
        if (elo >= 1200) return '#C0C0C0'
        if (elo >= 1000) return '#CD7F32'
        return 'var(--text-secondary)'
    }

    return (
        <div style={{ maxWidth: '1000px', margin: '0 auto', padding: '1rem' }}>
            <h1 className="mc-title" style={{ fontSize: '1.75rem', marginBottom: '2rem' }}>
                🏆 Leaderboard
            </h1>

            {/* Sort Tabs */}
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '2rem', flexWrap: 'wrap' }}>
                {sortOptions.map(opt => (
                    <button
                        key={opt.key}
                        onClick={() => setSortBy(opt.key)}
                        className={sortBy === opt.key ? 'mc-btn-primary' : 'mc-btn-secondary'}
                        style={{ padding: '0.45rem 1rem', fontSize: '0.82rem' }}
                    >
                        {opt.label}
                    </button>
                ))}
            </div>

            {loading ? (
                <SkeletonList count={8} height="60px" />
            ) : entries.length === 0 ? (
                <div className="mc-card" style={{ padding: '3rem', textAlign: 'center' }}>
                    <p className="mc-text-secondary" style={{ fontSize: '1.1rem' }}>
                        No ranking data yet. Battle in the arenas to climb the leaderboard!
                    </p>
                </div>
            ) : (
                <div className="mc-card" style={{ padding: '0', overflow: 'hidden' }}>
                    <table>
                        <thead>
                            <tr>
                                <th style={{ textAlign: 'center', width: '60px' }}>Rank</th>
                                <th>Agent</th>
                                <th style={{ textAlign: 'center' }}>ELO</th>
                                <th style={{ textAlign: 'center' }}>W/L</th>
                                <th style={{ textAlign: 'center' }}>Earnings</th>
                                <th style={{ textAlign: 'center' }}>Betrayals</th>
                                <th style={{ textAlign: 'center' }}>Streak</th>
                            </tr>
                        </thead>
                        <tbody>
                            {entries.map((entry, i) => (
                                <tr key={entry.agentId}>
                                    <td style={{ textAlign: 'center', fontSize: '1.1rem' }}>
                                        {getRankBadge(i)}
                                    </td>
                                    <td>
                                        <div>
                                            <span style={{ fontWeight: 600 }}>{entry.name}</span>
                                            {entry.traits && (
                                                <span className="mc-text-muted" style={{ marginLeft: '0.5rem', fontSize: '0.75rem' }}>
                                                    {entry.traits}
                                                </span>
                                            )}
                                        </div>
                                        {entry.owner && (
                                            <span className="mc-text-muted" style={{ fontSize: '0.7rem', fontFamily: 'var(--font-mono)' }}>
                                                {entry.owner.slice(0, 6)}...{entry.owner.slice(-4)}
                                            </span>
                                        )}
                                    </td>
                                    <td style={{
                                        textAlign: 'center',
                                        fontWeight: 700, color: getEloColor(entry.elo),
                                        fontFamily: 'var(--font-mono)'
                                    }}>
                                        {entry.elo}
                                    </td>
                                    <td style={{ textAlign: 'center', fontFamily: 'var(--font-mono)' }}>
                                        <span style={{ color: 'var(--accent-green)' }}>{entry.wins}</span>
                                        <span className="mc-text-muted">/</span>
                                        <span style={{ color: 'var(--accent-red)' }}>{entry.losses}</span>
                                    </td>
                                    <td style={{ textAlign: 'center', color: 'var(--accent-gold)', fontFamily: 'var(--font-mono)' }}>
                                        {entry.earnings > 0 ? `${entry.earnings} MON` : '-'}
                                    </td>
                                    <td style={{ textAlign: 'center', color: entry.betrayals > 0 ? 'var(--accent-red)' : 'var(--text-muted)' }}>
                                        {entry.betrayals || '-'}
                                    </td>
                                    <td style={{ textAlign: 'center' }}>
                                        {entry.maxStreak > 0 ? (
                                            <span style={{ color: 'var(--accent-gold)' }}>🔥 {entry.maxStreak}</span>
                                        ) : '-'}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    )
}

// MyAgentsPage is now in ./pages/MyAgents.jsx and imported at the top.