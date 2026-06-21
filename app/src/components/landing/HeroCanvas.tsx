'use client';

import { useEffect, useRef } from 'react';

/**
 * Dependency-free animated hero: a slowly rotating wireframe globe, a parallax
 * starfield, and a few elliptical orbit rings. Mimics the Pendle space scene.
 * Pure client component (no SSR) drawn on a single canvas via requestAnimationFrame.
 */
export default function HeroCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    const context2d = canvasEl.getContext('2d');
    if (!context2d) return;
    // Non-null declared types so the closures below keep the narrowing.
    const canvas: HTMLCanvasElement = canvasEl;
    const ctx: CanvasRenderingContext2D = context2d;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let raf = 0;
    let stars: { x: number; y: number; z: number; r: number }[] = [];

    const STAR_COUNT = 320;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seedStars();
    }

    function seedStars() {
      stars = [];
      for (let i = 0; i < STAR_COUNT; i++) {
        stars.push({
          x: Math.random() * width,
          y: Math.random() * height,
          z: Math.random(),
          r: Math.random() * 1.3 + 0.2
        });
      }
    }

    // Globe geometry: latitude/longitude points on a unit sphere.
    const spherePoints: { x: number; y: number; z: number }[] = [];
    const LAT = 18;
    const LON = 36;
    for (let i = 0; i <= LAT; i++) {
      const theta = (i / LAT) * Math.PI; // 0..PI
      for (let j = 0; j < LON; j++) {
        const phi = (j / LON) * Math.PI * 2; // 0..2PI
        spherePoints.push({
          x: Math.sin(theta) * Math.cos(phi),
          y: Math.cos(theta),
          z: Math.sin(theta) * Math.sin(phi)
        });
      }
    }

    function draw(t: number) {
      ctx.clearRect(0, 0, width, height);

      // Globe centered slightly right and vertically centered.
      const cx = width * 0.5;
      const cy = height * 0.46;
      const radius = Math.min(width, height) * 0.32;

      // Starfield with subtle parallax drift.
      const drift = t * 0.004;
      for (const s of stars) {
        const px = (s.x + drift * (0.3 + s.z)) % width;
        const alpha = 0.25 + s.z * 0.6;
        ctx.beginPath();
        ctx.arc(px, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(200, 220, 255, ${alpha})`;
        ctx.fill();
      }

      const rotY = t * 0.00025;
      const rotX = 0.42;
      const cosY = Math.cos(rotY);
      const sinY = Math.sin(rotY);
      const cosX = Math.cos(rotX);
      const sinX = Math.sin(rotX);

      // Orbit rings (elliptical) behind/around the globe.
      ctx.save();
      ctx.translate(cx, cy);
      const rings = [
        { rx: radius * 1.9, ry: radius * 0.55, rot: 0.3 + t * 0.00008, a: 0.18 },
        { rx: radius * 1.55, ry: radius * 0.42, rot: -0.5 - t * 0.00012, a: 0.14 },
        { rx: radius * 2.25, ry: radius * 0.7, rot: 0.9 + t * 0.00005, a: 0.1 }
      ];
      for (const ring of rings) {
        ctx.save();
        ctx.rotate(ring.rot);
        ctx.beginPath();
        ctx.ellipse(0, 0, ring.rx, ring.ry, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(80, 220, 200, ${ring.a})`;
        ctx.lineWidth = 1;
        ctx.stroke();
        // a moving node along the ring
        const ang = t * 0.0006 * (ring.a * 8 + 1);
        ctx.beginPath();
        ctx.arc(Math.cos(ang) * ring.rx, Math.sin(ang) * ring.ry, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(120, 245, 220, 0.9)';
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();

      // Globe wireframe points.
      for (const p of spherePoints) {
        // rotate around Y
        let x = p.x * cosY - p.z * sinY;
        let z = p.x * sinY + p.z * cosY;
        let y = p.y;
        // tilt around X
        const y2 = y * cosX - z * sinX;
        const z2 = y * sinX + z * cosX;
        y = y2;
        z = z2;

        const depth = (z + 1.6) / 2.6; // 0..~1 front brighter
        const sx = cx + x * radius;
        const sy = cy + y * radius;
        const size = 0.6 + depth * 1.6;
        const alpha = 0.12 + depth * 0.6;
        ctx.beginPath();
        ctx.arc(sx, sy, size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(110, 231, 207, ${alpha})`;
        ctx.fill();
        void x;
      }

      // Soft glow halo.
      const grad = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius * 1.6);
      grad.addColorStop(0, 'rgba(34, 211, 184, 0.10)');
      grad.addColorStop(1, 'rgba(10, 14, 20, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);

      raf = requestAnimationFrame(draw);
    }

    resize();
    window.addEventListener('resize', resize);
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden="true" />;
}
