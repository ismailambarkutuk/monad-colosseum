import React, { useMemo, useRef, useEffect, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Html, Sparkles, QuadraticBezierLine } from '@react-three/drei';
import * as THREE from 'three';
import gsap from 'gsap';

/* ─── Inline Arena Floor ─── */
function ArenaFloor() {
    return (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]} receiveShadow>
            <circleGeometry args={[30, 64]} />
            <meshStandardMaterial color="#c9a96e" roughness={0.95} />
        </mesh>
    );
}

/* ─── Inline Arena Walls ─── */
function ArenaWalls() {
    return (
        <group>
            {/* Outer wall */}
            <mesh position={[0, 5, 0]} receiveShadow castShadow>
                <cylinderGeometry args={[35, 35, 10, 48, 1, true]} />
                <meshStandardMaterial color="#b8a07a" side={THREE.DoubleSide} roughness={0.8} />
            </mesh>
            {/* Inner wall rim */}
            <mesh position={[0, 1.5, 0]}>
                <cylinderGeometry args={[31, 31, 3, 48, 1, true]} />
                <meshStandardMaterial color="#9a8a6a" side={THREE.DoubleSide} roughness={0.7} />
            </mesh>
        </group>
    );
}

/* ─── Inline Columns ─── */
function ArenaColumns() {
    const columns = useMemo(() => {
        const cols = [];
        const count = 12;
        const R = 32;
        for (let i = 0; i < count; i++) {
            const angle = (Math.PI * 2 / count) * i;
            cols.push([R * Math.cos(angle), 5, R * Math.sin(angle)]);
        }
        return cols;
    }, []);

    return (
        <group>
            {columns.map((pos, i) => (
                <mesh key={i} position={pos} castShadow>
                    <cylinderGeometry args={[0.6, 0.8, 10, 8]} />
                    <meshStandardMaterial color="#c4b090" roughness={0.6} />
                </mesh>
            ))}
        </group>
    );
}

/* ─── Inline Torches ─── */
function Torches() {
    const positions = useMemo(() => {
        const pts = [];
        const count = 8;
        const R = 31;
        for (let i = 0; i < count; i++) {
            const angle = (Math.PI * 2 / count) * i;
            pts.push([R * Math.cos(angle), 4, R * Math.sin(angle)]);
        }
        return pts;
    }, []);

    return (
        <group>
            {positions.map((pos, i) => (
                <group key={i} position={pos}>
                    {/* Torch stick */}
                    <mesh position={[0, -1, 0]}>
                        <cylinderGeometry args={[0.05, 0.05, 2]} />
                        <meshStandardMaterial color="#5a3a1a" />
                    </mesh>
                    {/* Flame glow */}
                    <mesh position={[0, 0.2, 0]}>
                        <sphereGeometry args={[0.15, 8, 8]} />
                        <meshBasicMaterial color="#ff8800" />
                    </mesh>
                    <pointLight position={[0, 0.3, 0]} color="#ff6600" intensity={2} distance={15} decay={2} />
                </group>
            ))}
        </group>
    );
}

/* ─── Lightning Effect ─── */
function LightningBolt({ start, end, onComplete }) {
    const [opacity, setOpacity] = useState(1);

    // Generate clearer, thicker bolt
    const points = useMemo(() => {
        const startVec = new THREE.Vector3(...start);
        startVec.y += 2.0; // Start high (head/weapon level)
        const endVec = new THREE.Vector3(...end);
        endVec.y += 1.0; // Hit torso

        // Midpoint control for arc
        const mid = new THREE.Vector3().lerpVectors(startVec, endVec, 0.5);
        mid.y += 2.0; // Arch up
        mid.x += (Math.random() - 0.5) * 2;

        return { start: startVec, end: endVec, mid };
    }, [start, end]);

    useFrame((state, delta) => {
        if (opacity <= 0) {
            onComplete && onComplete();
            return;
        }
        setOpacity(prev => prev - delta * 3.0); // Fast fade
    });

    if (opacity <= 0) return null;

    return (
        <group>
            {/* Core beam */}
            <QuadraticBezierLine
                start={points.start}
                end={points.end}
                mid={points.mid}
                color="#00ffff"
                lineWidth={5}
                transparent
                opacity={opacity}
            />
            {/* Glow beam */}
            <QuadraticBezierLine
                start={points.start}
                end={points.end}
                mid={points.mid}
                color="#ffffff"
                lineWidth={2}
                transparent
                opacity={opacity}
            />
        </group>
    );
}

/* ─── Mecha Gladiator ─── */
const MechaGladiator = React.forwardRef(({ id, name, hp, maxHp = 100, alive, position, rotation }, ref) => {
    const group = useRef();
    const torsoRef = useRef();
    const rightArmRef = useRef();
    const materialRef = useRef();

    // State
    const [damageNumbers, setDamageNumbers] = React.useState([]);
    const [currentHp, setCurrentHp] = useState(hp);
    const [isDead, setIsDead] = React.useState(!alive || hp <= 0);

    // Sync HP from props
    useEffect(() => {
        setCurrentHp(hp);
        if (hp <= 0 || !alive) setIsDead(true);
    }, [hp, alive]);

    // Color generation - Use Hex for safety
    const seed = (id || 'A').charCodeAt(0) || 65;
    const colors = useMemo(() => {
        const h = (seed * 137 % 360);
        return {
            primary: new THREE.Color().setHSL(h / 360, 0.7, 0.3),
            secondary: new THREE.Color().setHSL(h / 360, 0.5, 0.1),
            core: new THREE.Color().setHSL((h + 180) / 360, 1.0, 0.6)
        };
    }, [seed]);

    const hpPct = Math.max(0, (currentHp / maxHp) * 100);
    const hpColor = hpPct > 50 ? '#22c55e' : hpPct > 20 ? '#eab308' : '#ef4444';

    // Death Anim
    useEffect(() => {
        if (isDead && group.current) {
            gsap.to(group.current.rotation, { x: -Math.PI / 2, duration: 0.5 });
            gsap.to(group.current.position, { y: 0.2, duration: 0.5 });
        }
    }, [isDead]);

    React.useImperativeHandle(ref, () => ({
        attack: (targetPos) => {
            if (!group.current || !rightArmRef.current || isDead) return;

            // Rotate to target
            if (targetPos) {
                const dummy = new THREE.Object3D();
                dummy.position.copy(group.current.position);
                dummy.lookAt(targetPos[0], group.current.position.y, targetPos[2]);
                gsap.to(group.current.rotation, { y: dummy.rotation.y, duration: 0.3 });
            }

            // Swing
            gsap.to(rightArmRef.current.rotation, { x: -Math.PI, duration: 0.15, yoyo: true, repeat: 1 });
            // Lunge
            gsap.to(group.current.position, {
                x: group.current.position.x + Math.sin(rotation[1]) * 1.5,
                z: group.current.position.z + Math.cos(rotation[1]) * 1.5,
                duration: 0.2,
                yoyo: true,
                repeat: 1
            });
        },
        takeDamage: (amount = 0) => {
            if (!materialRef.current || !group.current || isDead) return;

            // Reduce HP locally for instant feedback
            setCurrentHp(prev => Math.max(0, prev - amount));

            // Damage Number
            const dmgId = Date.now() + Math.random();
            setDamageNumbers(prev => [...prev, { id: dmgId, amount }]);
            setTimeout(() => setDamageNumbers(prev => prev.filter(d => d.id !== dmgId)), 800);

            // Flash
            materialRef.current.color.set('#ff0000');
            setTimeout(() => materialRef.current?.color.copy(colors.primary), 200);

            // Shake
            gsap.to(group.current.position, { x: "+=0.2", duration: 0.05, yoyo: true, repeat: 5 });

            if (currentHp - amount <= 0) setIsDead(true);
        }
    }));

    useFrame((state) => {
        if (isDead || !torsoRef.current) return;
        // Bobbing animation on TORSO only
        // Corrected base Y to 0.35 to match legs (Leg top ~0.8)
        torsoRef.current.position.y = 0.35 + Math.sin(state.clock.elapsedTime * 2 + seed) * 0.05;
    });

    if (!alive && !isDead) return null; // Hide if initially dead and no anim triggered?

    return (
        <group ref={group} position={position} rotation={rotation}>
            {/* HP Bar */}
            {!isDead && (
                <Html position={[0, 2.8, 0]} center sprite>
                    <div style={{ width: '60px', background: 'rgba(0,0,0,0.8)', padding: '2px', border: '1px solid #444', borderRadius: '3px' }}>
                        <div style={{ height: '4px', width: `${hpPct}%`, background: hpColor, transition: 'width 0.2s' }} />
                    </div>
                </Html>
            )}

            {/* Damage Numbers */}
            {damageNumbers.map(dn => (
                <Html key={dn.id} position={[0, 2, 0]} center>
                    <div style={{ color: '#ff3333', fontWeight: 'bold', fontSize: '24px', textShadow: '0 0 5px black', animation: 'floatUp 0.8s forwards' }}>-{dn.amount}</div>
                </Html>
            ))}

            {/* Legs - Static relative to group */}
            <group>
                <mesh position={[0.2, 0.4, 0]} castShadow>
                    <boxGeometry args={[0.25, 0.8, 0.3]} />
                    <meshStandardMaterial color={colors.secondary} />
                </mesh>
                <mesh position={[-0.2, 0.4, 0]} castShadow>
                    <boxGeometry args={[0.25, 0.8, 0.3]} />
                    <meshStandardMaterial color={colors.secondary} />
                </mesh>
            </group>

            {/* Torso Group - Animates up/down */}
            <group ref={torsoRef}>
                {/* Core Body */}
                <mesh position={[0, 0.5, 0]} castShadow>
                    <boxGeometry args={[0.6, 0.7, 0.4]} />
                    <meshStandardMaterial ref={materialRef} color={colors.primary} roughness={0.3} metalness={0.8} />
                </mesh>

                {/* Glowing Core */}
                <mesh position={[0, 0.5, 0.21]}>
                    <circleGeometry args={[0.15, 32]} />
                    <meshBasicMaterial color={colors.core} />
                </mesh>

                {/* Head */}
                <mesh position={[0, 1.1, 0]}>
                    <boxGeometry args={[0.3, 0.3, 0.3]} />
                    <meshStandardMaterial color={colors.secondary} />
                </mesh>
                {/* Eyes */}
                <mesh position={[0, 1.15, 0.16]}>
                    <boxGeometry args={[0.2, 0.05, 0.02]} />
                    <meshBasicMaterial color="cyan" />
                </mesh>

                {/* Right Arm */}
                <group ref={rightArmRef} position={[0.4, 0.7, 0]}>
                    <mesh position={[0, -0.4, 0]}>
                        <boxGeometry args={[0.2, 0.8, 0.2]} />
                        <meshStandardMaterial color={colors.secondary} />
                    </mesh>
                    {/* Weapon */}
                    <mesh position={[0, -0.7, 0.2]} rotation={[0.5, 0, 0]}>
                        <boxGeometry args={[0.1, 0.1, 1.2]} />
                        <meshStandardMaterial color="#ddd" emissive="#555" />
                    </mesh>
                </group>

                {/* Left Arm */}
                <group position={[-0.4, 0.7, 0]}>
                    <mesh position={[0, -0.4, 0]}>
                        <boxGeometry args={[0.2, 0.8, 0.2]} />
                        <meshStandardMaterial color={colors.secondary} />
                    </mesh>
                </group>
            </group>
        </group>
    );
});

/* ─── Inner Scene Component (Runs inside Canvas) ─── */
function ArenaInner({ agents, events }) {
    const gladiatorRefs = useRef({});
    const processedEvents = useRef(new Set());
    const [bolts, setBolts] = useState([]);

    // Event Queue for sequential execution
    const eventQueue = useRef([]);
    const isProcessing = useRef(false);
    const processTimer = useRef(0);

    const DEMO_GLADIATORS = useMemo(() => [
        { id: 'g1', name: 'Alpha', hp: 90, maxHp: 100, alive: true },
        { id: 'g2', name: 'Beta', hp: 60, maxHp: 100, alive: true },
        { id: 'g3', name: 'Omega', hp: 40, maxHp: 100, alive: true },
        { id: 'g4', name: 'Zeta', hp: 100, maxHp: 100, alive: true },
    ], []);

    const sanitizedAgents = useMemo(() => {
        if (!agents || !Array.isArray(agents)) return [];
        return agents.filter(a => a).map((a, i) => ({
            ...a,
            id: a.id || a.address || `agent_${i}`,
            name: a.name || `Unit ${i + 1}`,
            hp: typeof a.hp === 'number' ? a.hp : 100,
            maxHp: a.maxHp || 100,
            alive: a.alive !== false
        }));
    }, [agents]);

    const activeAgents = sanitizedAgents.length > 0 ? sanitizedAgents : DEMO_GLADIATORS;

    const placedAgents = useMemo(() => {
        const count = activeAgents.length;
        if (!count) return [];
        const R = 8;
        return activeAgents.map((agent, i) => {
            const angle = (Math.PI * 2 / count) * i;
            return {
                ...agent,
                position: [R * Math.cos(angle), 0, R * Math.sin(angle)],
                rotation: [0, -angle + Math.PI, 0]
            };
        });
    }, [activeAgents]);

    // 1. Push new events to queue
    useEffect(() => {
        if (!events || events.length === 0) return;
        events.forEach(event => {
            const signature = event.id || JSON.stringify(event);
            if (processedEvents.current.has(signature)) return;
            processedEvents.current.add(signature);
            eventQueue.current.push(event);
        });
    }, [events]);

    // 2. Process queue sequentially
    useFrame((state, delta) => {
        if (isProcessing.current) {
            processTimer.current -= delta;
            if (processTimer.current <= 0) {
                isProcessing.current = false;
            }
            return;
        }

        if (eventQueue.current.length > 0) {
            const event = eventQueue.current.shift();
            isProcessing.current = true;
            processTimer.current = 1.0; // 1 second per event

            const actorId = event.attackerId || event.agentId;
            const targetId = event.defenderId || event.victim;
            const actor = gladiatorRefs.current[actorId];
            const target = gladiatorRefs.current[targetId];

            // Trigger Animation
            if ((event.type === 'attack' || event.type === 'betrayal') && actor) {
                const tAgent = placedAgents.find(a => a.id === targetId);
                actor.attack(tAgent?.position);
            }

            // Trigger Damage delayed slightly to sync with impact
            if (event.type === 'attack' && target && event.damage > 0) {
                setTimeout(() => {
                    target.takeDamage(event.damage);
                    // Spawn Lightning
                    const aPos = placedAgents.find(a => a.id === actorId)?.position;
                    const tPos = placedAgents.find(a => a.id === targetId)?.position;
                    if (aPos && tPos) {
                        const id = Date.now() + Math.random();
                        setBolts(p => [...p, { id, start: aPos, end: tPos }]);
                    }
                }, 300); // 300ms impact delay
            }
        }
    });

    return (
        <group>
            {/* Environment */}
            <ArenaFloor />
            <ArenaWalls />
            <ArenaColumns />
            <Torches />
            <Sparkles count={200} scale={[40, 10, 40]} size={3} color="cyan" />

            {/* VFX */}
            {bolts.map(b => (
                <LightningBolt key={b.id} start={b.start} end={b.end} onComplete={() => setBolts(p => p.filter(x => x.id !== b.id))} />
            ))}

            {/* Gladiators */}
            {placedAgents.map(ag => (
                <MechaGladiator key={ag.id} {...ag} ref={(r) => gladiatorRefs.current[ag.id] = r} />
            ))}
        </group>
    );
}

/* ─── Main ArenaR3F Component (Wrapper) ─── */
export function ArenaR3F({ agents = [], events = [], className, style }) {
    return (
        <div className={className} style={{ width: '100%', height: '100%', minHeight: '400px', background: '#111', ...style }}>
            <Canvas shadows camera={{ position: [0, 20, 30], fov: 50 }}>
                <color attach="background" args={['#1a1a2e']} />
                <fog attach="fog" args={['#1a1a2e', 30, 100]} />
                <ambientLight intensity={0.5} color="#aaf" />
                <directionalLight position={[-10, 20, 10]} intensity={2} castShadow />
                <pointLight position={[0, 5, 0]} intensity={3} color="#f0f" distance={20} />

                {/* Inner Logic */}
                <ArenaInner agents={agents} events={events} />

                <OrbitControls autoRotate autoRotateSpeed={0.5} maxPolarAngle={Math.PI / 2.1} />
            </Canvas>
        </div>
    );
}