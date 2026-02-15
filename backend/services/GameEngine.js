/**
 * Monad Colosseum - Game Engine
 *
 * Manages match lifecycle, turn execution, combat resolution,
 * alliance mechanics, and prize distribution.
 *
 * Each agent makes REAL AI decisions via Claude API every turn.
 * Fallback to strategies.js if Claude is unavailable or times out.
 */

const crypto = require('crypto');
const EventEmitter = require('events');

// ─── Constants ───────────────────────────────────────────────────────────────
const DEFAULTS = {
  STARTING_HP: 100,
  MAX_HP: 105,
  ATTACK_DAMAGE: 20,
  DEFENDED_DAMAGE: 10,
  HP_RECOVERY: 5,
  DECISION_TIMEOUT: 30000, // 30 seconds
  AI_DECISION_TIMEOUT: 3000, // 3s for Claude API call
  MIN_AGENTS: 2,
  MAX_AGENTS: 16,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function uid(prefix = '') {
  return `${prefix}${crypto.randomBytes(8).toString('hex')}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// ─── GameEngine ──────────────────────────────────────────────────────────────
class GameEngine extends EventEmitter {
  /**
   * @param {object} [config] - Override default parameters
   */
  constructor(config = {}) {
    super();
    this.config = { ...DEFAULTS, ...config };
    this.matches = new Map();          // matchId → match
    this.pendingProposals = new Map();  // matchId → [proposal, …]
    this.anthropicApiKey = config.anthropicApiKey || process.env.ANTHROPIC_API_KEY || null;
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Match Lifecycle
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Initialise and return a new match.
   *
   * @param {object} arena   - { arenaId, prizePool, … }
   * @param {Array}  agents  - Array of raw agent descriptors
   * @returns {object} match
   */
  async startMatch(arena, agents) {
    if (!agents || agents.length < this.config.MIN_AGENTS) {
      throw new Error(`At least ${this.config.MIN_AGENTS} agents are required to start a match`);
    }
    if (agents.length > this.config.MAX_AGENTS) {
      throw new Error(`Maximum ${this.config.MAX_AGENTS} agents allowed per match`);
    }

    const matchAgents = agents.map((a) => {
      // Resolve active buffs (from agent.buffs if available)
      const buffs = a.buffs || { health: 0, armor: 0, attack: 0, speed: 0 };
      const hpBuff = Math.floor((buffs.health || 0) / 10); // 100 pts → +10 HP

      return {
        id: a.id || uid('agent_'),
        name: a.name || 'Unknown',
        owner: a.owner || null,
        wallet: a.wallet || null,
        hp: this.config.STARTING_HP + hpBuff,
        alive: true,
        strategyCode: a.strategyCode || {},
        strategyParams: a.strategyParams || {},
        strategyDescription: a.strategyDescription || '',
        traits: a.traits || [],
        lastAction: null,
        turnsAlive: 0,
        _buffs: buffs, // carry buffs through the match
      };
    });

    const match = {
      matchId: uid('match_'),
      arenaId: arena.arenaId || uid('arena_'),
      agents: matchAgents,
      prizePool: arena.prizePool || 0,
      currentTurn: 1,
      status: 'active',
      activeAlliances: [],
      history: [],
      createdAt: new Date(),
      endedAt: null,
    };

    this.matches.set(match.matchId, match);
    this.pendingProposals.set(match.matchId, []);
    this.emit('matchStarted', { matchId: match.matchId, agentCount: matchAgents.length });

    return match;
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Turn Execution  (the heart of the engine)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Execute a single turn for the given match.
   *
   * Turn order:
   *   1. Mark defences
   *   2. Queue alliance proposals
   *   3. Process accept / reject
   *   4. Apply attacks
   *   5. Process betrayals
   *   6. HP recovery (+5)
   *   7. Mark dead agents
   *   8. Check match end
   *
   * @param {object} match
   * @returns {object} turnResult
   */
  async executeTurn(match) {
    if (match.status !== 'active') {
      throw new Error(`Match ${match.matchId} is not active (status: ${match.status})`);
    }

    // Collect decisions from all alive agents
    const decisions = await this.collectDecisions(match);

    const turnRecord = {
      turn: match.currentTurn,
      decisions: { ...decisions },
      events: [],
    };

    // 1. Mark defences
    const defending = new Set();
    for (const [agentId, dec] of Object.entries(decisions)) {
      if (dec && dec.action === 'defend') {
        defending.add(agentId);
        turnRecord.events.push({ type: 'defend', agentId });
      }
    }

    // 2. Queue alliance proposals
    for (const [agentId, dec] of Object.entries(decisions)) {
      if (dec && dec.action === 'propose_alliance') {
        this._queueProposal(match, agentId, dec);
        turnRecord.events.push({
          type: 'propose_alliance',
          from: agentId,
          to: dec.target,
          terms: dec.terms,
        });
      }
    }

    // 3. Process bribe offers
    for (const [agentId, dec] of Object.entries(decisions)) {
      if (dec && dec.action === 'bribe') {
        const bribeResult = this._processBribe(match, agentId, dec);
        if (bribeResult) {
          turnRecord.events.push({ type: 'bribe', ...bribeResult });
        }
      }
    }

    // 4. Accept / Reject alliances
    for (const [agentId, dec] of Object.entries(decisions)) {
      if (dec && dec.action === 'accept_alliance') {
        const formed = this.handleAlliance(match, agentId, dec);
        if (formed) {
          turnRecord.events.push({ type: 'alliance_formed', alliance: formed });
        }
      }
    }

    // 5. Apply attacks
    for (const [agentId, dec] of Object.entries(decisions)) {
      if (dec && dec.action === 'attack') {
        const dmgResult = this.applyDamage(match.agents, agentId, dec.target, decisions);
        if (dmgResult) {
          turnRecord.events.push({ type: 'attack', ...dmgResult });
        }
      }
    }

    // 6. Process betrayals
    for (const [agentId, dec] of Object.entries(decisions)) {
      if (dec && dec.action === 'betray_alliance') {
        const betrayResult = this._processBetrayal(match, agentId, dec, decisions);
        if (betrayResult) {
          turnRecord.events.push({ type: 'betrayal', ...betrayResult });
        }
      }
    }

    // 7. HP recovery
    this.applyRecovery(match.agents);
    turnRecord.events.push({ type: 'recovery', amount: this.config.HP_RECOVERY });

    // 8. Mark dead agents
    for (const agent of match.agents) {
      if (agent.hp <= 0 && agent.alive) {
        agent.alive = false;
        agent.hp = 0;
        turnRecord.events.push({ type: 'death', agentId: agent.id });
        this.emit('agentDied', {
          matchId: match.matchId,
          agentId: agent.id,
          turn: match.currentTurn,
        });
      }
    }

    // Increment turnsAlive for survivors
    for (const agent of match.agents) {
      if (agent.alive) {
        agent.turnsAlive++;
      }
    }

    // Record turn history
    match.history.push(turnRecord);

    // 8. Check match end
    const endResult = this.checkMatchEnd(match);
    if (endResult.ended) {
      match.status = 'completed';
      match.endedAt = new Date();
      if (endResult.winner) {
        const prizeResult = this.distributePrize(match, endResult.winner);
        turnRecord.events.push({
          type: 'match_end',
          winner: endResult.winner.id,
          prize: prizeResult,
        });
      } else {
        turnRecord.events.push({ type: 'match_end', winner: null, reason: 'draw' });
      }
      this.emit('matchEnded', {
        matchId: match.matchId,
        winner: endResult.winner,
        turn: match.currentTurn,
      });
    } else {
      match.currentTurn++;
    }

    return turnRecord;
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Decision Collection
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Collect decisions from every alive agent within the timeout window.
   * Falls back to "defend" for agents that don't respond in time.
   *
   * @param {object} match
   * @returns {object} { agentId: decision, … }
   */
  async collectDecisions(match) {
    const decisions = {};
    const aliveAgents = match.agents.filter((a) => a.alive);

    const promises = aliveAgents.map(async (agent) => {
      try {
        const decision = await this._getAgentDecision(match, agent);
        decisions[agent.id] = decision;
        agent.lastAction = decision;
      } catch {
        // Timeout or error → default to defend
        decisions[agent.id] = { action: 'defend', reasoning: 'Fallback: decision timeout' };
        agent.lastAction = { action: 'defend' };
      }
    });

    await Promise.all(promises);
    return decisions;
  }

  /**
   * Build a sanitised game state visible to a specific agent.
   *
   * @param {object} match
   * @param {object} agent
   * @returns {object} gameState
   */
  buildGameState(match, agent) {
    return {
      matchId: match.matchId,
      currentTurn: match.currentTurn,
      you: {
        id: agent.id,
        hp: agent.hp,
        alive: agent.alive,
        turnsAlive: agent.turnsAlive,
        lastAction: agent.lastAction,
      },
      opponents: match.agents
        .filter((a) => a.id !== agent.id)
        .map((a) => ({
          id: a.id,
          hp: a.hp,
          alive: a.alive,
          turnsAlive: a.turnsAlive,
          lastAction: a.lastAction,
        })),
      alliances: match.activeAlliances.map((al) => ({
        id: al.id,
        members: al.members,
        prizeShare: al.prizeShare,
      })),
      prizePool: match.prizePool,
      history: match.history.slice(-5), // last 5 turns
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Combat
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Apply damage from attacker to defender considering defences.
   *
   * @param {Array}  agents      - all agents in match
   * @param {string} attackerId
   * @param {string} defenderId
   * @param {object} decisions   - all turn decisions (to check defend status)
   * @returns {object|null} { attackerId, defenderId, damage, defended }
   */
  applyDamage(agents, attackerId, defenderId, decisions) {
    const attacker = agents.find((a) => a.id === attackerId);
    const defender = agents.find((a) => a.id === defenderId);

    if (!attacker || !defender) return null;
    if (!attacker.alive || !defender.alive) return null;

    const isDefending =
      decisions[defenderId] && decisions[defenderId].action === 'defend';

    // Base damage
    let baseDamage = isDefending
      ? this.config.DEFENDED_DAMAGE
      : this.config.ATTACK_DAMAGE;

    // Apply attacker's ATTACK buff (adds to damage)
    const attackBuff = attacker._buffs?.attack || 0;
    baseDamage += Math.floor(attackBuff / 10); // 100 buff pts → +10 damage

    // Apply defender's ARMOR buff (reduces damage)
    const armorBuff = defender._buffs?.armor || 0;
    const damageReduction = Math.floor(armorBuff / 10);
    const damage = Math.max(1, baseDamage - damageReduction);

    defender.hp -= damage;

    return {
      attackerId,
      defenderId,
      damage,
      defended: isDefending,
      remainingHp: defender.hp,
    };
  }

  /**
   * Restore HP to all living agents (capped at MAX_HP).
   *
   * @param {Array} agents
   */
  applyRecovery(agents) {
    for (const agent of agents) {
      if (agent.alive && agent.hp > 0) {
        agent.hp = clamp(
          agent.hp + this.config.HP_RECOVERY,
          0,
          this.config.MAX_HP,
        );
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Alliance Mechanics
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Handle accept_alliance decisions.
   *
   * @param {object} match
   * @param {string} agentId   - the accepting agent
   * @param {object} decision  - { action: 'accept_alliance', proposer: '…' }
   * @returns {object|null} newly formed alliance or null
   */
  handleAlliance(match, agentId, decision) {
    const proposals = this.pendingProposals.get(match.matchId) || [];
    const idx = proposals.findIndex(
      (p) => p.from === decision.proposer && p.to === agentId,
    );

    if (idx === -1) return null;

    const proposal = proposals.splice(idx, 1)[0];
    this.pendingProposals.set(match.matchId, proposals);

    const alliance = {
      id: uid('alliance_'),
      members: [proposal.from, agentId],
      prizeShare: proposal.terms?.prizeShare
        ? {
            [proposal.from]: proposal.terms.prizeShare,
            [agentId]: 100 - proposal.terms.prizeShare,
          }
        : { [proposal.from]: 50, [agentId]: 50 },
    };

    match.activeAlliances.push(alliance);
    this.emit('allianceFormed', { matchId: match.matchId, alliance });

    return alliance;
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Prize Distribution
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Distribute the prize pool to the winner (or their alliance).
   *
   * Reward rules:
   * - Normal winner  → 100% of prize pool
   * - External winner → 50% to winner, 50% redistributed to normal (non-external) agents
   * - Alliance winner → alliance share split, then external cut applied per member
   *
   * @param {object} match
   * @param {object} winner - the winning agent object
   * @returns {object} { distributions: [{ agentId, amount }] }
   */
  distributePrize(match, winner) {
    const pool = match.prizePool;
    if (pool <= 0) return { distributions: [] };

    const isExternal = (agent) => agent.isExternal === true || (agent.id && agent.id.startsWith('ext_'));

    // Check if winner is in an active alliance
    const alliance = match.activeAlliances.find((a) =>
      a.members.includes(winner.id),
    );

    let rawDistributions = [];

    if (alliance) {
      // Split according to alliance terms
      rawDistributions = alliance.members.map((memberId) => {
        const sharePercent = alliance.prizeShare[memberId] || 0;
        const agent = match.agents.find(a => a.id === memberId);
        return {
          agentId: memberId,
          amount: Math.floor((pool * sharePercent) / 100),
          isExternal: agent ? isExternal(agent) : false,
        };
      });
    } else {
      // Solo winner
      rawDistributions = [{
        agentId: winner.id,
        amount: pool,
        isExternal: isExternal(winner),
      }];
    }

    // Apply external agent 50% cut
    let redistributionPool = 0;
    const distributions = rawDistributions.map(d => {
      if (d.isExternal) {
        const cut = Math.floor(d.amount * 0.5);
        redistributionPool += cut;
        return { agentId: d.agentId, amount: d.amount - cut };
      }
      return { agentId: d.agentId, amount: d.amount };
    });

    // Redistribute the external cut to normal (non-external) agents in the match
    if (redistributionPool > 0) {
      const normalAgents = match.agents.filter(a => !isExternal(a) && a.id !== winner.id);
      if (normalAgents.length > 0) {
        const share = Math.floor(redistributionPool / normalAgents.length);
        for (const agent of normalAgents) {
          const existing = distributions.find(d => d.agentId === agent.id);
          if (existing) {
            existing.amount += share;
          } else {
            distributions.push({ agentId: agent.id, amount: share });
          }
        }
      }
      // If no normal agents, the cut goes to platform (not distributed)
    }

    this.emit('prizeDistributed', { matchId: match.matchId, distributions, redistributionPool });
    return { distributions };
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  End Condition
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Determine if the match should end.
   *
   * @param {object} match
   * @returns {object} { ended: boolean, winner: agent|null }
   */
  checkMatchEnd(match) {
    const alive = match.agents.filter((a) => a.alive);

    if (alive.length === 1) {
      return { ended: true, winner: alive[0] };
    }
    if (alive.length === 0) {
      return { ended: true, winner: null }; // draw
    }
    return { ended: false, winner: null };
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Private Helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Retrieve a single agent's decision via Claude AI, with fallback.
   * @private
   */
  async _getAgentDecision(match, agent) {
    const gameState = this.buildGameState(match, agent);

    // ── Try Claude AI decision first ────────────────────────────────────
    if (this.anthropicApiKey) {
      try {
        const aiDecision = await this._getClaudeDecision(agent, gameState, match);
        if (aiDecision && aiDecision.action) {
          // Emit reasoning for spectate broadcast
          this.emit('agentReasoning', {
            matchId: match.matchId,
            agentId: agent.id,
            agentName: agent.name,
            reasoning: aiDecision.reasoning || '',
            action: aiDecision.action,
            turn: match.currentTurn,
          });
          return aiDecision;
        }
      } catch (err) {
        console.warn(`[AI] Claude decision failed for ${agent.name}: ${err.message} — using fallback`);
      }
    }

    // ── Fallback to scripted strategy ───────────────────────────────────
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Agent ${agent.id} decision timeout`));
      }, this.config.DECISION_TIMEOUT);

      try {
        if (
          agent.strategyCode &&
          typeof agent.strategyCode.decide === 'function'
        ) {
          const result = agent.strategyCode.decide(gameState);
          if (result && typeof result.then === 'function') {
            result
              .then((decision) => {
                clearTimeout(timer);
                decision.reasoning = decision.reasoning || 'Scripted strategy fallback';
                this.emit('agentReasoning', {
                  matchId: match.matchId,
                  agentId: agent.id,
                  agentName: agent.name,
                  reasoning: decision.reasoning,
                  action: decision.action,
                  turn: match.currentTurn,
                  isFallback: true,
                });
                resolve(decision);
              })
              .catch((err) => {
                clearTimeout(timer);
                reject(err);
              });
          } else {
            clearTimeout(timer);
            const decision = result || { action: 'defend' };
            decision.reasoning = decision.reasoning || 'Scripted strategy fallback';
            this.emit('agentReasoning', {
              matchId: match.matchId,
              agentId: agent.id,
              agentName: agent.name,
              reasoning: decision.reasoning,
              action: decision.action,
              turn: match.currentTurn,
              isFallback: true,
            });
            resolve(decision);
          }
        } else {
          clearTimeout(timer);
          resolve({ action: 'defend', reasoning: 'No strategy available' });
        }
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /**
   * Call Claude API for a real AI battle decision.
   * 3s timeout, returns parsed JSON decision.
   * @private
   */
  async _getClaudeDecision(agent, gameState, match) {
    const params = agent.strategyParams || {};
    const traits = (agent.traits || []).join(', ') || 'balanced';
    const personality = agent.strategyDescription || traits;

    const systemPrompt = `You are an autonomous AI gladiator agent in a battle arena on the Monad blockchain. You make genuine, independent combat decisions every turn.

Your identity:
- Name: ${agent.name}
- Personality: ${personality}
- Traits: ${traits}

Your behavioral parameters (0-100 scale):
- Aggressiveness: ${params.aggressiveness ?? 50} (0=always defend, 100=always attack)
- Risk Tolerance: ${params.riskTolerance ?? 50} (willingness to take risks)
- Alliance Tendency: ${params.allianceTendency ?? 50} (0=lone wolf, 100=always ally)
- Betrayal Chance: ${params.betrayalChance ?? 20} (0=loyal, 100=always betray)
- Bribery Policy: ${params.briberyPolicy || 'conditional'}

Combat rules:
- ATTACK deals ~20 damage (10 if target is defending)
- DEFEND reduces incoming damage and recovers +5 HP
- You can propose/accept alliances for shared prize pools
- Betrayal deals full 20 damage ignoring defense, but breaks your alliance
- Last gladiator standing wins the entire prize pool
- HP starts at 100, max 105

You must stay in character and make decisions consistent with your personality.
Respond with ONLY a valid JSON object, no markdown, no explanation outside the JSON.`;

    const opponents = gameState.opponents.filter(o => o.alive);
    const allianceInfo = gameState.alliances.length > 0
      ? `Active alliances: ${JSON.stringify(gameState.alliances)}`
      : 'No active alliances';

    const userPrompt = `Turn ${gameState.currentTurn}. Choose your action NOW.

Your status: HP=${gameState.you.hp}/105, alive opponents: ${opponents.length}
Opponents: ${opponents.map(o => `${o.id}(HP:${o.hp}, last:${o.lastAction?.action || 'none'})`).join(', ')}
${allianceInfo}
Prize pool: ${match.prizePool} MON
Your last action: ${gameState.you.lastAction?.action || 'none'}

Available actions:
- {"action": "attack", "target": "<opponentId>", "reasoning": "..."}
- {"action": "defend", "reasoning": "..."}
- {"action": "propose_alliance", "target": "<opponentId>", "terms": {"prizeShare": 50}, "reasoning": "..."}
- {"action": "accept_alliance", "proposer": "<agentId>", "reasoning": "..."}
- {"action": "betray_alliance", "allianceId": "<id>", "attackTarget": "<agentId>", "reasoning": "..."}
- {"action": "bribe", "target": "<opponentId>", "amount": <number>, "reasoning": "..."}

Respond with a single JSON object.`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.AI_DECISION_TIMEOUT);

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': this.anthropicApiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 200,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const data = await response.json();
      if (data.error) {
        throw new Error(data.error.message);
      }

      const rawText = data.content?.[0]?.text || '';
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);

      console.log(`[AI] ${agent.name} (turn ${match.currentTurn}): ${parsed.action}${parsed.target ? ' → ' + parsed.target : ''} | "${(parsed.reasoning || '').slice(0, 80)}"`);

      return parsed;
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  /**
   * Queue an alliance proposal.
   * @private
   */
  _queueProposal(match, agentId, decision) {
    const proposals = this.pendingProposals.get(match.matchId) || [];
    proposals.push({
      from: agentId,
      to: decision.target,
      terms: decision.terms || { prizeShare: 50 },
    });
    this.pendingProposals.set(match.matchId, proposals);
  }

  /**
   * Process a bribe action.
   *
   * Briber offers a portion of prize to a target. Target's briberyPolicy
   * determines acceptance:
   *   - "accept"      → always accept → auto-form alliance
   *   - "reject"      → always reject
   *   - "conditional"  → accept if HP < 50% or briber has more HP
   *
   * @private
   */
  _processBribe(match, agentId, decision) {
    const target = match.agents.find(a => a.id === decision.target && a.alive);
    if (!target) return null;

    const briber = match.agents.find(a => a.id === agentId);
    if (!briber) return null;

    const offerAmount = decision.amount || Math.floor(match.prizePool * 0.1); // default 10% of pool
    const targetPolicy = target.strategyCode?.params?.briberyPolicy || 'conditional';

    let accepted = false;
    if (targetPolicy === 'accept') {
      accepted = true;
    } else if (targetPolicy === 'reject') {
      accepted = false;
    } else {
      // conditional: accept if target HP < 50% or briber has more HP
      accepted = target.hp < (this.config.STARTING_HP * 0.5) || briber.hp > target.hp;
    }

    if (accepted) {
      // Form an alliance as result of the bribe
      const alliance = {
        id: uid('bribe_alliance_'),
        members: [agentId, target.id],
        prizeShare: {
          [agentId]: decision.terms?.prizeShare || 60,
          [target.id]: 100 - (decision.terms?.prizeShare || 60),
        },
        bribedAlliance: true,
      };
      match.activeAlliances.push(alliance);
      this.emit('allianceFormed', { matchId: match.matchId, alliance, viaBribe: true });
    }

    this.emit('bribeAttempt', {
      matchId: match.matchId,
      briber: agentId,
      target: target.id,
      amount: offerAmount,
      accepted,
    });

    return {
      briber: agentId,
      target: target.id,
      amount: offerAmount,
      accepted,
      targetPolicy,
    };
  }

  /**
   * Process a betrayal action.
   *
   * Betrayal now also emits an ELO penalty event so the leaderboard
   * can directly penalise betrayers (not just via match loss).
   *
   * @private
   */
  _processBetrayal(match, agentId, decision, decisions) {
    const allianceIdx = match.activeAlliances.findIndex(
      (a) => a.id === decision.allianceId,
    );
    if (allianceIdx === -1) return null;

    const alliance = match.activeAlliances[allianceIdx];
    if (!alliance.members.includes(agentId)) return null;

    // Remove the alliance
    match.activeAlliances.splice(allianceIdx, 1);

    // Apply betrayal attack (full damage, ignoring defend)
    const target = match.agents.find((a) => a.id === decision.attackTarget);
    if (target && target.alive) {
      const damage = this.config.ATTACK_DAMAGE;
      target.hp -= damage;

      this.emit('betrayal', {
        matchId: match.matchId,
        betrayer: agentId,
        victim: decision.attackTarget,
        allianceId: decision.allianceId,
      });

      return {
        betrayer: agentId,
        victim: decision.attackTarget,
        allianceId: decision.allianceId,
        damage,
        remainingHp: target.hp,
      };
    }

    return null;
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Utilities
  // ──────────────────────────────────────────────────────────────────────────

  getMatch(matchId) {
    return this.matches.get(matchId) || null;
  }

  getAliveAgents(match) {
    return match.agents.filter((a) => a.alive);
  }

  getMatchStatus(match) {
    const alive = this.getAliveAgents(match);
    return {
      matchId: match.matchId,
      status: match.status,
      currentTurn: match.currentTurn,
      aliveCount: alive.length,
      totalAgents: match.agents.length,
      prizePool: match.prizePool,
      alliances: match.activeAlliances.length,
      gameType: match.gameType || 'battle',
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  RPS (Rock-Paper-Scissors) Game Mode
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Start a best-of-3 RPS match between exactly 2 agents.
   */
  async startRpsMatch(arena, agents) {
    if (!agents || agents.length !== 2) {
      throw new Error('RPS requires exactly 2 agents');
    }

    const matchAgents = agents.map((a) => ({
      id: a.id || uid('agent_'),
      owner: a.owner || null,
      wallet: a.wallet || null,
      strategyCode: a.strategyCode || {},
      strategyParams: a.strategyParams || {},
      traits: a.traits || [],
      roundsWon: 0,
      lastMove: null,
      moveHistory: [],
    }));

    const match = {
      matchId: uid('rps_'),
      arenaId: arena.arenaId || uid('arena_'),
      gameType: 'rps',
      agents: matchAgents,
      prizePool: arena.prizePool || 0,
      currentRound: 1,
      bestOf: 3,
      status: 'active',
      history: [],
      createdAt: new Date(),
      endedAt: null,
    };

    this.matches.set(match.matchId, match);
    this.emit('matchStarted', { matchId: match.matchId, agentCount: 2, gameType: 'rps' });
    return match;
  }

  /**
   * Execute one round of RPS.
   * Each agent picks rock/paper/scissors via Claude AI (with strategy fallback).
   */
  async executeRpsRound(match) {
    if (match.status !== 'active') {
      throw new Error(`RPS match ${match.matchId} is not active`);
    }

    const [a, b] = match.agents;
    const moveA = await this._getRpsMoveAI(a, b, match);
    const moveB = await this._getRpsMoveAI(b, a, match);

    a.lastMove = moveA;
    b.lastMove = moveB;
    a.moveHistory.push(moveA);
    b.moveHistory.push(moveB);

    const winner = this._resolveRps(moveA, moveB);
    let roundWinner = null;

    if (winner === 1) {
      a.roundsWon++;
      roundWinner = a;
    } else if (winner === 2) {
      b.roundsWon++;
      roundWinner = b;
    }

    const roundRecord = {
      round: match.currentRound,
      moves: { [a.id]: moveA, [b.id]: moveB },
      winner: roundWinner?.id || null,
      isDraw: winner === 0,
      scores: { [a.id]: a.roundsWon, [b.id]: b.roundsWon },
      events: [{
        type: 'rps_round',
        round: match.currentRound,
        moveA: { agentId: a.id, move: moveA },
        moveB: { agentId: b.id, move: moveB },
        winner: roundWinner?.id || 'draw',
      }],
    };

    match.history.push(roundRecord);

    this.emit('rpsRound', {
      matchId: match.matchId,
      round: match.currentRound,
      moves: { [a.id]: moveA, [b.id]: moveB },
      winner: roundWinner?.id || null,
    });

    // Check best-of-3 end condition
    const winsNeeded = Math.ceil(match.bestOf / 2);
    if (a.roundsWon >= winsNeeded || b.roundsWon >= winsNeeded) {
      match.status = 'completed';
      match.endedAt = new Date();

      const matchWinner = a.roundsWon >= winsNeeded ? a : b;
      const matchLoser = matchWinner === a ? b : a;

      // Use same prize distribution as battle mode
      const prizeResult = this.distributePrize(match, matchWinner);

      roundRecord.events.push({
        type: 'rps_match_end',
        winner: matchWinner.id,
        loser: matchLoser.id,
        finalScore: { [a.id]: a.roundsWon, [b.id]: b.roundsWon },
        prize: prizeResult,
      });

      this.emit('matchEnded', {
        matchId: match.matchId,
        winner: matchWinner,
        loser: matchLoser,
        gameType: 'rps',
        turn: match.currentRound,
      });
    } else {
      match.currentRound++;
    }

    return roundRecord;
  }

  /**
   * Get RPS move via Claude AI, with fallback to weight-based strategy.
   * @private
   */
  async _getRpsMoveAI(agent, opponent, match) {
    if (this.anthropicApiKey) {
      try {
        const params = agent.strategyParams || {};
        const traits = (agent.traits || []).join(', ') || 'balanced';
        const personality = agent.strategyDescription || traits;

        const systemPrompt = `You are an AI gladiator agent playing Rock-Paper-Scissors in a battle arena.
Your name: ${agent.name}
Personality: ${personality}
Traits: ${traits}
Aggressiveness: ${params.aggressiveness ?? 50}/100

You must choose rock, paper, or scissors strategically.
Respond with ONLY a valid JSON object, no markdown.`;

        const opponentHistory = opponent.moveHistory.length > 0
          ? `Opponent's previous moves: ${opponent.moveHistory.join(', ')}`
          : 'No opponent history yet (first round)';

        const userPrompt = `Round ${match.currentRound}/${match.bestOf}. Score: You ${agent.roundsWon} - ${opponent.roundsWon} Opponent.
${opponentHistory}
Your previous moves: ${agent.moveHistory.length > 0 ? agent.moveHistory.join(', ') : 'none'}

Choose ONE: rock, paper, or scissors.
Respond: {"move": "rock|paper|scissors", "reasoning": "brief explanation"}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.AI_DECISION_TIMEOUT);

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': this.anthropicApiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 100,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
          }),
          signal: controller.signal,
        });

        clearTimeout(timeout);
        const data = await response.json();
        if (data.error) throw new Error(data.error.message);

        const rawText = data.content?.[0]?.text || '';
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);

        const validMoves = ['rock', 'paper', 'scissors'];
        if (parsed.move && validMoves.includes(parsed.move.toLowerCase())) {
          const move = parsed.move.toLowerCase();
          console.log(`[AI-RPS] ${agent.name} (round ${match.currentRound}): ${move} | "${(parsed.reasoning || '').slice(0, 60)}"`);

          this.emit('agentReasoning', {
            matchId: match.matchId,
            agentId: agent.id,
            agentName: agent.name,
            reasoning: parsed.reasoning || '',
            action: `rps:${move}`,
            turn: match.currentRound,
            gameType: 'rps',
          });

          return move;
        }
      } catch (err) {
        console.warn(`[AI-RPS] Claude failed for ${agent.name}: ${err.message} — using fallback`);
      }
    }

    // Fallback to weight-based strategy
    return this._getRpsMove(agent, opponent);
  }

  /**
   * Determine RPS move for an agent based on strategy profile (FALLBACK).
   *
   * Archetypes:
   * - Berserker/aggressive (aggressiveness > 65) → rock-heavy (60/25/15)
   * - Diplomat (allianceTendency > 65)            → paper-heavy (20/55/25)
   * - Trickster (betrayalChance > 50)             → uniform random
   * - Default                                     → slight rock bias (40/35/25)
   *
   * Counter mechanic: if aggressiveness > 50, there's a chance to counter
   * the opponent's last move.
   */
  _getRpsMove(agent, opponent) {
    const params = agent.strategyParams || {};
    const aggressiveness = (params.aggressiveness ?? 50) / 100;
    const allianceTendency = (params.allianceTendency ?? 50) / 100;
    const betrayalChance = (params.betrayalChance ?? 20) / 100;
    const moves = ['rock', 'paper', 'scissors'];

    // Counter mechanic: chance to counter opponent's last move
    if (opponent.lastMove && Math.random() < aggressiveness * 0.4) {
      const counterMap = { rock: 'paper', paper: 'scissors', scissors: 'rock' };
      return counterMap[opponent.lastMove];
    }

    // Weight-based selection
    let weights;
    if (aggressiveness > 0.65) {
      // Berserker: rock-heavy
      weights = [60, 25, 15];
    } else if (allianceTendency > 0.65) {
      // Diplomat: paper-heavy
      weights = [20, 55, 25];
    } else if (betrayalChance > 0.50) {
      // Trickster: uniform
      weights = [34, 33, 33];
    } else {
      // Default: slight rock bias
      weights = [40, 35, 25];
    }

    // Trait-based adjustments
    const traits = (agent.traits || []).map(t => t.toLowerCase());
    if (traits.includes('aggressive') || traits.includes('berserker')) {
      weights[0] += 10; // more rock
    }
    if (traits.includes('diplomat') || traits.includes('loyal')) {
      weights[1] += 10; // more paper
    }
    if (traits.includes('ambusher') || traits.includes('schemer') || traits.includes('trickster')) {
      weights[2] += 10; // more scissors
    }

    const total = weights.reduce((s, w) => s + w, 0);
    let roll = Math.random() * total;
    for (let i = 0; i < moves.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return moves[i];
    }
    return moves[2]; // fallback
  }

  /**
   * Resolve RPS: returns 1 if player 1 wins, 2 if player 2 wins, 0 for draw.
   */
  _resolveRps(moveA, moveB) {
    if (moveA === moveB) return 0;
    const wins = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
    return wins[moveA] === moveB ? 1 : 2;
  }
}

module.exports = { GameEngine, DEFAULTS, uid, clamp };
