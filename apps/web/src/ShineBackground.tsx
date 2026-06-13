import { useEffect, useRef } from "react";
import type { BgPalette } from "./users";

/**
 * Shine ambient background — a slow, luminous mesh-gradient aurora driven by a
 * per-user palette. Rendered in WebGL on a downscaled buffer (the gradient is
 * soft, so half-resolution is invisible but ~4x cheaper), throttled to ~30fps,
 * paused off-screen, frozen for reduced-motion, and degrading to a CSS wash if
 * WebGL is unavailable.
 *
 * Design intent: it should never demand attention. Pale, barely moving, mostly
 * white — a held breath, not a screensaver. Switching users swaps the palette
 * uniforms live (no context rebuild, no flash).
 */
const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform vec3 uC4;
uniform float uSpeed;
uniform float uLift;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  vec2 p = uv;
  p.x *= aspect;

  float t = uTime * uSpeed;

  // Domain warp — gentle flow fields fold the gradient into itself.
  vec2 q = p;
  q.x += 0.18 * sin(p.y * 2.3 + t * 1.2);
  q.y += 0.16 * cos(p.x * 1.9 - t * 1.0);
  q.x += 0.10 * sin(q.y * 3.7 - t * 0.7);

  float n1 = 0.5 + 0.5 * sin(q.x * 1.8 + t * 1.1);
  float n2 = 0.5 + 0.5 * cos(q.y * 2.1 - t * 0.9);
  float n3 = 0.5 + 0.5 * sin((q.x + q.y) * 1.4 + t * 0.6);

  vec3 col = vec3(1.0);
  col = mix(col, uC1, smoothstep(0.15, 0.95, n1) * 0.42);
  col = mix(col, uC2, smoothstep(0.10, 0.90, n2) * 0.36);
  col = mix(col, uC3, smoothstep(0.30, 1.00, n3) * 0.30);
  col = mix(col, uC4, smoothstep(0.55, 1.00, n1 * n2) * 0.28);

  // Lift toward white so the surface never competes with content.
  col = mix(col, vec3(1.0), uLift);

  // Soft radial brightening at centre, faint cool fall-off at the corners.
  float d = length(uv - 0.5);
  col = mix(col, vec3(1.0), smoothstep(0.55, 0.0, d) * 0.18);
  col *= 1.0 - smoothstep(0.45, 1.05, d) * 0.06;

  // Dithered grain — kills the banding that makes soft gradients look cheap.
  col += (hash(gl_FragCoord.xy + t) - 0.5) * 0.012;

  gl_FragColor = vec4(col, 1.0);
}
`;

const VERT = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function ShineBackground({ palette }: { palette: BgPalette }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const applyRef = useRef<((p: BgPalette) => void) | null>(null);
  const paletteRef = useRef(palette);
  paletteRef.current = palette;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl", {
      antialias: false,
      depth: false,
      stencil: false,
      alpha: false,
      premultipliedAlpha: false,
      powerPreference: "low-power",
    });
    if (!gl) {
      canvas.classList.add("shine-bg--fallback");
      return;
    }

    const vert = compile(gl, gl.VERTEX_SHADER, VERT);
    const frag = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const program = gl.createProgram();
    if (!vert || !frag || !program) {
      canvas.classList.add("shine-bg--fallback");
      return;
    }
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const ctx = gl;
    const cnv = canvas;
    const uRes = ctx.getUniformLocation(program, "uRes");
    const uTime = ctx.getUniformLocation(program, "uTime");
    const uC = [1, 2, 3, 4].map((i) => ctx.getUniformLocation(program, `uC${i}`));
    const uSpeed = ctx.getUniformLocation(program, "uSpeed");
    const uLift = ctx.getUniformLocation(program, "uLift");

    // Live palette swap (used on mount and whenever the user changes).
    applyRef.current = (p: BgPalette) => {
      for (let i = 0; i < 4; i++) ctx.uniform3f(uC[i], p.colors[i][0], p.colors[i][1], p.colors[i][2]);
      ctx.uniform1f(uSpeed, p.speed);
      ctx.uniform1f(uLift, p.lift);
    };
    applyRef.current(paletteRef.current);

    const SCALE = 0.5;
    function resize() {
      const w = Math.max(2, Math.floor(window.innerWidth * SCALE));
      const h = Math.max(2, Math.floor(window.innerHeight * SCALE));
      if (cnv.width === w && cnv.height === h) return;
      cnv.width = w;
      cnv.height = h;
      ctx.viewport(0, 0, w, h);
      ctx.uniform2f(uRes, w, h);
    }
    resize();
    window.addEventListener("resize", resize);

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let running = true;
    const start = performance.now();
    const minDelta = 1000 / 30;
    let lastDraw = -minDelta;

    function frame(now: number) {
      if (!running) return;
      if (now - lastDraw >= minDelta) {
        lastDraw = now;
        ctx.uniform1f(uTime, reduceMotion ? 8 : (now - start) / 1000);
        ctx.drawArrays(ctx.TRIANGLES, 0, 3);
      }
      raf = reduceMotion ? 0 : requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    function onVisibility() {
      if (document.hidden) {
        running = false;
        if (raf) cancelAnimationFrame(raf);
      } else if (!reduceMotion) {
        running = true;
        raf = requestAnimationFrame(frame);
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      running = false;
      applyRef.current = null;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      ctx.deleteProgram(program);
      ctx.deleteShader(vert);
      ctx.deleteShader(frag);
      ctx.deleteBuffer(buffer);
      ctx.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  // Swap the palette live when the active user changes — no context rebuild.
  useEffect(() => {
    applyRef.current?.(palette);
  }, [palette]);

  return <canvas ref={canvasRef} className="shine-bg" aria-hidden="true" />;
}
