import React, { useRef } from 'react';
import { SoftShadows } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';

export function Lights() {
    const sunRef = useRef();

    useFrame(({ clock }) => {
        if (sunRef.current) {
            sunRef.current.position.x = Math.sin(clock.elapsedTime * 0.1) * 20 - 20;
            sunRef.current.position.z = Math.cos(clock.elapsedTime * 0.1) * 20 + 15;
        }
    });

    return (
        <>
            <hemisphereLight args={['#ffeebb', '#362a1a', 0.6]} />
            <ambientLight intensity={0.3} color="#ffeebb" />

            {/* Sun */}
            <directionalLight
                ref={sunRef}
                position={[-20, 50, 15]}
                intensity={2.5}
                castShadow
                shadow-mapSize={[2048, 2048]}
                shadow-bias={-0.0005}
            >
                <orthographicCamera attach="shadow-camera" args={[-30, 30, 30, -30]} />
            </directionalLight>

            {/* Center Crystal Glow */}
            <pointLight position={[0, 6, 0]} intensity={5} distance={50} color="#8b5cf6" />

            {/* Soft Shadows for realism */}
            <SoftShadows size={15} samples={10} focus={0.5} />
        </>
    );
}