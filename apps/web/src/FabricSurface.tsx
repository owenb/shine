import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { SceneNode, SignalScene, SignalSurface } from "@sig/core";

export function FabricSurface({
  surface,
  scene: signalScene,
}: {
  surface: SignalSurface;
  scene: SignalScene | null;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    host.textContent = "";

    const width = 920;
    const height = 520;
    const textureCanvas = document.createElement("canvas");
    textureCanvas.width = width * 2;
    textureCanvas.height = height * 2;
    const sceneGraph = signalScene ?? fallbackScene(surface);
    drawScene(textureCanvas, sceneGraph);

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
    const geometry = new THREE.PlaneGeometry(5.6, 3.15, 48, 28);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    const base = geometry.attributes.position.array.slice() as Float32Array;
    let pointerX = 0;
    let pointerY = 0;
    let frame = 0;
    const onPointerMove = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointerX = (event.clientX - rect.left) / rect.width - 0.5;
      pointerY = (event.clientY - rect.top) / rect.height - 0.5;
    };
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    const onPointerDown = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * sceneGraph.width;
      const y = ((event.clientY - rect.top) / Math.max(rect.height, 1)) * sceneGraph.height;
      const hit = sceneGraph.hotspots.find(
        (hotspot) =>
          x >= hotspot.x &&
          x <= hotspot.x + hotspot.width &&
          y >= hotspot.y &&
          y <= hotspot.y + hotspot.height,
      );
      if (hit?.action.type === "openUrl") {
        window.open(hit.action.url, "_blank", "noopener,noreferrer");
      }
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);

    const animate = () => {
      frame = requestAnimationFrame(animate);
      const t = performance.now() * 0.001;
      const positions = geometry.attributes.position.array as Float32Array;
      for (let index = 0; index < positions.length; index += 3) {
        const x = base[index];
        const y = base[index + 1];
        positions[index] = x + pointerX * 0.08 * Math.cos(y + t);
        positions[index + 1] = y - pointerY * 0.08 * Math.sin(x + t);
        positions[index + 2] =
          Math.sin(x * 2.8 + t) * 0.045 + Math.cos(y * 3.6 + t * 0.8) * 0.035;
      }
      geometry.attributes.position.needsUpdate = true;
      mesh.rotation.x = -0.08 + pointerY * 0.08;
      mesh.rotation.y = pointerX * 0.14;
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      geometry.dispose();
      material.dispose();
      texture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [surface, signalScene]);

  return (
    <div className="surface-stage fabric-stage" ref={ref} aria-label="Fabric renderer">
      <div className="empty-widget" />
    </div>
  );
}

function drawScene(canvas: HTMLCanvasElement, scene: SignalScene) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const scale = canvas.width / scene.width;
  ctx.scale(scale, scale);
  ctx.clearRect(0, 0, scene.width, scene.height);

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
    wrapText(ctx, node.text, node.x, node.y, node.maxWidth, node.lineHeight);
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
) {
  const words = text.split(" ");
  let line = "";
  for (const word of words) {
    const testLine = line ? `${line} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && line) {
      ctx.fillText(line, x, y);
      line = word;
      y += lineHeight;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line, x, y);
}
