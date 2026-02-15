import { useMemo } from 'react';
import * as THREE from 'three';

export function useArenaTextures() {
    const textures = useMemo(() => {
        // ═════════════════════════════════════════════════════════════════════════
        // SAND TEXTURE
        // ═════════════════════════════════════════════════════════════════════════
        const sandCanvas = document.createElement('canvas');
        sandCanvas.width = 512; sandCanvas.height = 512;
        const ctxSand = sandCanvas.getContext('2d');

        // Base Color
        ctxSand.fillStyle = '#d4b87a';
        ctxSand.fillRect(0, 0, 512, 512);

        // Noise
        const sandData = ctxSand.getImageData(0, 0, 512, 512);
        const dSand = sandData.data;
        for (let i = 0; i < dSand.length; i += 4) {
            const noise = (Math.random() - 0.5) * 40;
            dSand[i] = Math.max(0, Math.min(255, dSand[i] + noise));
            dSand[i + 1] = Math.max(0, Math.min(255, dSand[i + 1] + noise * 0.8));
            dSand[i + 2] = Math.max(0, Math.min(255, dSand[i + 2] + noise * 0.5));
        }
        ctxSand.putImageData(sandData, 0, 0);

        // Dark patches
        for (let i = 0; i < 30; i++) {
            const x = Math.random() * 512, y = Math.random() * 512, r = 10 + Math.random() * 40;
            ctxSand.beginPath();
            ctxSand.arc(x, y, r, 0, Math.PI * 2);
            ctxSand.fillStyle = `rgba(160, 130, 80, ${0.05 + Math.random() * 0.08})`;
            ctxSand.fill();
        }

        const sandTex = new THREE.CanvasTexture(sandCanvas);
        sandTex.wrapS = THREE.RepeatWrapping;
        sandTex.wrapT = THREE.RepeatWrapping;
        sandTex.repeat.set(4, 4);

        // ═════════════════════════════════════════════════════════════════════════
        // STONE TEXTURE
        // ═════════════════════════════════════════════════════════════════════════
        const stoneCanvas = document.createElement('canvas');
        stoneCanvas.width = 512; stoneCanvas.height = 512;
        const ctxStone = stoneCanvas.getContext('2d');

        // Base Color
        ctxStone.fillStyle = '#d4c4a0';
        ctxStone.fillRect(0, 0, 512, 512);

        // Noise
        const stoneData = ctxStone.getImageData(0, 0, 512, 512);
        const dStone = stoneData.data;
        for (let i = 0; i < dStone.length; i += 4) {
            const noise = (Math.random() - 0.5) * 30;
            dStone[i] = Math.max(0, Math.min(255, dStone[i] + noise));
            dStone[i + 1] = Math.max(0, Math.min(255, dStone[i + 1] + noise));
            dStone[i + 2] = Math.max(0, Math.min(255, dStone[i + 2] + noise));
        }
        ctxStone.putImageData(stoneData, 0, 0);

        // Bricks
        ctxStone.strokeStyle = 'rgba(100, 90, 70, 0.4)';
        ctxStone.lineWidth = 2;
        const bH = 64, bW = 128;
        for (let y = 0; y < 512; y += bH) {
            ctxStone.beginPath();
            ctxStone.moveTo(0, y);
            ctxStone.lineTo(512, y);
            ctxStone.stroke();
            const offset = (y / bH) % 2 === 0 ? 0 : bW / 2;
            for (let x = -bW; x < 512; x += bW) {
                ctxStone.beginPath();
                ctxStone.moveTo(x + offset, y);
                ctxStone.lineTo(x + offset, y + bH);
                ctxStone.stroke();
            }
        }

        // Grunge
        for (let i = 0; i < 40; i++) {
            const x = Math.random() * 512, y = Math.random() * 512, r = 5 + Math.random() * 20;
            ctxStone.beginPath();
            ctxStone.arc(x, y, r, 0, Math.PI * 2);
            ctxStone.fillStyle = `rgba(80, 70, 60, ${0.05 + Math.random() * 0.1})`;
            ctxStone.fill();
        }

        const stoneTex = new THREE.CanvasTexture(stoneCanvas);
        stoneTex.wrapS = THREE.RepeatWrapping;
        stoneTex.wrapT = THREE.RepeatWrapping;
        stoneTex.repeat.set(2, 2);

        return { sandTex, stoneTex };
    }, []);

    return textures;
}