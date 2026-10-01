// Builds the room and hangs the works from a normalized gallery (src/gallery.mjs).
// Lighting is cheap on purpose — a hemisphere light plus an additive "light pool" painted on the
// wall behind each work — so the room holds frame rate on a standalone headset. The art itself
// is unlit (MeshBasicMaterial, no tone mapping): what you see is the file's own colour.
import * as THREE from "three";
import { labelCanvas } from "./story.mjs";

const LABEL_Y = 1.3; // wall labels sit at a reading height, whatever the work's hang
const FRAME = { border: 0.025, depth: 0.035, color: 0x151515 };

function pool() {
  // one soft radial gradient, shared by every work: the fake picture light
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, "rgba(255,244,225,0.55)");
  grad.addColorStop(0.55, "rgba(255,240,215,0.18)");
  grad.addColorStop(1, "rgba(255,240,215,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildRoom(gallery, renderer) {
  const { size: [w, d, h], wall, floor, ceiling } = gallery.room;
  const root = new THREE.Group();

  root.add(new THREE.HemisphereLight(0xfffaf2, 0xc9c1b6, 2.4));

  const plane = (pw, ph, color) => new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), new THREE.MeshLambertMaterial({ color }));
  const floorMesh = plane(w, d, floor);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.name = "floor";
  root.add(floorMesh);
  const ceil = plane(w, d, ceiling);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = h;
  root.add(ceil);
  const walls = [
    { len: w, pos: [0, h / 2, -d / 2], rotY: 0 },
    { len: d, pos: [w / 2, h / 2, 0], rotY: -Math.PI / 2 },
    { len: w, pos: [0, h / 2, d / 2], rotY: Math.PI },
    { len: d, pos: [-w / 2, h / 2, 0], rotY: Math.PI / 2 },
  ];
  const base = new THREE.MeshLambertMaterial({ color: 0x2a2826 });
  for (const s of walls) {
    const m = plane(s.len, h, wall);
    m.position.set(...s.pos);
    m.rotation.y = s.rotY;
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(s.len, 0.09, 0.015), base);
    skirt.position.set(0, 0.045 - h / 2, 0.0075);
    m.add(skirt);
    root.add(m);
  }

  const poolTex = pool();
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const loader = new THREE.TextureLoader();
  const hits = []; // everything a ray can land on that means "this work"
  const works = gallery.exhibits.map((ex) => {
    const g = new THREE.Group();
    g.position.set(...ex.position);
    g.rotation.y = ex.rotY;
    root.add(g);

    const art = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x8a8580, toneMapped: false }));
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1, 1, FRAME.depth), new THREE.MeshLambertMaterial({ color: FRAME.color }));
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    frame.position.z = FRAME.depth / 2;
    art.position.z = FRAME.depth + 0.001;
    glow.position.z = 0.002;
    g.add(glow, frame, art);

    const label = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.14), new THREE.MeshBasicMaterial({ map: labelCanvas(ex), toneMapped: false }));
    label.position.z = 0.003;
    g.add(label);

    const work = { ex, group: g, art, height: ex.width };
    const fit = (aspect) => {
      const aw = ex.width, ah = ex.width * aspect;
      work.height = ah;
      art.scale.set(aw, ah, 1);
      frame.scale.set(aw + 2 * FRAME.border, ah + 2 * FRAME.border, 1);
      glow.scale.set(aw * 2.2 + 0.6, ah * 1.6 + 0.9, 1);
      glow.position.y = ah * 0.12; // light falls from above
      label.position.set(aw / 2 + FRAME.border + 0.25, LABEL_Y - ex.y + 0.06, 0.003);
    };
    // Put a texture on the wall at its own proportions (images on load; live pieces when they start).
    work.show = (tex, aspect) => {
      art.material.map = tex;
      art.material.color.set(0xffffff);
      art.material.needsUpdate = true;
      fit(aspect);
    };
    fit(1);
    if (ex.media.type === "image") {
      loader.load(ex.media.src, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = aniso;
        work.show(tex, tex.image.height / tex.image.width);
      }, undefined, () => console.warn(`[vr-gallery] ${ex.id}: couldn't load ${ex.media.src}`));
    }

    for (const m of [art, frame, label]) { m.userData.work = work; hits.push(m); }
    return work;
  });

  return { root, floor: floorMesh, works, hits };
}
