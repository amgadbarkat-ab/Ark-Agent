/**
 * The company's hero animation, as a mark Ark can show: a few thousand points that gather into a
 * server rack, then a globe, then the BlackArk mark, and again.
 *
 * It is the animation on www.blackark.uk (its `hero3d.js`, which draws with three.js), ported to plain
 * WebGL so the apps carry no 600 KB library for one picture. The shapes, the random seed, the shaders,
 * the timings and the camera are the website's, so it reads as the same thing. What is different:
 * there is no three.js, the camera is centred (the website leaves room for a headline on the left),
 * the halo behind the points is drawn as a quad, and it asks for nothing from the page.
 *
 * It is decoration, so it fails quietly: with no WebGL the container keeps the static tile it was
 * given, and for a person who asks their system for less motion it draws one still frame of the mark.
 * It stops drawing while the page is hidden or the picture is off screen.
 *
 * Plain DOM and no framework, because the web app and the desktop app are two projects and each
 * wraps this in a few lines of its own.
 */

/** 0 a server rack, 1 a globe, 2 the BlackArk mark. */
export type ParticleShape = 0 | 1 | 2;

export type ParticleMarkOptions = {
  /** Points drawn. The website uses 9000, and 5500 on a phone. */
  count?: number;
  /** The shape to open on. The website opens on the mark. */
  start?: ParticleShape;
  /** Keep morphing through the shapes (the website does), or hold the first one. */
  cycle?: boolean;
  /**
   * How close the camera is. The website's 0.82 leaves the whole picture floating in a tall stage; a
   * short, wide one wants more.
   */
  zoom?: number;
  /** Tilt slightly towards the pointer while it is over this element. */
  pointerTarget?: HTMLElement | null;
  /** Called when the picture starts moving towards a shape. */
  onShape?: (shape: ParticleShape) => void;
  /** Draw one still frame instead of animating. Defaults to what the system asks for. */
  reducedMotion?: boolean;
};

export type ParticleMark = {
  /** Stop drawing and give everything back. Safe to call twice. */
  destroy: () => void;
};

/** How long the picture rests on a shape, and how long it takes to become the next, in seconds. */
export const HOLD_SECONDS = 2.8;
export const MORPH_SECONDS = 1.9;

/** How the points sit when nothing is moving them: the website's resting tilt and turn, in radians. */
const STILL_TILT = -0.08;
const STILL_TURN = 0.5;

/** The camera the website uses. */
const FOV_DEGREES = 40;
const ZOOM = 0.82;
const CAMERA_Z = 13.5;
const NEAR = 0.1;
const FAR = 300;

/** The website's generator: a small linear congruential sequence, so every visit draws the same points. */
function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/** A point on the surface of a box, written to `out` at `at`. */
function surfaceOfBox(
  next: () => number,
  [cx, cy, cz]: [number, number, number],
  [sx, sy, sz]: [number, number, number],
  out: Float32Array,
  at: number,
) {
  const a = sx * sy;
  const b = sy * sz;
  const c = sx * sz;
  const total = a + b + c;
  const q = next() * total;
  const s = next() < 0.5 ? -1 : 1;
  let x: number;
  let y: number;
  let z: number;
  if (next() < 0.5) {
    const axis = Math.floor(next() * 3);
    const edge = () => (next() < 0.5 ? -0.5 : 0.5);
    x = axis === 0 ? (next() - 0.5) * sx : edge() * sx;
    y = axis === 1 ? (next() - 0.5) * sy : edge() * sy;
    z = axis === 2 ? (next() - 0.5) * sz : edge() * sz;
  } else if (q < a) {
    x = (next() - 0.5) * sx;
    y = (next() - 0.5) * sy;
    z = (s * sz) / 2;
  } else if (q < a + b) {
    x = (s * sx) / 2;
    y = (next() - 0.5) * sy;
    z = (next() - 0.5) * sz;
  } else {
    x = (next() - 0.5) * sx;
    y = (s * sy) / 2;
    z = (next() - 0.5) * sz;
  }
  out[at] = cx + x;
  out[at + 1] = cy + y;
  out[at + 2] = cz + z;
}

/** The three shapes, and each point's own random numbers, for `count` points. Deterministic. */
export function buildShapes(count: number): {
  shapes: [Float32Array, Float32Array, Float32Array];
  random: Float32Array;
} {
  const next = sequence(555);
  const shapes: [Float32Array, Float32Array, Float32Array] = [
    new Float32Array(count * 3),
    new Float32Array(count * 3),
    new Float32Array(count * 3),
  ];
  // A rack: six slabs, one above the other.
  for (let i = 0; i < count; i++) {
    const unit = Math.floor(next() * 6);
    surfaceOfBox(
      next,
      [0, -2.4 + unit * 0.96, 0],
      [4.8, 0.6, 3],
      shapes[0],
      i * 3,
    );
  }
  // A globe: points spread evenly over a sphere, with a little roughness.
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const ring = Math.sqrt(1 - y * y);
    const theta = i * Math.PI * (3 - Math.sqrt(5));
    const radius = 3.2 * (1 + (next() - 0.5) * 0.03);
    shapes[1][i * 3] = Math.cos(theta) * ring * radius;
    shapes[1][i * 3 + 1] = y * radius;
    shapes[1][i * 3 + 2] = Math.sin(theta) * ring * radius;
  }
  // The mark: a square frame (30% of the points) and three ascending bars.
  const bars: Array<[number, number]> = [
    [-1.05, 1.6],
    [0, 2.55],
    [1.05, 3.7],
  ];
  for (let i = 0; i < count; i++) {
    const at = i * 3;
    if (i < count * 0.3) {
      const p = next() * 4;
      const side = Math.floor(p);
      const along = (p - side) * 2 - 1;
      const reach = 3.4;
      let x: number;
      let y: number;
      if (side === 0) {
        x = along * reach;
        y = -reach;
      } else if (side === 1) {
        x = reach;
        y = along * reach;
      } else if (side === 2) {
        x = along * reach;
        y = reach;
      } else {
        x = -reach;
        y = along * reach;
      }
      shapes[2][at] = x * (1 + (next() - 0.5) * 0.012);
      shapes[2][at + 1] = y;
      shapes[2][at + 2] = (next() - 0.5) * 0.5;
    } else {
      const [x, height] = bars[Math.floor(next() * 3)];
      surfaceOfBox(
        next,
        [x * 1.05, -2.1 + height / 2, 0],
        [0.86, height, 0.9],
        shapes[2],
        at,
      );
    }
  }
  const random = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) random[i] = next();
  return { shapes, random };
}

// ---------- the small amount of matrix arithmetic WebGL does not do for us ----------

type Matrix = Float32Array;

export function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

export function perspective(aspect: number, zoom = ZOOM): Matrix {
  const f = zoom / Math.tan((FOV_DEGREES * Math.PI) / 360);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (FAR + NEAR) / (NEAR - FAR);
  out[11] = -1;
  out[14] = (2 * FAR * NEAR) / (NEAR - FAR);
  return out;
}

function rotationX(angle: number): Matrix {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return Float32Array.from([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}

function rotationY(angle: number): Matrix {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return Float32Array.from([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}

function translation(x: number, y: number, z: number): Matrix {
  return Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

/** The camera looks down the z axis from `CAMERA_Z`, and the points turn about their own centre. */
export function modelView(rotateX: number, rotateY: number): Matrix {
  return multiply(
    translation(0, 0, -CAMERA_Z),
    multiply(rotationX(rotateX), rotationY(rotateY)),
  );
}

// ---------- the shaders, as the website has them ----------

const POINT_VERTEX = `
attribute vec3 position; attribute vec3 aTo; attribute vec3 aRand;
uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix;
uniform float uMix, uTime, uSize, uPR;
varying float vH; varying float vA;
void main(){
  float m = smoothstep(0., 1., clamp((uMix - aRand.x * .38) / .62, 0., 1.));
  vec3 p = mix(position, aTo, m);
  float s = sin(3.14159 * m);
  p += (aRand - .5) * s * 2.4;
  float ang = s * 1.7 * (aRand.y - .2);
  float c = cos(ang), sn = sin(ang);
  p.xz = mat2(c, -sn, sn, c) * p.xz;
  p.y += sin(uTime * 1.3 + aRand.z * 6.28) * .045;
  vec4 mv = modelViewMatrix * vec4(p, 1.);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * uPR * (.7 + aRand.z * 1.1) * (9. / -mv.z);
  vH = p.y; vA = .5 + .5 * aRand.z;
}`;

const POINT_FRAGMENT = `
precision mediump float;
varying float vH; varying float vA;
void main(){
  float d = length(gl_PointCoord - .5);
  float a = smoothstep(.5, .0, d);
  vec3 col = mix(vec3(1., .33, .06), vec3(1., .8, .55), smoothstep(-3.2, 3.6, vH));
  gl_FragColor = vec4(col, a * vA);
}`;

/** A soft glow behind the points: white at the middle, fading out, tinted ember. */
const HALO_VERTEX = `
attribute vec2 corner;
uniform mat4 projectionMatrix; uniform float uScale; uniform float uDepth;
varying vec2 vUv;
void main(){
  vUv = corner * .5 + .5;
  gl_Position = projectionMatrix * vec4(corner * uScale * .5, uDepth, 1.);
}`;

const HALO_FRAGMENT = `
precision mediump float;
varying vec2 vUv; uniform float uOpacity;
void main(){
  float d = clamp(length(vUv - .5) * 2., 0., 1.);
  float a = d < .22 ? mix(1., .6, d / .22) : mix(.6, 0., (d - .22) / .78);
  gl_FragColor = vec4(vec3(1., .353, .063), a * uOpacity);
}`;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("no shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader: ${log}`);
  }
  return shader;
}

function link(gl: WebGLRenderingContext, vertex: string, fragment: string) {
  const program = gl.createProgram();
  if (!program) throw new Error("no program");
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

/**
 * Draw into `canvas`. Returns null where WebGL is not available (or fails to start), so the caller
 * keeps whatever still picture it has.
 */
export function createParticleMark(
  canvas: HTMLCanvasElement,
  options: ParticleMarkOptions = {},
): ParticleMark | null {
  const mobile =
    typeof matchMedia === "function" &&
    matchMedia("(max-width: 900px)").matches;
  const count = options.count ?? (mobile ? 5500 : 9000);
  const reduced =
    options.reducedMotion ??
    (typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches);
  const cycle = options.cycle ?? true;
  const start: ParticleShape = options.start ?? 2;

  let gl: WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      powerPreference: "high-performance",
    }) as WebGLRenderingContext | null;
  } catch {
    gl = null;
  }
  if (!gl) return null;
  const context = gl;

  let pointProgram: WebGLProgram;
  let haloProgram: WebGLProgram;
  try {
    pointProgram = link(context, POINT_VERTEX, POINT_FRAGMENT);
    haloProgram = link(context, HALO_VERTEX, HALO_FRAGMENT);
  } catch (error) {
    console.error(error);
    return null;
  }

  const dpr = Math.min(
    (typeof devicePixelRatio === "number" && devicePixelRatio) || 1,
    1.5,
  );
  const { shapes, random } = buildShapes(count);
  let current: ParticleShape = start;

  const positions = context.createBuffer();
  const targets = context.createBuffer();
  const randoms = context.createBuffer();
  const corners = context.createBuffer();
  context.bindBuffer(context.ARRAY_BUFFER, positions);
  context.bufferData(
    context.ARRAY_BUFFER,
    shapes[current],
    context.DYNAMIC_DRAW,
  );
  context.bindBuffer(context.ARRAY_BUFFER, targets);
  context.bufferData(
    context.ARRAY_BUFFER,
    shapes[((current + 1) % 3) as ParticleShape],
    context.DYNAMIC_DRAW,
  );
  context.bindBuffer(context.ARRAY_BUFFER, randoms);
  context.bufferData(context.ARRAY_BUFFER, random, context.STATIC_DRAW);
  context.bindBuffer(context.ARRAY_BUFFER, corners);
  context.bufferData(
    context.ARRAY_BUFFER,
    Float32Array.from([-1, -1, 1, -1, -1, 1, 1, 1]),
    context.STATIC_DRAW,
  );

  const point = {
    position: context.getAttribLocation(pointProgram, "position"),
    to: context.getAttribLocation(pointProgram, "aTo"),
    random: context.getAttribLocation(pointProgram, "aRand"),
    modelView: context.getUniformLocation(pointProgram, "modelViewMatrix"),
    projection: context.getUniformLocation(pointProgram, "projectionMatrix"),
    mix: context.getUniformLocation(pointProgram, "uMix"),
    time: context.getUniformLocation(pointProgram, "uTime"),
    size: context.getUniformLocation(pointProgram, "uSize"),
    pixelRatio: context.getUniformLocation(pointProgram, "uPR"),
  };
  const halo = {
    corner: context.getAttribLocation(haloProgram, "corner"),
    projection: context.getUniformLocation(haloProgram, "projectionMatrix"),
    scale: context.getUniformLocation(haloProgram, "uScale"),
    depth: context.getUniformLocation(haloProgram, "uDepth"),
    opacity: context.getUniformLocation(haloProgram, "uOpacity"),
  };

  let width = 1;
  let height = 1;
  let projection = perspective(1);
  const resize = () => {
    const box = canvas.getBoundingClientRect();
    width = Math.max(2, Math.round(box.width));
    height = Math.max(2, Math.round(box.height));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    projection = perspective(width / height, options.zoom);
    context.viewport(0, 0, canvas.width, canvas.height);
    if (reduced) draw(0, 0, STILL_TILT, STILL_TURN);
  };

  let time = 0;
  let mix = 0;
  let pointerX = 0;
  let pointerY = 0;
  let easedX = 0;
  let easedY = 0;

  /** One frame: `rotateX` and `rotateY` are how far the points are turned about their own centre. */
  function draw(t: number, morph: number, rotateX: number, rotateY: number) {
    context.clearColor(0, 0, 0, 0);
    context.clear(context.COLOR_BUFFER_BIT);
    context.enable(context.BLEND);
    context.blendFunc(context.SRC_ALPHA, context.ONE);
    context.disable(context.DEPTH_TEST);

    // Halo first: it is the farthest thing.
    context.useProgram(haloProgram);
    context.bindBuffer(context.ARRAY_BUFFER, corners);
    context.enableVertexAttribArray(halo.corner);
    context.vertexAttribPointer(halo.corner, 2, context.FLOAT, false, 0, 0);
    context.uniformMatrix4fv(halo.projection, false, projection);
    context.uniform1f(halo.scale, 12);
    context.uniform1f(halo.depth, -(CAMERA_Z + 3));
    context.uniform1f(halo.opacity, 0.22 + 0.08 * Math.sin(t * 1.2));
    context.drawArrays(context.TRIANGLE_STRIP, 0, 4);
    context.disableVertexAttribArray(halo.corner);

    context.useProgram(pointProgram);
    const attribute = (location: number, buffer: WebGLBuffer | null) => {
      context.bindBuffer(context.ARRAY_BUFFER, buffer);
      context.enableVertexAttribArray(location);
      context.vertexAttribPointer(location, 3, context.FLOAT, false, 0, 0);
    };
    attribute(point.position, positions);
    attribute(point.to, targets);
    attribute(point.random, randoms);
    context.uniformMatrix4fv(
      point.modelView,
      false,
      modelView(rotateX, rotateY),
    );
    context.uniformMatrix4fv(point.projection, false, projection);
    context.uniform1f(point.mix, morph);
    context.uniform1f(point.time, t);
    context.uniform1f(point.size, mobile ? 3.4 : 3.1);
    context.uniform1f(point.pixelRatio, dpr);
    context.drawArrays(context.POINTS, 0, count);
    context.disableVertexAttribArray(point.position);
    context.disableVertexAttribArray(point.to);
    context.disableVertexAttribArray(point.random);
  }

  const upload = (buffer: WebGLBuffer | null, data: Float32Array) => {
    context.bindBuffer(context.ARRAY_BUFFER, buffer);
    context.bufferData(context.ARRAY_BUFFER, data, context.DYNAMIC_DRAW);
  };

  let observer: ResizeObserver | null = null;
  let frame = 0;
  let visible = true;
  let alive = true;
  let phase: "hold" | "morph" = "hold";
  let phaseTime = 0;
  let last = performance.now();
  let intersection: IntersectionObserver | null = null;

  const onPointer = (event: PointerEvent) => {
    const target = options.pointerTarget;
    if (!target) return;
    const box = target.getBoundingClientRect();
    pointerX = ((event.clientX - box.left) / box.width) * 2 - 1;
    pointerY = ((event.clientY - box.top) / box.height) * 2 - 1;
  };
  const onLeave = () => {
    pointerX = 0;
    pointerY = 0;
  };

  function step(now: number) {
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
    last = now;
    if (document.hidden || !visible) return;
    time += dt;
    phaseTime += dt;
    easedX += (pointerX - easedX) * 0.05;
    easedY += (pointerY - easedY) * 0.05;
    if (phase === "hold") {
      if (cycle && phaseTime > HOLD_SECONDS) {
        phase = "morph";
        phaseTime = 0;
        const next = ((current + 1) % 3) as ParticleShape;
        upload(targets, shapes[next]);
        options.onShape?.(next);
      }
    } else {
      mix = Math.min(1, phaseTime / MORPH_SECONDS);
      if (mix >= 1) {
        current = ((current + 1) % 3) as ParticleShape;
        upload(positions, shapes[current]);
        mix = 0;
        phase = "hold";
        phaseTime = 0;
      }
    }
    draw(
      time,
      mix,
      STILL_TILT + easedY * 0.18,
      STILL_TURN + Math.sin(time * 0.35) * 0.5 + easedX * 0.4,
    );
  }

  const loop = (now: number) => {
    if (!alive) return;
    frame = requestAnimationFrame(loop);
    step(now);
  };

  const onLost = (event: Event) => {
    event.preventDefault();
    destroy();
  };
  canvas.addEventListener("webglcontextlost", onLost);

  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(resize);
    observer.observe(canvas);
  } else {
    window.addEventListener("resize", resize);
  }
  resize();

  if (reduced) {
    // One still frame of the mark, turned a little so it reads as a solid.
    draw(0, 0, STILL_TILT, STILL_TURN);
  } else {
    if (typeof IntersectionObserver !== "undefined") {
      intersection = new IntersectionObserver(
        (entries) => {
          visible = entries[0]?.isIntersecting ?? true;
        },
        { threshold: 0 },
      );
      intersection.observe(canvas);
    }
    options.pointerTarget?.addEventListener("pointermove", onPointer, {
      passive: true,
    });
    options.pointerTarget?.addEventListener("pointerleave", onLeave);
    frame = requestAnimationFrame(loop);
  }

  function destroy() {
    if (!alive) return;
    alive = false;
    cancelAnimationFrame(frame);
    observer?.disconnect();
    window.removeEventListener("resize", resize);
    intersection?.disconnect();
    options.pointerTarget?.removeEventListener("pointermove", onPointer);
    options.pointerTarget?.removeEventListener("pointerleave", onLeave);
    canvas.removeEventListener("webglcontextlost", onLost);
    for (const buffer of [positions, targets, randoms, corners]) {
      context.deleteBuffer(buffer);
    }
    context.deleteProgram(pointProgram);
    context.deleteProgram(haloProgram);
    context.getExtension("WEBGL_lose_context")?.loseContext();
  }

  return { destroy };
}

/**
 * Put the animation inside `container`, which already holds the still picture to fall back on. On
 * success the container is marked `data-particles="on"` so a stylesheet can hide the still; on failure
 * it is marked `off` and left exactly as it was. Returns the function that takes it away again.
 */
export function mountParticleMark(
  container: HTMLElement,
  options: ParticleMarkOptions = {},
): () => void {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  container.appendChild(canvas);
  const mark = createParticleMark(canvas, {
    pointerTarget: container,
    ...options,
  });
  if (!mark) {
    canvas.remove();
    container.dataset.particles = "off";
    return () => {};
  }
  container.dataset.particles = "on";
  return () => {
    mark.destroy();
    canvas.remove();
    container.dataset.particles = "off";
  };
}
