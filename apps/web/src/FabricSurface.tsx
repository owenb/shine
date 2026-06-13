import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { SceneNode, SignalScene, SignalSurface } from "@sig/core";

type ClothParticle = {
  x: number;
  y: number;
  z: number;
  oldX: number;
  oldY: number;
  oldZ: number;
  baseX: number;
  baseY: number;
  baseZ: number;
  pinned: boolean;
};

type ClothConstraint = {
  a: number;
  b: number;
  rest: number;
};

type FabricRuntime = {
  textureCanvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  sceneGraph: { current: SignalScene };
};

export function FabricSurface({
  surface,
  scene: signalScene,
}: {
  surface: SignalSurface;
  scene: SignalScene | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<FabricRuntime | null>(null);
  const sceneGraph = useMemo(() => signalScene ?? fallbackScene(surface), [signalScene, surface]);
  const sceneSignature = useMemo(() => JSON.stringify(sceneGraph), [sceneGraph]);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    host.textContent = "";

    const width = 920;
    const height = 520;
    const textureCanvas = document.createElement("canvas");
    textureCanvas.width = width * 3;
    textureCanvas.height = height * 3;
    const sceneGraphRef = { current: sceneGraph };
    drawScene(textureCanvas, sceneGraphRef.current);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 100);
    camera.position.z = 6;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.domElement.className = "fabric-canvas";
    host.appendChild(renderer.domElement);

    const texture = new THREE.CanvasTexture(textureCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const segmentsX = 48;
    const segmentsY = 28;
    const geometry = new THREE.PlaneGeometry(5.6, 3.15, segmentsX, segmentsY);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    const particles = createClothParticles(geometry, segmentsX, segmentsY);
    const constraints = createClothConstraints(particles, segmentsX, segmentsY);
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const dragTarget = new THREE.Vector3();
    let pointerX = 0;
    let pointerY = 0;
    let draggedIndex: number | null = null;
    let dragStart: { x: number; y: number } | null = null;
    let dragMoved = false;
    let frame = 0;

    const updatePointer = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointerX = (event.clientX - rect.left) / rect.width - 0.5;
      pointerY = (event.clientY - rect.top) / rect.height - 0.5;
    };

    const hitFromEvent = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
      pointer.y = -(((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1);
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObject(mesh, false)[0];
    };

    const hotspotFromUv = (uv: THREE.Vector2) => {
      const activeScene = sceneGraphRef.current;
      const x = uv.x * activeScene.width;
      const y = (1 - uv.y) * activeScene.height;
      return activeScene.hotspots.find(
        (hotspot) =>
          x >= hotspot.x &&
          x <= hotspot.x + hotspot.width &&
          y >= hotspot.y &&
          y <= hotspot.y + hotspot.height,
      );
    };

    const particleIndexFromUv = (uv: THREE.Vector2) => {
      const col = Math.round(uv.x * segmentsX);
      const row = Math.round((1 - uv.y) * segmentsY);
      return clamp(row, 0, segmentsY) * (segmentsX + 1) + clamp(col, 0, segmentsX);
    };

    const onPointerMove = (event: PointerEvent) => {
      updatePointer(event);
      if (dragStart) {
        dragMoved ||= Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y) > 6;
      }
      if (draggedIndex !== null) {
        const hit = hitFromEvent(event);
        if (hit) {
          mesh.worldToLocal(dragTarget.copy(hit.point));
        }
        renderer.domElement.style.cursor = "grabbing";
        return;
      }
      const hit = hitFromEvent(event);
      renderer.domElement.style.cursor = hit?.uv && hotspotFromUv(hit.uv) ? "pointer" : "grab";
    };
    renderer.domElement.addEventListener("pointermove", onPointerMove);

    const onPointerDown = (event: PointerEvent) => {
      updatePointer(event);
      const hit = hitFromEvent(event);
      if (!hit?.uv) return;
      renderer.domElement.setPointerCapture(event.pointerId);
      dragStart = { x: event.clientX, y: event.clientY };
      dragMoved = false;
      draggedIndex = particleIndexFromUv(hit.uv);
      mesh.worldToLocal(dragTarget.copy(hit.point));
      renderer.domElement.style.cursor = "grabbing";
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);

    const onPointerUp = (event: PointerEvent) => {
      const hit = hitFromEvent(event);
      if (!dragMoved && hit?.uv) {
        const hotspot = hotspotFromUv(hit.uv);
        if (hotspot?.action.type === "openUrl") {
          window.open(hotspot.action.url, "_blank", "noopener,noreferrer");
        }
      }
      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId);
      }
      draggedIndex = null;
      dragStart = null;
      dragMoved = false;
      renderer.domElement.style.cursor = "grab";
    };
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointercancel", onPointerUp);
    renderer.domElement.style.cursor = "grab";
    runtimeRef.current = { textureCanvas, texture, sceneGraph: sceneGraphRef };

    const animate = () => {
      frame = requestAnimationFrame(animate);
      const t = performance.now() * 0.001;
      stepCloth(particles, constraints, draggedIndex, dragTarget, pointerX, pointerY, t);
      writeClothToGeometry(geometry, particles);
      mesh.rotation.x = -0.08 + pointerY * 0.08;
      mesh.rotation.y = pointerX * 0.14;
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointercancel", onPointerUp);
      geometry.dispose();
      material.dispose();
      texture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.sceneGraph.current = sceneGraph;
    drawScene(runtime.textureCanvas, sceneGraph);
    runtime.texture.needsUpdate = true;
  }, [sceneSignature]);

  return (
    <div className="surface-stage fabric-stage" ref={ref} aria-label="Fabric renderer">
      <div className="empty-widget" />
    </div>
  );
}

function createClothParticles(
  geometry: THREE.PlaneGeometry,
  segmentsX: number,
  segmentsY: number,
): ClothParticle[] {
  const positions = geometry.attributes.position.array as Float32Array;
  const particles: ClothParticle[] = [];
  for (let index = 0; index < positions.length; index += 3) {
    const vertex = index / 3;
    const row = Math.floor(vertex / (segmentsX + 1));
    const col = vertex % (segmentsX + 1);
    const x = positions[index];
    const y = positions[index + 1];
    const z = positions[index + 2];
    particles.push({
      x,
      y,
      z,
      oldX: x,
      oldY: y,
      oldZ: z,
      baseX: x,
      baseY: y,
      baseZ: z,
      pinned:
        (row === 0 || row === segmentsY) &&
        (col === 0 || col === segmentsX),
    });
  }
  return particles;
}

function createClothConstraints(
  particles: ClothParticle[],
  segmentsX: number,
  segmentsY: number,
): ClothConstraint[] {
  const constraints: ClothConstraint[] = [];
  const indexAt = (row: number, col: number) => row * (segmentsX + 1) + col;
  for (let row = 0; row <= segmentsY; row += 1) {
    for (let col = 0; col <= segmentsX; col += 1) {
      if (col < segmentsX) addConstraint(indexAt(row, col), indexAt(row, col + 1));
      if (row < segmentsY) addConstraint(indexAt(row, col), indexAt(row + 1, col));
      if (col < segmentsX && row < segmentsY) {
        addConstraint(indexAt(row, col), indexAt(row + 1, col + 1));
      }
    }
  }
  return constraints;

  function addConstraint(a: number, b: number) {
    const first = particles[a];
    const second = particles[b];
    constraints.push({
      a,
      b,
      rest: Math.hypot(first.baseX - second.baseX, first.baseY - second.baseY, first.baseZ - second.baseZ),
    });
  }
}

function stepCloth(
  particles: ClothParticle[],
  constraints: ClothConstraint[],
  draggedIndex: number | null,
  dragTarget: THREE.Vector3,
  pointerX: number,
  pointerY: number,
  time: number,
) {
  for (let index = 0; index < particles.length; index += 1) {
    const point = particles[index];
    if (point.pinned || index === draggedIndex) continue;

    const vx = (point.x - point.oldX) * 0.985;
    const vy = (point.y - point.oldY) * 0.985;
    const vz = (point.z - point.oldZ) * 0.975;
    point.oldX = point.x;
    point.oldY = point.y;
    point.oldZ = point.z;

    const breeze =
      Math.sin(point.baseX * 2.6 + time * 1.4) *
      Math.cos(point.baseY * 3.2 + time * 0.9) *
      0.0018;
    point.x += vx + (point.baseX - point.x) * 0.018 + pointerX * 0.0012;
    point.y += vy + (point.baseY - point.y) * 0.018 - pointerY * 0.0012;
    point.z += vz + breeze + (point.baseZ - point.z) * 0.034;
  }

  if (draggedIndex !== null) {
    const point = particles[draggedIndex];
    point.x += (dragTarget.x - point.x) * 0.65;
    point.y += (dragTarget.y - point.y) * 0.65;
    point.z += (0.32 - point.z) * 0.55;
    point.oldX = point.x;
    point.oldY = point.y;
    point.oldZ = point.z;
  }

  for (let iteration = 0; iteration < 4; iteration += 1) {
    for (const constraint of constraints) {
      satisfyConstraint(particles, constraint, draggedIndex);
    }
  }
}

function satisfyConstraint(
  particles: ClothParticle[],
  constraint: ClothConstraint,
  draggedIndex: number | null,
) {
  const first = particles[constraint.a];
  const second = particles[constraint.b];
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const dz = second.z - first.z;
  const distance = Math.hypot(dx, dy, dz) || 1;
  const offset = (distance - constraint.rest) / distance;
  const firstLocked = first.pinned || constraint.a === draggedIndex;
  const secondLocked = second.pinned || constraint.b === draggedIndex;
  const firstShare = firstLocked ? 0 : secondLocked ? 1 : 0.5;
  const secondShare = secondLocked ? 0 : firstLocked ? 1 : 0.5;

  first.x += dx * offset * firstShare;
  first.y += dy * offset * firstShare;
  first.z += dz * offset * firstShare;
  second.x -= dx * offset * secondShare;
  second.y -= dy * offset * secondShare;
  second.z -= dz * offset * secondShare;
}

function writeClothToGeometry(geometry: THREE.PlaneGeometry, particles: ClothParticle[]) {
  const positions = geometry.attributes.position.array as Float32Array;
  for (let index = 0; index < particles.length; index += 1) {
    const point = particles[index];
    const offset = index * 3;
    positions[offset] = point.x;
    positions[offset + 1] = point.y;
    positions[offset + 2] = point.z;
  }
  geometry.attributes.position.needsUpdate = true;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function drawScene(canvas: HTMLCanvasElement, scene: SignalScene) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const scale = canvas.width / scene.width;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);

  for (const node of scene.nodes) {
    drawNode(ctx, node);
  }
}

function drawNode(ctx: CanvasRenderingContext2D, node: SceneNode) {
  if (node.type === "box") {
    if (node.shadow) {
      ctx.save();
      ctx.shadowColor = node.shadow;
      ctx.shadowBlur = 44;
      ctx.shadowOffsetY = 28;
      roundRect(ctx, node.x, node.y, node.width, node.height, node.radius);
      ctx.fillStyle = node.fill;
      ctx.fill();
      ctx.restore();
    }
    roundRect(ctx, node.x, node.y, node.width, node.height, node.radius);
    ctx.fillStyle = node.fill;
    ctx.fill();
    if (node.stroke) {
      ctx.strokeStyle = node.stroke;
      ctx.stroke();
    }
    return;
  }

  if (node.type === "text") {
    ctx.fillStyle = node.color;
    ctx.font = `${node.fontWeight} ${node.fontSize}px Inter, system-ui, sans-serif`;
    wrapText(ctx, node.text, node.x, node.y, node.maxWidth, node.lineHeight, node.maxLines);
    return;
  }

  if (node.type === "rule") {
    ctx.strokeStyle = node.color;
    ctx.beginPath();
    ctx.moveTo(node.x1, node.y1);
    ctx.lineTo(node.x2, node.y2);
    ctx.stroke();
    return;
  }

  if (node.type === "metric") {
    ctx.fillStyle = "#6f7280";
    ctx.font = "400 24px Inter, system-ui, sans-serif";
    ctx.fillText(node.label, node.x, node.y - 82);
    ctx.fillStyle = "#111114";
    ctx.font = "650 120px Inter, system-ui, sans-serif";
    ctx.fillText(node.value, node.x, node.y);
    ctx.fillStyle = node.accent;
    ctx.font = "600 26px Inter, system-ui, sans-serif";
    ctx.fillText(node.delta, node.x + 4, node.y + 48);
    return;
  }

  if (node.type === "chart") {
    ctx.strokeStyle = "#ececf0";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(88, 420);
    ctx.lineTo(832, 420);
    ctx.stroke();
    ctx.strokeStyle = node.accent;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    node.points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();
  }
}

function fallbackScene(surface: SignalSurface): SignalScene {
  return {
    width: 920,
    height: 520,
    accent: "#1677ff",
    nodes: [
      {
        type: "box",
        id: "frame",
        x: 40,
        y: 42,
        width: 840,
        height: 430,
        radius: 18,
        fill: "rgba(255,255,255,0.97)",
        stroke: "rgba(17,17,20,0.08)",
      },
      {
        type: "text",
        id: "title",
        text: surface.data.title,
        x: 86,
        y: 128,
        maxWidth: 700,
        lineHeight: 56,
        fontSize: 54,
        fontWeight: 650,
        color: "#111114",
      },
    ],
    hotspots: [],
  };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines?: number,
) {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const testLine = line ? `${line} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = testLine;
    }
  }
  lines.push(line);

  const limit = maxLines && maxLines > 0 ? maxLines : lines.length;
  const visible = lines.slice(0, limit);
  // If we had to drop lines, ellipsise the final visible line to fit maxWidth.
  if (lines.length > limit && visible.length) {
    let last = visible[visible.length - 1];
    while (last && ctx.measureText(`${last}…`).width > maxWidth) {
      last = last.slice(0, -1).trimEnd();
    }
    visible[visible.length - 1] = `${last}…`;
  }
  visible.forEach((entry, index) => ctx.fillText(entry, x, y + index * lineHeight));
}
