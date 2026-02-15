/**
 * Monad Colosseum - Game Engine
 *
 * Manages match lifecycle, turn execution, combat resolution,
 * alliance mechanics, and prize distribution.
 *
 * Each agent makes REAL AI decisions via Gemini 2.0 Flash (primary) every turn.
 * Fallback chain: Gemini → Groq → Claude → strategies.js.
 * Agent creation also uses Claude API (in server.js).
 */

const crypto = require('crypto');
const EventEmitter = require('events');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Groq = require('groq-sdk');
const Anthropic = require('@anthropic-ai/sdk');

// ─── Constants ───────────────────────────────────────────────────────────────
const DEFAULTS = {
  STARTING_HP: 100,
  MAX_HP: 105,
  ATTACK_DAMAGE: 20,
  DEFENDED_DAMAGE: 10,
  HP_RECOVERY: 5,
  DECISION_TIMEOUT: 30000, // 30 seconds
  AI_DECISION_TIMEOUT: 5000, // 5s for Groq API call
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

    // Gemini AI for agent decisions (primary, free & fast)
    const geminiKey = config.geminiApiKey || process.env.GEMINI_API_KEY || null;
    if (geminiKey) {
      const genAI = new GoogleGenerativeAI(geminiKey);
      this.geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      console.log('[GameEngine] ✅ Gemini AI enabled (gemini-2.0-flash) — PRIMARY');
    } else {
      this.geminiModel = null;
    }

    // Groq SDK for agent decisions (fallback #1)
    const groqKey = config.groqApiKey || process.env.GROQ_API_KEY || null;
    this.groq = groqKey ? new Groq({ apiKey: groqKey }) : null;
    if (this.groq) console.log('[GameEngine] ✅ Groq AI enabled (llama-3.3-70b-versatile) — fallback #1');

    // Anthropic Claude SDK (fallback #2)
    this.anthropic = this.anthropicApiKey ? new Anthropic({ apiKey: this.anthropicApiKey }) : null;
    if (this.anthropic) console.log('[GameEngine] ✅ Claude AI enabled (claude-sonnet-4-20250514) — fallback #2');

    // Rate-limit cooldowns (5 min) — skip API calls if recently rate-limited
    this._geminiCooldownUntil = 0;
    this._groqCooldownUntil = 0;
    this._COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
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
    const delay = this.geminiModel ? 2000 : 2000; // rate-limit delay between agent calls

    // Sequential calls to avoid rate limiting (NOT parallel)
    for (let i = 0; i < aliveAgents.length; i++) {
      const agent = aliveAgents[i];
      try {
        const decision = await this._getAgentDecision(match, agent);
        decisions[agent.id] = decision;
        agent.lastAction = decision;
      } catch {
        // Timeout or error → default to defend
        decisions[agent.id] = { action: 'defend', reasoning: 'Fallback: decision timeout' };
        agent.lastAction = { action: 'defend' };
      }

      // Rate limit: wait between agent calls (skip after last agent)
      if (i < aliveAgents.length - 1) {
        await new Promise(r => setTimeout(r, delay));
      }
    }

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

    // ── Try Gemini AI decision first (PRIMARY) ─────────────────────────
    if (this.geminiModel && Date.now() >= this._geminiCooldownUntil) {
      try {
        const aiDecision = await this._getGeminiDecision(agent, gameState, match);
        if (aiDecision && aiDecision.action) {
          this.emit('agentReasoning', {
            matchId: match.matchId,
            agentId: agent.id,
            agentName: agent.name,
            reasoning: aiDecision.reasoning || '',
            action: aiDecision.action,
            turn: match.currentTurn,
            provider: 'gemini',
          });
          return aiDecision;
        }
      } catch (err) {
        const msg = err.message || '';
        if (msg.includes('429') || msg.includes('rate') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) {
          this._geminiCooldownUntil = Date.now() + this._COOLDOWN_MS;
          console.warn(`[AI] Gemini rate-limited → cooldown 5min (until ${new Date(this._geminiCooldownUntil).toLocaleTimeString()})`);
        }
        console.warn(`[AI] Gemini decision failed for ${agent.name}: ${msg} — trying Groq...`);
      }
    } else if (this.geminiModel && Date.now() < this._geminiCooldownUntil) {
      // Skip — Gemini is in cooldown
    }

    // ── Try Groq AI as fallback #1 ──────────────────────────────────────
    if (this.groq && Date.now() >= this._groqCooldownUntil) {
      try {
        const aiDecision = await this._getGroqDecision(agent, gameState, match);
        if (aiDecision && aiDecision.action) {
          this.emit('agentReasoning', {
            matchId: match.matchId,
            agentId: agent.id,
            agentName: agent.name,
            reasoning: aiDecision.reasoning || '',
            action: aiDecision.action,
            turn: match.currentTurn,
            provider: 'groq',
          });
          return aiDecision;
        }
      } catch (err) {
        const msg = err.message || '';
        if (msg.includes('429') || msg.includes('rate_limit') || msg.includes('Rate limit')) {
          this._groqCooldownUntil = Date.now() + this._COOLDOWN_MS;
          console.warn(`[AI] Groq rate-limited → cooldown 5min (until ${new Date(this._groqCooldownUntil).toLocaleTimeString()})`);
        }
        console.warn(`[AI] Groq decision failed for ${agent.name}: ${msg} — trying Claude...`);
      }
    } else if (this.groq && Date.now() < this._groqCooldownUntil) {
      // Skip — Groq is in cooldown
    }

    // ── Try Claude AI as fallback #2 ────────────────────────────────────
    if (this.anthropic) {
      try {
        const aiDecision = await this._getClaudeDecision(agent, gameState, match);
        if (aiDecision && aiDecision.action) {
          this.emit('agentReasoning', {
            matchId: match.matchId,
            agentId: agent.id,
            agentName: agent.name,
            reasoning: aiDecision.reasoning || '',
            action: aiDecision.action,
            turn: match.currentTurn,
            provider: 'claude',
          });
          return aiDecision;
        }
      } catch (err) {
        console.warn(`[AI] Claude decision failed for ${agent.name}: ${err.message} — using strategy fallback`);
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
   * Call Gemini 2.0 Flash for a real AI battle decision.
   * 5s timeout, returns parsed JSON decision. Free & fast.
   * @private
   */
  async _getGeminiDecision(agent, gameState, match) {
    const params = agent.strategyParams || {};
    const traits = (agent.traits || []).join(', ') || 'balanced';
    const personality = agent.strategyDescription || traits;

    const opponents = gameState.opponents.filter(o => o.alive);
    const allianceInfo = gameState.alliances.length > 0
      ? `Active alliances: ${JSON.stringify(gameState.alliances)}`
      : 'No active alliances';

    const prompt = `You are ${agent.name}, an autonomous AI gladiator in a battle arena on the Monad blockchain.
Personality: ${personality}. Traits: ${traits}.
Parameters: aggressiveness=${params.aggressiveness ?? 50}, riskTolerance=${params.riskTolerance ?? 50}, allianceTendency=${params.allianceTendency ?? 50}, betrayalChance=${params.betrayalChance ?? 20}, briberyPolicy=${params.briberyPolicy || 'conditional'}.

Combat rules:
- ATTACK deals ~20 damage (10 if target is defending)
- DEFEND reduces incoming damage and recovers +5 HP
- Betrayal deals full 20 damage ignoring defense, but breaks alliance
- Last gladiator standing wins the entire prize pool
- HP starts at 100, max 105

Turn ${gameState.currentTurn}. Your HP=${gameState.you.hp}/105, alive opponents: ${opponents.length}
Opponents: ${opponents.map(o => `${o.id}(HP:${o.hp}, last:${o.lastAction?.action || 'none'})`).join(', ')}
${allianceInfo}
Prize pool: ${match.prizePool} MON | Your last action: ${gameState.you.lastAction?.action || 'none'}

Choose ONE action:
- {"action":"attack","target":"<id>","reasoning":"brief why"}
- {"action":"defend","reasoning":"brief why"}
- {"action":"propose_alliance","target":"<id>","terms":{"prizeShare":50},"reasoning":"..."}
- {"action":"accept_alliance","proposer":"<id>","reasoning":"..."}
- {"action":"betray_alliance","allianceId":"<id>","attackTarget":"<id>","reasoning":"..."}
- {"action":"bribe","target":"<id>","amount":<number>,"reasoning":"..."}

Respond ONLY with valid JSON, no extra text.`;

    try {
      const result = await Promise.race([
        this.geminiModel.generateContent(prompt),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini timeout 5s')), this.config.AI_DECISION_TIMEOUT)),
      ]);

      const rawText = result.response.text();
      const clean = rawText.replace(/```json|```/g, '').trim();
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : clean);

      console.log(`[AI-Gemini] ${agent.name} (turn ${match.currentTurn}): ${parsed.action}${parsed.target ? ' → ' + parsed.target : ''} | "${(parsed.reasoning || '').slice(0, 80)}"`);

      return parsed;
    } catch (err) {
      throw err;
    }
  }

  /**
   * Call Groq API (llama-3.3-70b-versatile) for a real AI battle decision.
   * 5s timeout, returns parsed JSON decision. Free API.
   * @private
   */
  async _getGroqDecision(agent, gameState, match) {
    const params = agent.strategyParams || {};
    const traits = (agent.traits || []).join(', ') || 'balanced';
    const personality = agent.strategyDescription || traits;

    const systemPrompt = `You are ${agent.name}, an autonomous AI gladiator in a battle arena on the Monad blockchain.
Personality: ${personality}
Traits: ${traits}
Parameters: aggressiveness=${params.aggressiveness ?? 50}, riskTolerance=${params.riskTolerance ?? 50}, allianceTendency=${params.allianceTendency ?? 50}, betrayalChance=${params.betrayalChance ?? 20}, briberyPolicy=${params.briberyPolicy || 'conditional'}.

Combat rules:
- ATTACK deals ~20 damage (10 if target is defending)
- DEFEND reduces incoming damage and recovers +5 HP
- Betrayal deals full 20 damage ignoring defense, but breaks alliance
- Last gladiator standing wins the entire prize pool
- HP starts at 100, max 105

Stay in character. Respond ONLY with valid JSON, no extra text.`;

    const opponents = gameState.opponents.filter(o => o.alive);
    const allianceInfo = gameState.alliances.length > 0
      ? `Active alliances: ${JSON.stringify(gameState.alliances)}`
      : 'No active alliances';

    const userPrompt = `Turn ${gameState.currentTurn}. Your HP=${gameState.you.hp}/105, alive opponents: ${opponents.length}
Opponents: ${opponents.map(o => `${o.id}(HP:${o.hp}, last:${o.lastAction?.action || 'none'})`).join(', ')}
${allianceInfo}
Prize pool: ${match.prizePool} MON | Your last action: ${gameState.you.lastAction?.action || 'none'}

Choose ONE action:
- {"action":"attack","target":"<id>","reasoning":"brief why"}
- {"action":"defend","reasoning":"brief why"}
- {"action":"propose_alliance","target":"<id>","terms":{"prizeShare":50},"reasoning":"..."}
- {"action":"accept_alliance","proposer":"<id>","reasoning":"..."}
- {"action":"betray_alliance","allianceId":"<id>","attackTarget":"<id>","reasoning":"..."}
- {"action":"bribe","target":"<id>","amount":<number>,"reasoning":"..."}

JSON:`;

    try {
      const response = await Promise.race([
        this.groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 150,
          temperature: 0.7,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Groq timeout 5s')), this.config.AI_DECISION_TIMEOUT)),
      ]);

      const rawText = response.choices?.[0]?.message?.content || '';
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);

      console.log(`[AI] ${agent.name} (turn ${match.currentTurn}): ${parsed.action}${parsed.target ? ' → ' + parsed.target : ''} | "${(parsed.reasoning || '').slice(0, 80)}"`);

      return parsed;
    } catch (err) {
      throw err;
    }
  }

  /**
   * Call Anthropic Claude API (claude-sonnet-4-20250514) for battle decision.
   * Used as fallback when Groq fails. 5s timeout.
   * @private
   */
  async _getClaudeDecision(agent, gameState, match) {
    const params = agent.strategyParams || {};
    const systemPrompt = `You are ${agent.name}, an autonomous AI gladiator in a battle arena on the Monad blockchain. ${agent.strategyDescription || (agent.traits || []).join(', ') || 'balanced fighter'}. aggressiveness=${params.aggressiveness ?? 50}, riskTolerance=${params.riskTolerance ?? 50}, allianceTendency=${params.allianceTendency ?? 50}, betrayalChance=${params.betrayalChance ?? 20}, briberyPolicy=${params.briberyPolicy || 'conditional'}. Respond ONLY with valid JSON, no extra text.`;

    const opponents = gameState.opponents.filter(o => o.alive);
    const allianceInfo = gameState.alliances.length > 0
      ? `Active alliances: ${JSON.stringify(gameState.alliances)}`
      : 'No active alliances';

    const userContent = `Turn ${gameState.currentTurn}. HP=${gameState.you.hp}/105, opponents: ${opponents.length}\nOpponents: ${opponents.map(o => `${o.id}(HP:${o.hp}, last:${o.lastAction?.action || 'none'})`).join(', ')}\n${allianceInfo}\nPrize: ${match.prizePool} MON\nPick ONE: {"action":"attack","target":"<id>","reasoning":"..."}, {"action":"defend","reasoning":"..."}, {"action":"propose_alliance","target":"<id>","terms":{"prizeShare":50},"reasoning":"..."}, {"action":"betray_alliance","allianceId":"<id>","attackTarget":"<id>","reasoning":"..."}, {"action":"bribe","target":"<id>","amount":<n>,"reasoning":"..."}\nJSON:`;

    try {
      const response = await Promise.race([
        this.anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 150,
          system: systemPrompt,
          messages: [{ role: 'user', content: userContent }],
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Claude timeout 5s')), this.config.AI_DECISION_TIMEOUT)),
      ]);

      const rawText = response.content?.[0]?.text || '';
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);

      console.log(`[AI-Claude] ${agent.name} (turn ${match.currentTurn}): ${parsed.action}${parsed.target ? ' → ' + parsed.target : ''} | "${(parsed.reasoning || '').slice(0, 80)}"`);

      return parsed;
    } catch (err) {
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
      name: a.name || 'Unknown',
      owner: a.owner || null,
      wallet: a.wallet || null,
      strategyCode: a.strategyCode || {},
      strategyParams: a.strategyParams || {},
      strategyDescription: a.strategyDescription || '',
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
    // Rate limit: 2s delay between RPS AI calls
    await new Promise(r => setTimeout(r, 2000));
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
    // ── Gemini primary for RPS ──
    if (this.geminiModel && Date.now() >= this._geminiCooldownUntil) {
      try {
        const params = agent.strategyParams || {};
        const personality = agent.strategyDescription || (agent.traits || []).join(', ') || 'balanced';

        const opponentHistory = opponent.moveHistory.length > 0
          ? `Opponent's previous moves: ${opponent.moveHistory.join(', ')}`
          : 'No opponent history yet (first round)';

        const prompt = `You are ${agent.name}, an AI gladiator playing Rock-Paper-Scissors.
Personality: ${personality}. Aggressiveness: ${params.aggressiveness ?? 50}/100.

Round ${match.currentRound}/${match.bestOf}. Score: You ${agent.roundsWon} - ${opponent.roundsWon} Opponent.
${opponentHistory}
Your previous moves: ${agent.moveHistory.length > 0 ? agent.moveHistory.join(', ') : 'none'}

Choose ONE: rock, paper, or scissors.
Respond ONLY with valid JSON: {"move": "rock|paper|scissors", "reasoning": "brief why"}`;

        const result = await Promise.race([
          this.geminiModel.generateContent(prompt),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini RPS timeout 5s')), this.config.AI_DECISION_TIMEOUT)),
        ]);

        const rawText = result.response.text();
        const clean = rawText.replace(/```json|```/g, '').trim();
        const jsonMatch = clean.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : clean);

        const validMoves = ['rock', 'paper', 'scissors'];
        if (parsed.move && validMoves.includes(parsed.move.toLowerCase())) {
          const move = parsed.move.toLowerCase();
          console.log(`[AI-RPS-Gemini] ${agent.name} (round ${match.currentRound}): ${move} | "${(parsed.reasoning || '').slice(0, 60)}"`);

          this.emit('agentReasoning', {
            matchId: match.matchId,
            agentId: agent.id,
            agentName: agent.name,
            reasoning: parsed.reasoning || '',
            action: `rps:${move}`,
            turn: match.currentRound,
            gameType: 'rps',
            provider: 'gemini',
          });

          return move;
        }
      } catch (err) {
        const msg = err.message || '';
        if (msg.includes('429') || msg.includes('rate') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) {
          this._geminiCooldownUntil = Date.now() + this._COOLDOWN_MS;
          console.warn(`[AI-RPS] Gemini rate-limited → cooldown 5min`);
        }
        console.warn(`[AI-RPS] Gemini failed for ${agent.name}: ${msg} — trying Groq...`);
      }
    }

    // ── Groq fallback for RPS ──
    if (this.groq && Date.now() >= this._groqCooldownUntil) {
      try {
        const params = agent.strategyParams || {};
        const traits = (agent.traits || []).join(', ') || 'balanced';
        const personality = agent.strategyDescription || traits;

        const systemPrompt = `You are ${agent.name}, an AI gladiator playing Rock-Paper-Scissors.
Personality: ${personality}. Traits: ${traits}. Aggressiveness: ${params.aggressiveness ?? 50}/100.
Choose rock, paper, or scissors strategically. Respond ONLY with valid JSON, no extra text.`;

        const opponentHistory = opponent.moveHistory.length > 0
          ? `Opponent's previous moves: ${opponent.moveHistory.join(', ')}`
          : 'No opponent history yet (first round)';

        const userPrompt = `Round ${match.currentRound}/${match.bestOf}. Score: You ${agent.roundsWon} - ${opponent.roundsWon} Opponent.
${opponentHistory}
Your previous moves: ${agent.moveHistory.length > 0 ? agent.moveHistory.join(', ') : 'none'}

Choose ONE: rock, paper, or scissors.
JSON: {"move": "rock|paper|scissors", "reasoning": "brief why"}`;

        const response = await Promise.race([
          this.groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            max_tokens: 80,
            temperature: 0.7,
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Groq RPS timeout 5s')), this.config.AI_DECISION_TIMEOUT)),
        ]);

        const rawText = response.choices?.[0]?.message?.content || '';
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
        const msg = err.message || '';
        if (msg.includes('429') || msg.includes('rate_limit') || msg.includes('Rate limit')) {
          this._groqCooldownUntil = Date.now() + this._COOLDOWN_MS;
          console.warn(`[AI-RPS] Groq rate-limited → cooldown 5min`);
        }
        console.warn(`[AI-RPS] Groq failed for ${agent.name}: ${msg} — trying Claude...`);
      }
    }

    // ── Claude fallback for RPS ──
    if (this.anthropic) {
      try {
        const params = agent.strategyParams || {};
        const systemPrompt = `You are ${agent.name}, an AI gladiator playing Rock-Paper-Scissors. ${agent.strategyDescription || (agent.traits || []).join(', ') || 'balanced'}. Aggressiveness: ${params.aggressiveness ?? 50}/100. Respond ONLY with valid JSON, no extra text.`;

        const opponentHistory = opponent.moveHistory.length > 0
          ? `Opponent's previous moves: ${opponent.moveHistory.join(', ')}`
          : 'No opponent history yet';

        const userContent = `Round ${match.currentRound}/${match.bestOf}. Score: You ${agent.roundsWon} - ${opponent.roundsWon} Opponent.\n${opponentHistory}\nYour previous moves: ${agent.moveHistory.length > 0 ? agent.moveHistory.join(', ') : 'none'}\nChoose ONE: rock, paper, or scissors.\nJSON: {"move": "rock|paper|scissors", "reasoning": "brief why"}`;

        const response = await Promise.race([
          this.anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 80,
            system: systemPrompt,
            messages: [{ role: 'user', content: userContent }],
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Claude RPS timeout 5s')), this.config.AI_DECISION_TIMEOUT)),
        ]);

        const rawText = response.content?.[0]?.text || '';
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);

        const validMoves = ['rock', 'paper', 'scissors'];
        if (parsed.move && validMoves.includes(parsed.move.toLowerCase())) {
          const move = parsed.move.toLowerCase();
          console.log(`[AI-RPS-Claude] ${agent.name} (round ${match.currentRound}): ${move} | "${(parsed.reasoning || '').slice(0, 60)}"`);

          this.emit('agentReasoning', {
            matchId: match.matchId,
            agentId: agent.id,
            agentName: agent.name,
            reasoning: parsed.reasoning || '',
            action: `rps:${move}`,
            turn: match.currentRound,
            gameType: 'rps',
            provider: 'claude',
          });

          return move;
        }
      } catch (err) {
        console.warn(`[AI-RPS-Claude] Claude failed for ${agent.name}: ${err.message} — using strategy fallback`);
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
