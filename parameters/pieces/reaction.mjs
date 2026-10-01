// Reaction, live. A GPU port of dnuke-art/cv-draw reaction.py for vr-gallery: the same
// Gray-Scott system, the same sheared (F, k) sweep across the sheet, the same relief lighting
// and palette — but running on the wall, from a fresh seed each iteration.
//
// Differences from the print, on purpose: the grid is `scale` × the print's 1200×780 (the
// dynamics are per-cell, so a smaller grid shows the same regimes with fewer features in each
// band); the seed feeds sfc32 rather than numpy's PCG64, so hash 42 here is not the print's 42;
// the height field isn't pre-blurred and there's no bloom pass. `vmax` stands in for V.max().
export const meta = { name: "reaction", version: "1", steps: 6500, stepsPerFrame: 20, hold: 10 };

export const params = {
  scale: 0.5,
  F_RANGE: [0.018, 0.062], // feed rate, left → right
  K_AT_LOW_F: 0.0545,
  K_SHEAR: 0.13, // dk/dF along the Turing band
  K_LO: -0.003, K_HI: 0.005, // band offsets, top → bottom
  DU: 0.16, DV: 0.08,
  inoculations: 420, // at full size; scaled with the grid's area
  vmax: 0.49, // the print normalizes by V.max(); measured from reaction.py itself: 0.49-0.50 from mid-run on
};

const VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const SIM = `
precision highp float;
varying vec2 vUv;
uniform sampler2D state;
uniform vec2 texel;
uniform vec2 F_RANGE;
uniform float K_AT_LOW_F, K_SHEAR, K_LO, K_HI, DU, DV;
vec2 at(vec2 o) { return texture2D(state, vUv + o * texel).xy; }
void main() {
  vec2 c = at(vec2(0.0));
  // the print's 3x3 Laplacian: 0.05 corners, 0.20 edges, -1 centre (edges clamp = BORDER_REPLICATE)
  vec2 lap = 0.2 * (at(vec2(1, 0)) + at(vec2(-1, 0)) + at(vec2(0, 1)) + at(vec2(0, -1)))
           + 0.05 * (at(vec2(1, 1)) + at(vec2(-1, 1)) + at(vec2(1, -1)) + at(vec2(-1, -1))) - c;
  float F = mix(F_RANGE.x, F_RANGE.y, vUv.x);
  float K = K_AT_LOW_F + K_SHEAR * (F - F_RANGE.x) + mix(K_LO, K_HI, 1.0 - vUv.y);
  float U = c.x, V = c.y, uvv = U * V * V;
  U += DU * lap.x - uvv + F * (1.0 - U);
  V += DV * lap.y + uvv - (F + K) * V;
  gl_FragColor = vec4(clamp(U, 0.0, 1.0), clamp(V, 0.0, 1.0), 0.0, 1.0);
}`;

const SHADE = `
precision highp float;
varying vec2 vUv;
uniform sampler2D state;
uniform vec2 texel;
uniform float vmax;
float h(float x, float y) { return texture2D(state, vUv + vec2(x, y) * texel).y; }
vec3 aces(vec3 x) { x = max(x, 0.0); return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  // Sobel in image coordinates (y down, as the print computes it)
  float gx = (h(1., 1.) + 2. * h(1., 0.) + h(1., -1.)) - (h(-1., 1.) + 2. * h(-1., 0.) + h(-1., -1.));
  float gy = (h(-1., -1.) + 2. * h(0., -1.) + h(1., -1.)) - (h(-1., 1.) + 2. * h(0., 1.) + h(1., 1.));
  vec3 n = normalize(vec3(-gx * 26.0, -gy * 26.0, 1.0));
  vec3 L = normalize(vec3(-0.55, -0.62, 0.56));
  float lam = clamp(dot(n, L), 0.0, 1.0);
  float spec = pow(clamp(dot(n, normalize(L + vec3(0, 0, 1))), 0.0, 1.0), 42.0);
  float t = clamp(h(0., 0.) / vmax, 0.0, 1.0);
  vec3 DEEP = vec3(0.020, 0.035, 0.075), MID = vec3(0.62, 0.16, 0.24), HIGH = vec3(0.99, 0.86, 0.52);
  vec3 base = t < 0.5 ? mix(DEEP, MID, t / 0.5) : mix(MID, HIGH, (t - 0.5) / 0.5);
  vec3 img = base * (0.24 + 1.15 * lam) + spec * 0.65;
  float r = length((vUv - 0.5) * 2.0) / sqrt(2.0);
  img *= 1.0 - 0.45 * pow(r, 2.2);
  gl_FragColor = vec4(aces(img), 1.0); // linear; the viewer's output stage does the sRGB step
}`;

export function create({ THREE, renderer, rand, params: p }) {
  const W = Math.round(1200 * p.scale), H = Math.round(780 * p.scale);
  const floatOK = renderer.capabilities.isWebGL2 && renderer.extensions.has("EXT_color_buffer_float");
  const rt = (opts) => new THREE.WebGLRenderTarget(W, H, { depthBuffer: false, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, ...opts });
  const simOpts = { type: floatOK ? THREE.FloatType : THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
  let read = rt(simOpts), write = rt(simOpts);
  const out = rt({ type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });

  // Initial state, all from rand(): U = 1, V = 0, then square inoculations and a little noise.
  const data = new Float32Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { data[i * 4] = 1; data[i * 4 + 3] = 1; }
  const count = Math.round(p.inoculations * p.scale * p.scale);
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo)); // [lo, hi), like rng.integers
  for (let k = 0; k < count; k++) {
    const cy = int(6, H - 6), cx = int(6, W - 6), r = int(2, 6);
    for (let y = cy - r; y < cy + r; y++) for (let x = cx - r; x < cx + r; x++) { data[(y * W + x) * 4] = 0.5; data[(y * W + x) * 4 + 1] = 0.25; }
  }
  for (let i = 0; i < W * H; i++) data[i * 4 + 1] += rand() * 0.008;
  const seed = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  seed.needsUpdate = true;

  const texel = new THREE.Vector2(1 / W, 1 / H);
  const sim = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: SIM,
    uniforms: {
      state: { value: seed }, texel: { value: texel }, F_RANGE: { value: new THREE.Vector2(...p.F_RANGE) },
      K_AT_LOW_F: { value: p.K_AT_LOW_F }, K_SHEAR: { value: p.K_SHEAR }, K_LO: { value: p.K_LO }, K_HI: { value: p.K_HI },
      DU: { value: p.DU }, DV: { value: p.DV },
    },
  });
  const shade = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: SHADE, uniforms: { state: { value: seed }, texel: { value: texel }, vmax: { value: p.vmax } } });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), sim);
  const scene = new THREE.Scene().add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  let state = seed;

  return {
    texture: out.texture,
    aspect: H / W,
    step() {
      quad.material = sim;
      sim.uniforms.state.value = state;
      renderer.setRenderTarget(write);
      renderer.render(scene, cam);
      [read, write] = [write, read];
      state = read.texture;
    },
    render() {
      quad.material = shade;
      shade.uniforms.state.value = state;
      renderer.setRenderTarget(out);
      renderer.render(scene, cam);
    },
    dispose() {
      for (const x of [read, write, out, seed, sim, shade, quad.geometry]) x.dispose();
    },
  };
}
