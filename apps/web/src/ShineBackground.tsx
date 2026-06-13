import { useEffect, useRef } from "react";

/**
 * Shine ambient background — a slow, luminous mesh-gradient aurora that drifts
 * behind frosted glass. Rendered in WebGL on a downscaled buffer (the gradient
 * is soft, so half-resolution is invisible but ~4x cheaper). Degrades to a
 * static CSS wash if WebGL is unavailable, and freezes for reduced-motion.
 *
 * Design intent: this should never demand attention. It is light, barely
 * moving, mostly white — a held breath, not a screensaver.
 */
const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;

// A pale, luminous palette. White dominates; colour is a whisper.
const vec3 PERIWINKLE = vec3(0.74, 0.79, 1.00);
const vec3 VIOLET     = vec3(0.86, 0.78, 1.00);
const vec3 MINT       = vec3(0.78, 0.96, 0.90);
const vec3 BLUSH      = vec3(1.00, 0.89, 0.85);

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  vec2 p = uv;
  p.x *= aspect;

  float t = uTime * 0.035;

  // Domain warp — gentle flow fields fold the gradient into itself.
  vec2 q = p;
  q.x += 0.18 * sin(p.y * 2.3 + t * 1.2);
  q.y += 0.16 * cos(p.x * 1.9 - t * 1.0);
  q.x += 0.10 * sin(q.y * 3.7 - t * 0.7);

  float n1 = 0.5 + 0.5 * sin(q.x * 1.8 + t * 1.1);
  float n2 = 0.5 + 0.5 * cos(q.y * 2.1 - t * 0.9);
  float n3 = 0.5 + 0.5 * sin((q.x + q.y) * 1.4 + t * 0.6);

  vec3 col = vec3(1.0);
  col = mix(col, PERIWINKLE, smoothstep(0.15, 0.95, n1) * 0.42);
  col = mix(col, VIOLET,     smoothstep(0.10, 0.90, n2) * 0.36);
  col = mix(col, MINT,       smoothstep(0.30, 1.00, n3) * 0.30);
  col = mix(col, BLUSH,      smoothstep(0.55, 1.00, n1 * n2) * 0.28);

  // Lift toward white so the surface never competes with content.
  col = mix(col, vec3(1.0), 0.30);

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

export function ShineBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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
      // Fallback: a static CSS wash (defined in styles.css).
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
    // Fullscreen triangle.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(program, "uRes");
    const uTime = gl.getUniformLocation(program, "uTime");

    // Render at a downscaled resolution — the gradient is soft, so the cost
    // saving is free quality. Cap so huge displays stay cheap.
    // (Narrowed non-null aliases so the closures below keep the guarded types.)
    const ctx = gl;
    const cnv = canvas;
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
    // The aurora moves slowly enough that ~30fps is visually identical — and it
    // halves how often the frosted-glass layers above must re-rasterise.
    const minDelta = 1000 / 30;
    let lastDraw = -minDelta;

    function frame(now: number) {
      if (!running) return;
      if (now - lastDraw >= minDelta) {
        lastDraw = now;
        ctx.uniform1f(uTime, reduceMotion ? 8 : (now - start) / 1000);
        ctx.drawArrays(ctx.TRIANGLES, 0, 3);
      }
      // A single static frame is enough when motion is reduced.
      raf = reduceMotion ? 0 : requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    // Pause when the tab is hidden — never burn cycles off-screen.
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
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      gl.deleteProgram(program);
      gl.deleteShader(vert);
      gl.deleteShader(frag);
      gl.deleteBuffer(buffer);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  return <canvas ref={canvasRef} className="shine-bg" aria-hidden="true" />;
}
