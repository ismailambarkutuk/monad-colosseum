import React, { useMemo } from 'react';
import * as THREE from 'three';
import { useArenaTextures } from '../../hooks/useArenaTextures';
import { Instances, Instance, Sparkles } from '@react-three/drei';

const ARENA_RADIUS = 42;
const TIER_COUNT = 5;

export function MapGeometry() {
    const { sandTex, stoneTex } = useArenaTextures();

    // Column positions
    const columns = useMemo(() => {
        const cols = [];
        const count = 16;
        const R = ARENA_RADIUS + 1;
        for (let i = 0; i < count; i++) {
            const angle = (Math.PI * 2 / count) * i;
            cols.push({
                position: [R * Math.cos(angle), 7, R * Math.sin(angle)],
                rotation: [0, -angle, 0]
            });
        }
        return cols;
    }, []);

    // Seating Tiers
    const tiers = useMemo(() => {
        const ts = [];
        const baseR = ARENA_RADIUS + 0.5;
        for (let i = 0; i < TIER_COUNT; i++) {
            const innerR = baseR + i * 3;
            const outerR = innerR + 2.8;
            const h = 2.0 + i * 2.5;
            ts.push(<mesh key={i} position={[0, h - 1 + 3, 0]} receiveShadow>
                <cylinderGeometry args={[outerR, innerR, 2, 48, 1, true]} />
                <meshStandardMaterial map={stoneTex} color={i % 2 === 0 ? "#d4c4a0" : "#baa882"} />
            </mesh>);
        }
        return ts;
    }, [stoneTex]);

    // Torches on columns
    const torches = useMemo(() => {
        return columns.map((col, i) => (
            <group key={`torch-${i}`} position={[col.position[0] * 0.95, 6, col.position[2] * 0.95]} rotation={col.rotation}>
                {/* Stick */}
                <mesh position={[0, -0.5, 0.4]} rotation={[Math.PI / 4, 0, 0]}>
                    <cylinderGeometry args={[0.05, 0.05, 1.5]} />
                    <meshStandardMaterial color="#421" />
                </mesh>
                {/* Fire Light */}
                <pointLight position={[0, 0, 0.8]} color="orange" intensity={3} distance={10} decay={2} castShadow />
                {/* Fire Particles */}
                <mesh position={[0, 0, 0.8]}>
                    <dodecahedronGeometry args={[0.2, 0]} />
                    <meshBasicMaterial color="#ffaa00" emissive="#ffaa00" emissiveIntensity={2} />
                </mesh>
                <Sparkles count={5} scale={0.4} size={4} speed={0.4} opacity={1} color="#ff5500" position={[0, 0, 0.8]} />
            </group>
        ));
    }, [columns]);

    // Crowd (Sparkles on tiers)
    const crowd = useMemo(() => {
        return (
            <group position={[0, 5, 0]}>
                <Sparkles
                    count={2000}
                    scale={[ARENA_RADIUS * 2.5, 10, ARENA_RADIUS * 2.5]}
                    size={4}
                    speed={0.4}
                    opacity={0.8}
                    color="#ffaa00"
                    noise={1}
                />
            </group>
        );
    }, []);

    return (
        <group>
            {/* Floor */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow>
                <circleGeometry args={[ARENA_RADIUS, 48]} />
                <meshStandardMaterial map={sandTex} color="#d4b87a" roughness={0.9} />
            </mesh>

            {/* Walls */}
            <mesh position={[0, 10, 0]} receiveShadow castShadow>
                <cylinderGeometry args={[ARENA_RADIUS + 20, ARENA_RADIUS + 20, 20, 32, 1, true]} />
                <meshStandardMaterial map={stoneTex} side={THREE.DoubleSide} />
            </mesh>

            {/* Columns (Instanced) */}
            <Instances range={columns.length}>
                <cylinderGeometry args={[0.8, 1.0, 14, 16]} />
                <meshStandardMaterial map={stoneTex} />
                {columns.map((c, i) => (
                    <Instance key={i} position={c.position} rotation={c.rotation} />
                ))}
            </Instances>

            {/* Tiers */}
            {tiers}

            {/* Torches */}
            {torches}

            {/* Crowd */}
            {crowd}

            {/* Atmospheric Dust */}
            <Sparkles count={500} scale={[ARENA_RADIUS * 1.5, 10, ARENA_RADIUS * 1.5]} size={2} speed={0.2} opacity={0.3} color="#fff" />
        </group>
    );
}