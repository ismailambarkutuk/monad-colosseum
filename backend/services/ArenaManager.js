/**
 * Monad Colosseum - Arena Manager
 *
 * Manages arena lifecycle: creation, queueing agents,
 * launching matches via GameEngine, and tracking results.
 */

const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');

const ARENA_DEFAULTS = {
  MIN_AGENTS: 2,
  MAX_AGENTS: 8,
  ENTRY_FEE: 100,
  COUNTDOWN_MS: 15000,    // 15s lobby countdown
  MAX_TURNS: 100,         // force-end after 100 turns
};

// ─── Tier Definitions (matches frontend & smart contract) ──────────────
const TIER_CONFIG = {
  bronze:   { name: '🥉 Bronze Arena',    entryFee: 0.1,  maxAgents: 8,  minAgents: 2, color: '#CD7F32' },
  silver:   { name: '🥈 Silver Arena',    entryFee: 0.3,  maxAgents: 6,  minAgents: 2, color: '#C0C0C0' },
  gold:     { name: '🥇 Gold Arena',       entryFee: 0.5,  maxAgents: 4,  minAgents: 2, color: '#FFD700' },
  platinum: { name: '💎 Platinum Arena',   entryFee: 1,    maxAgents: 4,  minAgents: 2, color: '#E5E4E2' },
  diamond:  { name: '💠 Diamond Arena',    entryFee: 2,    maxAgents: 2,  minAgents: 2, color: '#B9F2FF' },
};

class ArenaManager extends EventEmitter {
  /**
   * @param {import('./GameEngine').GameEngine} gameEngine
   * @param {object} [config]
   */
  constructor(gameEngine, config = {}) {
    super();
    this.engine = gameEngine;
    this.config = { ...ARENA_DEFAULTS, ...config };
    this.arenas = new Map();     // arenaId → arena
    this.lobbies = new Map();    // arenaId → { agents[], timer }
    this.results = new Map();    // matchId → result

    // Auto-create one arena per tier on startup
    this._initTierPools();
  }

  /**
   * Create one open arena per tier so there's always something to join.
   * Creates both battle and RPS arenas for each tier.
   */
  _initTierPools() {
    try {
      for (const [tier, cfg] of Object.entries(TIER_CONFIG)) {
        // Battle arena
        const existingBattle = [...this.arenas.values()].find(a => a.tier === tier && a.gameType === 'battle' && a.status === 'open');
        if (!existingBattle) {
          this.createArena({ tier, name: cfg.name, entryFee: cfg.entryFee, maxAgents: cfg.maxAgents, minAgents: cfg.minAgents, gameType: 'battle' });
        }
        // RPS arena (always 2 players)
        const existingRps = [...this.arenas.values()].find(a => a.tier === tier && a.gameType === 'rps' && a.status === 'open');
        if (!existingRps) {
          this.createArena({ tier, name: `✊ ${cfg.name.replace(/[^\w\s]/g, '').trim()} RPS`, entryFee: cfg.entryFee, maxAgents: 2, minAgents: 2, gameType: 'rps' });
        }
      }
      console.log(`[ArenaManager] ✅ Tier pools initialized: ${this.arenas.size} arenas`);
    } catch (err) {
      console.error('[ArenaManager] ❌ _initTierPools error:', err.message);
    }
  }

  // ─── Arena CRUD ────────────────────────────────────────────────────────

  createArena(options = {}) {
    // Resolve tier config if tier specified
    const tierCfg = options.tier ? TIER_CONFIG[options.tier] : null;

    const arena = {
      arenaId: options.arenaId || `arena_${uuidv4().slice(0, 8)}`,
      name: options.name || tierCfg?.name || 'Unnamed Arena',
      tier: options.tier || null,
      gameType: options.gameType || 'battle', // 'battle' | 'rps'
      entryFee: options.entryFee ?? tierCfg?.entryFee ?? this.config.ENTRY_FEE,
      maxAgents: options.maxAgents ?? tierCfg?.maxAgents ?? this.config.MAX_AGENTS,
      minAgents: options.minAgents ?? tierCfg?.minAgents ?? this.config.MIN_AGENTS,
      prizePool: 0,
      status: 'open',       // open → lobby → in_progress → completed
      createdAt: new Date(),
      matchId: null,
    };
    this.arenas.set(arena.arenaId, arena);
    this.lobbies.set(arena.arenaId, { agents: [], timer: null });
    this.emit('arenaCreated', arena);
    return arena;
  }

  getArena(arenaId) {
    return this.arenas.get(arenaId) || null;
  }

  listArenas(statusFilter, gameTypeFilter) {
    let all = [...this.arenas.values()];
    if (statusFilter) all = all.filter((a) => a.status === statusFilter);
    if (gameTypeFilter) all = all.filter((a) => a.gameType === gameTypeFilter);
    return all;
  }

  // ─── Agent Queueing ───────────────────────────────────────────────────

  joinArena(arenaId, agent) {
    const arena = this.arenas.get(arenaId);
    if (!arena) throw new Error(`Arena ${arenaId} not found`);
    if (arena.status !== 'open' && arena.status !== 'lobby') {
      throw new Error(`Arena ${arenaId} is not accepting agents (status: ${arena.status})`);
    }

    const lobby = this.lobbies.get(arenaId);
    if (lobby.agents.find((a) => a.id === agent.id)) {
      throw new Error(`Agent ${agent.id} already in arena ${arenaId}`);
    }
    if (lobby.agents.length >= arena.maxAgents) {
      throw new Error(`Arena ${arenaId} is full`);
    }

    lobby.agents.push(agent);

    // External agents join fee-free; normal agents contribute to prize pool
    const isExternal = agent.isExternal === true || (agent.id && agent.id.startsWith('ext_'));
    if (!isExternal) {
      arena.prizePool += arena.entryFee;
    }

    console.log(`[ARENA] ${agent.name || agent.id} joined ${arena.name} (${arena.arenaId}) | lobby: ${lobby.agents.length}/${arena.maxAgents} | min: ${arena.minAgents} | gameType: ${arena.gameType}`);

    this.emit('agentJoined', { arenaId, agentId: agent.id, lobbySize: lobby.agents.length, isExternal });

    // Auto-start when full (maxAgents reached)
    if (lobby.agents.length >= arena.maxAgents) {
      this._cancelCountdown(arenaId);
      console.log(`[MATCH] Arena full — starting match in ${arena.arenaId} with ${lobby.agents.length} agents (gameType: ${arena.gameType})`);
      this._launchMatch(arenaId);
    }
    // Start countdown when minimum reached (but not full yet)
    else if (lobby.agents.length >= arena.minAgents && arena.status === 'open') {
      arena.status = 'lobby';
      console.log(`[ARENA] Min agents reached for ${arena.arenaId} (${lobby.agents.length}/${arena.minAgents}) — starting countdown`);
      this._startCountdown(arenaId);
    }

    return { arenaId, lobbySize: lobby.agents.length, status: arena.status };
  }

  leaveArena(arenaId, agentId) {
    const arena = this.arenas.get(arenaId);
    if (!arena) throw new Error(`Arena ${arenaId} not found`);
    if (arena.status === 'in_progress') throw new Error('Cannot leave during a match');

    const lobby = this.lobbies.get(arenaId);
    const idx = lobby.agents.findIndex((a) => a.id === agentId);
    if (idx === -1) throw new Error(`Agent ${agentId} not in arena`);

    lobby.agents.splice(idx, 1);
    arena.prizePool = Math.max(0, arena.prizePool - arena.entryFee);

    // Reset to open if below minimum
    if (lobby.agents.length < arena.minAgents && arena.status === 'lobby') {
      arena.status = 'open';
      this._cancelCountdown(arenaId);
    }

    this.emit('agentLeft', { arenaId, agentId, lobbySize: lobby.agents.length });
    return { arenaId, lobbySize: lobby.agents.length };
  }

  // ─── Match Launching ──────────────────────────────────────────────────

  async _launchMatch(arenaId) {
    const arena = this.arenas.get(arenaId);
    const lobby = this.lobbies.get(arenaId);
    if (!arena || !lobby) return;

    console.log(`[MATCH] Starting match in arena ${arena.arenaId} with ${lobby.agents.length} agents (gameType: ${arena.gameType})`);
    arena.status = 'in_progress';
    this.emit('matchLaunching', { arenaId, agentCount: lobby.agents.length });

    try {
      let match, result;

      if (arena.gameType === 'rps') {
        // RPS match: best-of-3 rounds
        match = await this.engine.startRpsMatch(
          { arenaId, prizePool: arena.prizePool },
          lobby.agents,
        );
        arena.matchId = match.matchId;
        result = await this._runRpsMatch(match);
      } else {
        // Classic battle match
        match = await this.engine.startMatch(
          { arenaId, prizePool: arena.prizePool },
          lobby.agents,
        );
        arena.matchId = match.matchId;
        result = await this._runMatch(match);
      }
      arena.status = 'completed';
      this.results.set(match.matchId, result);
      this.emit('matchCompleted', { arenaId, matchId: match.matchId, result });

      // Auto-replenish: create a new arena for this tier + gameType
      if (arena.tier && TIER_CONFIG[arena.tier]) {
        const cfg = TIER_CONFIG[arena.tier];
        if (arena.gameType === 'rps') {
          this.createArena({ tier: arena.tier, name: `✊ ${cfg.name.replace(/[^\w\s]/g, '').trim()} RPS`, entryFee: cfg.entryFee, maxAgents: 2, minAgents: 2, gameType: 'rps' });
        } else {
          this.createArena({ tier: arena.tier, name: cfg.name, entryFee: cfg.entryFee, maxAgents: cfg.maxAgents, minAgents: cfg.minAgents, gameType: 'battle' });
        }
      }

      return result;
    } catch (err) {
      console.error(`[MATCH] ❌ Match error in arena ${arenaId}:`, err.message);
      arena.status = 'error';
      this.emit('matchError', { arenaId, error: err.message });
      // Don't rethrow — prevent crash
    }
  }

  async _runMatch(match) {
    let turnCount = 0;
    while (match.status === 'active' && turnCount < this.config.MAX_TURNS) {
      const turnResult = await this.engine.executeTurn(match);
      this.emit('turnCompleted', {
        matchId: match.matchId,
        turn: turnResult.turn,
        events: turnResult.events,
      });
      turnCount++;
    }

    // Force-end if max turns reached
    if (match.status === 'active') {
      match.status = 'completed';
      match.endedAt = new Date();
      const alive = this.engine.getAliveAgents(match);
      // Most HP wins
      const winner = alive.sort((a, b) => b.hp - a.hp)[0] || null;
      if (winner) {
        this.engine.distributePrize(match, winner);
      }
    }

    return {
      matchId: match.matchId,
      totalTurns: match.history.length,
      winner: match.agents.find((a) => a.alive) || null,
      status: match.status,
    };
  }

  /**
   * Run a best-of-3 RPS match to completion.
   */
  async _runRpsMatch(match) {
    const maxRounds = match.bestOf + 2; // allow extra rounds for draws
    let roundCount = 0;

    while (match.status === 'active' && roundCount < maxRounds) {
      const roundResult = await this.engine.executeRpsRound(match);
      this.emit('turnCompleted', {
        matchId: match.matchId,
        turn: roundResult.round,
        events: roundResult.events,
        gameType: 'rps',
      });
      roundCount++;
    }

    // Determine winner if still active after max rounds (shouldn't happen normally)
    if (match.status === 'active') {
      match.status = 'completed';
      match.endedAt = new Date();
      const [a, b] = match.agents;
      const winner = a.roundsWon > b.roundsWon ? a : (b.roundsWon > a.roundsWon ? b : null);
      if (winner) {
        this.engine.distributePrize(match, winner);
      }
    }

    const [a, b] = match.agents;
    const winner = a.roundsWon > b.roundsWon ? a : (b.roundsWon > a.roundsWon ? b : null);

    return {
      matchId: match.matchId,
      gameType: 'rps',
      totalRounds: match.history.length,
      finalScore: { [a.id]: a.roundsWon, [b.id]: b.roundsWon },
      winner: winner || null,
      status: match.status,
    };
  }

  // ─── Countdown Timer ──────────────────────────────────────────────────

  _startCountdown(arenaId) {
    const lobby = this.lobbies.get(arenaId);
    if (lobby.timer) return;

    this.emit('countdownStarted', { arenaId, duration: this.config.COUNTDOWN_MS });

    lobby.timer = setTimeout(() => {
      lobby.timer = null;
      this._launchMatch(arenaId);
    }, this.config.COUNTDOWN_MS);
  }

  _cancelCountdown(arenaId) {
    const lobby = this.lobbies.get(arenaId);
    if (lobby && lobby.timer) {
      clearTimeout(lobby.timer);
      lobby.timer = null;
    }
  }

  // ─── Queries ──────────────────────────────────────────────────────────

  getLobby(arenaId) {
    const lobby = this.lobbies.get(arenaId);
    if (!lobby) return null;
    return {
      arenaId,
      agents: lobby.agents.map((a) => ({ id: a.id, name: a.name || a.id, owner: a.owner })),
      count: lobby.agents.length,
    };
  }

  /**
   * Check if an agent is currently in any arena lobby or active match.
   */
  isAgentInArena(agentId) {
    for (const [, lobby] of this.lobbies) {
      if (lobby.agents.some(a => a.id === agentId)) return true;
    }
    return false;
  }

  getResult(matchId) {
    return this.results.get(matchId) || null;
  }
}

module.exports = { ArenaManager, ARENA_DEFAULTS, TIER_CONFIG };
