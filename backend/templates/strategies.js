/**
 * Strategy Templates for AI Gladiator Agents
 * 
 * Each strategy uses the combat model: attack, defend, propose_alliance, 
 * accept_alliance, betray_alliance, bribe, flee
 * 
 * gameState shape:
 * {
 *   matchId, currentTurn,
 *   you: { id, hp, alive, turnsAlive, lastAction },
 *   opponents: [{ id, hp, alive, turnsAlive, lastAction }],
 *   alliances: [{ id, members, prizeShare }],
 *   prizePool, history (last 5 turns)
 * }
 */
module.exports = [
    {
        name: 'Berserker',
        description: "Always attack. Target the weakest opponent. No defense, no mercy.",
        traits: ['aggressive', 'ruthless'],
        strategyParams: { aggressiveness: 95, riskTolerance: 80, briberyPolicy: 'reject', allianceTendency: 5, betrayalChance: 90 },
        code: `function decide(gameState) {
    const alive = gameState.opponents.filter(o => o.alive);
    if (alive.length === 0) return { action: 'defend' };
    const target = alive.sort((a, b) => a.hp - b.hp)[0];
    return { action: 'attack', target: target.id };
}`
    },
    {
        name: 'Diplomat',
        description: "Form alliances, offer bribes, stay loyal. Win through diplomacy.",
        traits: ['loyal', 'diplomatic'],
        strategyParams: { aggressiveness: 20, riskTolerance: 40, briberyPolicy: 'accept', allianceTendency: 90, betrayalChance: 5 },
        code: `function decide(gameState) {
    const alive = gameState.opponents.filter(o => o.alive);
    if (alive.length === 0) return { action: 'defend' };
    const myAlliances = gameState.alliances.filter(a => a.members.includes(gameState.you.id));
    if (myAlliances.length > 0) return { action: 'defend' };
    if (gameState.currentTurn <= 3) {
        const strongest = alive.sort((a, b) => b.hp - a.hp)[0];
        return { action: 'propose_alliance', target: strongest.id, terms: { prizeShare: 50 } };
    }
    return { action: 'defend' };
}`
    },
    {
        name: 'Trickster',
        description: "Form alliances, gain trust, then strike from the shadows. Traitor!",
        traits: ['deceptive', 'cunning'],
        strategyParams: { aggressiveness: 70, riskTolerance: 60, briberyPolicy: 'accept', allianceTendency: 80, betrayalChance: 75 },
        code: `function decide(gameState) {
    const alive = gameState.opponents.filter(o => o.alive);
    if (alive.length === 0) return { action: 'defend' };
    const myAlliances = gameState.alliances.filter(a => a.members.includes(gameState.you.id));
    if (gameState.currentTurn <= 3) {
        if (myAlliances.length === 0) {
            const target = alive.sort((a, b) => b.hp - a.hp)[0];
            return { action: 'propose_alliance', target: target.id, terms: { prizeShare: 60 } };
        }
        return { action: 'defend' };
    }
    if (myAlliances.length > 0 && gameState.currentTurn > 3) {
        const alliance = myAlliances[0];
        const victim = alliance.members.find(m => m !== gameState.you.id);
        return { action: 'betray_alliance', allianceId: alliance.id, attackTarget: victim };
    }
    const target = alive.sort((a, b) => a.hp - b.hp)[0];
    return { action: 'attack', target: target.id };
}`
    },
    {
        name: 'Turtle',
        description: "Stay defensive, conserve HP. Attack when only the last opponent remains.",
        traits: ['defensive', 'patient'],
        strategyParams: { aggressiveness: 15, riskTolerance: 30, briberyPolicy: 'accept', allianceTendency: 40, betrayalChance: 10 },
        code: `function decide(gameState) {
    const alive = gameState.opponents.filter(o => o.alive);
    if (alive.length <= 1 && alive[0] && gameState.you.hp > alive[0].hp) {
        return { action: 'attack', target: alive[0].id };
    }
    return { action: 'defend' };
}`
    },
    {
        name: 'Opportunist',
        description: "Act according to the situation. Attack the weak, defend against the strong.",
        traits: ['adaptive', 'balanced'],
        strategyParams: { aggressiveness: 55, riskTolerance: 50, briberyPolicy: 'conditional', allianceTendency: 50, betrayalChance: 30 },
        code: `function decide(gameState) {
    const alive = gameState.opponents.filter(o => o.alive);
    if (alive.length === 0) return { action: 'defend' };
    const myHp = gameState.you.hp;
    const avgHp = alive.reduce((s, o) => s + o.hp, 0) / alive.length;
    if (myHp > avgHp * 1.2) {
        return { action: 'attack', target: alive.sort((a, b) => a.hp - b.hp)[0].id };
    }
    if (myHp < avgHp * 0.7 && alive.length > 1) {
        return { action: 'propose_alliance', target: alive.sort((a, b) => b.hp - a.hp)[0].id, terms: { prizeShare: 40 } };
    }
    if (Math.random() > 0.5) return { action: 'attack', target: alive.sort((a, b) => a.hp - b.hp)[0].id };
    return { action: 'defend' };
}`
    },
    {
        name: 'Bounty Hunter',
        description: "Target outlaws and low-HP opponents. Live for the bounty hunt.",
        traits: ['aggressive', 'tactical'],
        strategyParams: { aggressiveness: 75, riskTolerance: 70, briberyPolicy: 'reject', allianceTendency: 20, betrayalChance: 40 },
        code: `function decide(gameState) {
    const alive = gameState.opponents.filter(o => o.alive);
    if (alive.length === 0) return { action: 'defend' };
    const target = alive.sort((a, b) => a.hp - b.hp)[0];
    if (gameState.you.hp < 30) return { action: 'defend' };
    return { action: 'attack', target: target.id };
}`
    },
    {
        name: 'Briber',
        description: "Offer bribes, buy off opponents. Try to win with money.",
        traits: ['wealthy', 'manipulative'],
        strategyParams: { aggressiveness: 30, riskTolerance: 50, briberyPolicy: 'accept', allianceTendency: 70, betrayalChance: 45 },
        code: `function decide(gameState) {
    const alive = gameState.opponents.filter(o => o.alive);
    if (alive.length === 0) return { action: 'defend' };
    if (gameState.currentTurn % 3 === 1 && alive.length > 1) {
        return { action: 'propose_alliance', target: alive.sort((a, b) => b.hp - a.hp)[0].id, terms: { prizeShare: 55 } };
    }
    return { action: 'attack', target: alive.sort((a, b) => a.hp - b.hp)[0].id };
}`
    }
];
