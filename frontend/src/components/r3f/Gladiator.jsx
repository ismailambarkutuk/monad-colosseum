import React, { useRef, useImperativeHandle, forwardRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import gsap from 'gsap';

export const Gladiator = forwardRef(({ id, name, hp, maxHp = 100, alive, position, rotation }, ref) => {
    const group = useRef();
    const bodyRef = useRef();
    const rightArmRef = useRef();
    const leftArmRef = useRef();
    const materialRef = useRef();

    // Randomize appearance based on ID
    const appearance = useMemo(() => {
        const seed = (id || '0').charCodeAt(0) || 65;
        return {
            bodyColor: new THREE.Color().setHSL((seed * 37 % 360) / 360, 0.6, 0.5),
            armorColor: new THREE.Color().setHSL((seed * 37 % 360) / 360, 0.3, 0.35),
        };
    }, [id]);

    const hpPercent = (hp / maxHp) * 100;
    const hpColor = hpPercent > 50 ? '#22c55e' : hpPercent > 20 ? '#eab308' : '#ef4444';

    useImperativeHandle(ref, () => ({
        attack: (targetPos) => {
            if (!group.current || !rightArmRef.current) return;
            const startPos = group.current.position.clone();
            const forward = new THREE.Vector3(0, 0, 2).applyQuaternion(group.current.quaternion);

            gsap.to(group.current.position, {
                x: startPos.x + forward.x,
                z: startPos.z + forward.z,
                duration: 0.2,
                yoyo: true,
                repeat: 1,
                ease: "power2.out"
            });

            // Swing sword
            gsap.to(rightArmRef.current.rotation, {
                x: -Math.PI / 2,
                duration: 0.15,
                yoyo: true,
                repeat: 1,
            });
        },
        takeDamage: () => {
            if (!materialRef.current || !group.current) return;
            const originalColor = materialRef.current.color.clone();
            const originalEmissive = materialRef.current.emissive.clone();

            materialRef.current.color.set('#ff0000');
            materialRef.current.emissive.set('#ff0000');
            materialRef.current.emissiveIntensity = 2;

            gsap.to(group.current.position, {
                x: group.current.position.x + (Math.random() - 0.5) * 0.5,
                z: group.current.position.z + (Math.random() - 0.5) * 0.5,
                duration: 0.05,
                yoyo: true,
                repeat: 3
            });

            setTimeout(() => {
                if (materialRef.current) {
                    materialRef.current.color.copy(originalColor);
                    materialRef.current.emissive.copy(originalEmissive);
                    materialRef.current.emissiveIntensity = 0.3;
                }
            }, 300);
        }
    }));

    useFrame((state) => {
        if (!alive || !group.current || !bodyRef.current) return;
        const t = state.clock.elapsedTime;
        bodyRef.current.position.y = 0.9 + Math.sin(t * 2) * 0.02;
        if (rightArmRef.current) rightArmRef.current.rotation.z = Math.sin(t * 1.5) * 0.05;
        if (leftArmRef.current) leftArmRef.current.rotation.z = -Math.sin(t * 1.5) * 0.05;
    });

    if (!alive) return null;

    return (
        <group ref={group} position={position} rotation={rotation}>
            {/* HP Bar */}
            <Html position={[0, 2.8, 0]} center sprite>
                <div style={{ pointerEvents: 'none', textAlign: 'center', width: '80px' }}>
                    <div style={{
                        background: 'rgba(0,0,0,0.7)',
                        padding: '2px',
                        borderRadius: '4px',
                        border: '1px solid #555'
                    }}>
                        <div style={{
                            height: '5px',
                            width: `${Math.max(0, hpPercent)}%`,
                            background: hpColor,
                            borderRadius: '2px',
                            transition: 'width 0.3s ease'
                        }} />
                    </div>
                    <div style={{
                        color: '#fff',
                        fontSize: '10px',
                        fontWeight: 'bold',
                        textShadow: '0 1px 3px rgba(0,0,0,0.9)',
                        marginTop: '2px'
                    }}>
                        {name || (id || '?').slice(0, 8)}
                    </div>
                </div>
            </Html>

            {/* Character Body */}
            <group ref={bodyRef} position={[0, 0.9, 0]}>
                {/* Torso (Armor) */}
                <mesh castShadow>
                    <cylinderGeometry args={[0.28, 0.22, 0.8, 8]} />
                    <meshStandardMaterial ref={materialRef} color={appearance.armorColor} roughness={0.3} metalness={0.8} emissive={appearance.armorColor} emissiveIntensity={0.3} />
                </mesh>

                {/* Head (Helmet) */}
                <mesh position={[0, 0.55, 0]} castShadow>
                    <boxGeometry args={[0.32, 0.32, 0.32]} />
                    <meshStandardMaterial color={appearance.armorColor} roughness={0.2} metalness={0.9} />
                </mesh>
                {/* Visor (Glowing Eyes) */}
                <mesh position={[0, 0.55, 0.14]}>
                    <boxGeometry args={[0.22, 0.06, 0.08]} />
                    <meshBasicMaterial color="#00ffcc" />
                </mesh>

                {/* Right Arm + Sword */}
                <group ref={rightArmRef} position={[0.35, 0.15, 0]}>
                    <mesh position={[0, -0.22, 0]} castShadow>
                        <capsuleGeometry args={[0.07, 0.44, 4, 8]} />
                        <meshStandardMaterial color={appearance.bodyColor} />
                    </mesh>
                    {/* Sword */}
                    <group position={[0, -0.5, 0.1]} rotation={[0.4, 0, 0]}>
                        <mesh position={[0, 0.35, 0]} castShadow>
                            <boxGeometry args={[0.04, 0.7, 0.02]} />
                            <meshStandardMaterial color="#ddd" metalness={1} roughness={0.1} />
                        </mesh>
                        <mesh>
                            <boxGeometry args={[0.14, 0.03, 0.06]} />
                            <meshStandardMaterial color="#654321" />
                        </mesh>
                    </group>
                </group>

                {/* Left Arm + Shield */}
                <group ref={leftArmRef} position={[-0.35, 0.15, 0]}>
                    <mesh position={[0, -0.22, 0]} castShadow>
                        <capsuleGeometry args={[0.07, 0.44, 4, 8]} />
                        <meshStandardMaterial color={appearance.bodyColor} />
                    </mesh>
                    {/* Shield */}
                    <group position={[-0.05, -0.2, 0.12]}>
                        <mesh castShadow>
                            <cylinderGeometry args={[0.25, 0.25, 0.04, 12]} />
                            <meshStandardMaterial color="#555" metalness={0.6} roughness={0.5} />
                        </mesh>
                        <mesh position={[0, 0, 0.025]}>
                            <cylinderGeometry args={[0.08, 0.08, 0.02, 8]} />
                            <meshStandardMaterial color={appearance.armorColor} emissive={appearance.armorColor} emissiveIntensity={0.6} />
                        </mesh>
                    </group>
                </group>

                {/* Legs */}
                <mesh position={[0.12, -0.7, 0]} castShadow>
                    <capsuleGeometry args={[0.08, 0.6, 4, 8]} />
                    <meshStandardMaterial color={appearance.armorColor} roughness={0.5} />
                </mesh>
                <mesh position={[-0.12, -0.7, 0]} castShadow>
                    <capsuleGeometry args={[0.08, 0.6, 4, 8]} />
                    <meshStandardMaterial color={appearance.armorColor} roughness={0.5} />
                </mesh>
            </group>
        </group>
    );
});