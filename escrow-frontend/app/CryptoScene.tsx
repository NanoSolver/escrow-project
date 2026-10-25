"use client";

import { useEffect, useRef, useState } from "react";
import type { Mesh } from "three";

/**
 * Full-bleed 3D hero background (three.js): an Ethereum-style crystal, orbiting coins,
 * and a drifting network of nodes that connect to your cursor. Move the mouse to tilt it,
 * click anywhere in the hero to make it spin and the coins fly outward.
 */
export default function CryptoScene() {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let cleanup = () => {};

    (async () => {
      const THREE = await import("three");
      if (disposed) return;

      let renderer: InstanceType<typeof THREE.WebGLRenderer>;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      } catch {
        return; // no WebGL: the dark gradient behind it stays
      }
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x000000, 0);
      el.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
      camera.position.set(0, 0, 9);

      scene.add(new THREE.AmbientLight(0xffffff, 0.6));
      const key = new THREE.DirectionalLight(0xffe2c2, 2.4);
      key.position.set(4, 5, 6);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x8fb4ff, 1.5);
      rim.position.set(-5, -2, -4);
      scene.add(rim);

      // Everything on the right-hand side lives in one rig so it can be repositioned on small screens.
      const rig = new THREE.Group();
      scene.add(rig);

      const crystalGeo = new THREE.OctahedronGeometry(1.25, 0);
      const crystal = new THREE.Mesh(
        crystalGeo,
        new THREE.MeshStandardMaterial({ color: 0xd4b797, metalness: 0.7, roughness: 0.22, flatShading: true }),
      );
      crystal.scale.set(1, 1.55, 1);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(crystalGeo),
        new THREE.LineBasicMaterial({ color: 0xfff1dc, transparent: true, opacity: 0.7 }),
      );
      edges.scale.copy(crystal.scale);
      const core = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.55, 0),
        new THREE.MeshBasicMaterial({ color: 0xffd9a8, transparent: true, opacity: 0.35, wireframe: true }),
      );
      core.scale.copy(crystal.scale);
      rig.add(crystal, edges, core);

      // Coins with an Ξ on the face.
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      const g = canvas.getContext("2d");
      if (g) {
        g.fillStyle = "#d4b797";
        g.fillRect(0, 0, 256, 256);
        g.strokeStyle = "#7a5f43";
        g.lineWidth = 10;
        g.beginPath();
        g.arc(128, 128, 112, 0, Math.PI * 2);
        g.stroke();
        g.fillStyle = "#3a2c1e";
        g.font = "bold 150px Georgia, serif";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText("Ξ", 128, 138);
      }
      const faceTex = new THREE.CanvasTexture(canvas);
      faceTex.colorSpace = THREE.SRGBColorSpace;
      const coinGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.07, 40);
      const sideMat = new THREE.MeshStandardMaterial({ color: 0xb8946b, metalness: 0.8, roughness: 0.3 });
      const faceMat = new THREE.MeshStandardMaterial({ map: faceTex, metalness: 0.5, roughness: 0.35 });
      const coins = Array.from({ length: 7 }, (_, i) => {
        const mesh = new THREE.Mesh(coinGeo, [sideMat, faceMat, faceMat]);
        rig.add(mesh);
        return { mesh, r: 2.3 + (i % 3) * 0.55, a: (i / 7) * Math.PI * 2, s: 0.18 + (i % 3) * 0.07, y: (i - 3) * 0.32, tilt: i * 0.9 };
      });

      // Drifting network of nodes. The last node is the cursor.
      const N = 90;
      const total = N + 1;
      const pos = new Float32Array(total * 3);
      const vel = new Float32Array(total * 3);
      const bounds = { x: 9, y: 5, zMin: -6, zMax: 2 };
      for (let i = 0; i < N; i++) {
        pos[i * 3] = (Math.random() * 2 - 1) * bounds.x;
        pos[i * 3 + 1] = (Math.random() * 2 - 1) * bounds.y;
        pos[i * 3 + 2] = bounds.zMin + Math.random() * (bounds.zMax - bounds.zMin);
        vel[i * 3] = (Math.random() - 0.5) * 0.25;
        vel[i * 3 + 1] = (Math.random() - 0.5) * 0.25;
        vel[i * 3 + 2] = (Math.random() - 0.5) * 0.1;
      }
      const pointGeo = new THREE.BufferGeometry();
      pointGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      scene.add(new THREE.Points(pointGeo, new THREE.PointsMaterial({ color: 0xd4b797, size: 0.07, transparent: true, opacity: 0.9 })));

      const maxSeg = total * 6;
      const linePos = new Float32Array(maxSeg * 6);
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
      lineGeo.setDrawRange(0, 0);
      scene.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0xd4b797, transparent: true, opacity: 0.2 })));

      const mouse = { x: 0, y: 0 };
      const smooth = { x: 0, y: 0 };
      const cursor = new THREE.Vector3(0, 0, 0);
      let impulse = 0;
      let baseY = 0.6;
      let visible = true;

      const layout = () => {
        const w = el.clientWidth || 1;
        const h = el.clientHeight || 1;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        if (camera.aspect < 1) {
          rig.position.set(0, 2.4, 0);
          rig.scale.setScalar(0.72);
          baseY = 2.4;
        } else if (camera.aspect > 2.6) {
          // short, wide banner (the escrow page)
          baseY = 0.1;
          rig.position.set(1.64 * camera.aspect, baseY, 0);
          rig.scale.setScalar(0.7);
        } else {
          baseY = 0.6;
          rig.position.set(1.64 * camera.aspect, baseY, 0);
          rig.scale.setScalar(1);
        }
      };

      const pointerToWorld = (clientX: number, clientY: number) => {
        const rect = el.getBoundingClientRect();
        const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
        const ny = -(((clientY - rect.top) / rect.height) * 2 - 1);
        const dir = new THREE.Vector3(nx, ny, 0.5).unproject(camera).sub(camera.position).normalize();
        cursor.copy(camera.position).add(dir.multiplyScalar(-camera.position.z / dir.z));
      };

      const onMove = (e: PointerEvent) => {
        mouse.x = Math.max(-1, Math.min(1, (e.clientX / window.innerWidth) * 2 - 1));
        mouse.y = Math.max(-1, Math.min(1, -((e.clientY / window.innerHeight) * 2 - 1)));
        pointerToWorld(e.clientX, e.clientY);
      };
      const onDown = (e: PointerEvent) => {
        if ((e.target as HTMLElement).closest("a, button, input, textarea, select, summary")) return;
        const rect = el.getBoundingClientRect();
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) impulse = 1;
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerdown", onDown);
      window.addEventListener("resize", layout);
      const io = new IntersectionObserver(([entry]) => (visible = entry.isIntersecting));
      io.observe(el);
      layout();

      const updateNetwork = (dt: number) => {
        for (let i = 0; i < N; i++) {
          const k = i * 3;
          pos[k] += vel[k] * dt;
          pos[k + 1] += vel[k + 1] * dt;
          pos[k + 2] += vel[k + 2] * dt;
          if (Math.abs(pos[k]) > bounds.x) vel[k] *= -1;
          if (Math.abs(pos[k + 1]) > bounds.y) vel[k + 1] *= -1;
          if (pos[k + 2] < bounds.zMin || pos[k + 2] > bounds.zMax) vel[k + 2] *= -1;
        }
        pos[N * 3] = cursor.x;
        pos[N * 3 + 1] = cursor.y;
        pos[N * 3 + 2] = cursor.z;
        pointGeo.attributes.position.needsUpdate = true;

        let seg = 0;
        for (let i = 0; i < total && seg < maxSeg; i++) {
          for (let j = i + 1; j < total && seg < maxSeg; j++) {
            const dx = pos[i * 3] - pos[j * 3];
            const dy = pos[i * 3 + 1] - pos[j * 3 + 1];
            const dz = pos[i * 3 + 2] - pos[j * 3 + 2];
            const limit = j === N ? 3.4 : 2.3; // the cursor reaches further
            if (dx * dx + dy * dy + dz * dz < limit * limit) {
              const o = seg * 6;
              linePos[o] = pos[i * 3];
              linePos[o + 1] = pos[i * 3 + 1];
              linePos[o + 2] = pos[i * 3 + 2];
              linePos[o + 3] = pos[j * 3];
              linePos[o + 4] = pos[j * 3 + 1];
              linePos[o + 5] = pos[j * 3 + 2];
              seg++;
            }
          }
        }
        lineGeo.setDrawRange(0, seg * 2);
        lineGeo.attributes.position.needsUpdate = true;
      };

      let last = performance.now();
      let raf = 0;
      const render = (now: number) => {
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;
        smooth.x += (mouse.x - smooth.x) * 0.06;
        smooth.y += (mouse.y - smooth.y) * 0.06;
        impulse *= Math.pow(0.04, dt);

        crystal.rotation.y += dt * (0.35 + impulse * 7);
        crystal.rotation.x = smooth.y * -0.35;
        crystal.rotation.z = smooth.x * 0.2;
        edges.rotation.copy(crystal.rotation);
        core.rotation.y -= dt * (0.6 + impulse * 5);
        core.rotation.x = crystal.rotation.x;
        rig.position.y = baseY + Math.sin(now / 1250) * 0.12;

        for (const c of coins) {
          c.a += c.s * dt * (1 + impulse * 4);
          const r = c.r * (1 + impulse * 0.4);
          c.mesh.position.set(Math.cos(c.a) * r, c.y + Math.sin(c.a * 2) * 0.1, Math.sin(c.a) * r);
          c.mesh.rotation.x += dt * 1.2;
          c.mesh.rotation.z = c.tilt;
        }

        camera.position.x += (smooth.x * 1.1 - camera.position.x) * 0.05;
        camera.position.y += (smooth.y * 0.7 - camera.position.y) * 0.05;
        camera.lookAt(0, 0, 0);

        updateNetwork(dt);
        renderer.render(scene, camera);
      };
      const loop = (now: number) => {
        raf = requestAnimationFrame(loop);
        if (visible && !document.hidden) render(now);
      };

      if (reduce) render(performance.now());
      else raf = requestAnimationFrame(loop);
      setReady(true);

      cleanup = () => {
        cancelAnimationFrame(raf);
        io.disconnect();
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerdown", onDown);
        window.removeEventListener("resize", layout);
        scene.traverse((o) => {
          const m = o as Mesh;
          m.geometry?.dispose();
          const mat = m.material;
          (Array.isArray(mat) ? mat : [mat]).forEach((x) => x?.dispose());
        });
        faceTex.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  return <div ref={host} className={`scene ${ready ? "ready" : ""}`} aria-hidden="true" />;
}
