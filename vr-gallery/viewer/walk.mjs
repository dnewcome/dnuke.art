// Screen navigation: drag to look, WASD / arrows to walk, and a tap (a press that didn't drag)
// is handed back to the page to decide what it means — usually "go there" or "tell me about
// that". glideTo() eases the rig to a spot and a heading; any key or drag takes control back.
// The rig carries the camera; in a headset the XR pose drives the camera and none of this runs.

export const EYE = 1.6;

export function walk({ rig, camera, dom, bounds, onTap, onHover }) {
  const s = { yaw: 0, pitch: 0, keys: new Set(), glide: null, down: null };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const inside = () => {
    rig.position.x = clamp(rig.position.x, -bounds[0] / 2 + 0.35, bounds[0] / 2 - 0.35);
    rig.position.z = clamp(rig.position.z, -bounds[1] / 2 + 0.35, bounds[1] / 2 - 0.35);
  };

  dom.addEventListener("pointerdown", (e) => {
    s.down = { x: e.clientX, y: e.clientY, yaw: s.yaw, pitch: s.pitch, moved: false };
    dom.setPointerCapture(e.pointerId);
  });
  dom.addEventListener("pointermove", (e) => {
    if (!s.down) return onHover?.(e);
    const dx = e.clientX - s.down.x, dy = e.clientY - s.down.y;
    if (!s.down.moved && Math.hypot(dx, dy) < 5) return;
    s.down.moved = true;
    s.glide = null;
    const k = e.pointerType === "touch" ? 0.006 : 0.004;
    s.yaw = s.down.yaw + dx * k; // grab the world, like a panorama: drag right, the view swings left
    s.pitch = clamp(s.down.pitch + dy * k, -1.2, 1.2);
  });
  dom.addEventListener("pointerup", (e) => {
    if (s.down && !s.down.moved) onTap?.(e);
    s.down = null;
  });
  dom.addEventListener("pointercancel", () => (s.down = null));
  addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, textarea") || e.metaKey || e.ctrlKey) return;
    s.keys.add(e.code);
    if (/^(Key[WASD]|Arrow)/.test(e.code)) s.glide = null;
  });
  addEventListener("keyup", (e) => s.keys.delete(e.code));
  // A host page forwards keys so WASD works without clicking into the frame first:
  //   frame.contentWindow.postMessage({ vrGallery: "key", code: e.code, type: e.type }, "*")
  addEventListener("message", ({ data: m }) => {
    if (m?.vrGallery !== "key" || typeof m.code !== "string") return;
    if (m.type === "keydown") { s.keys.add(m.code); if (/^(Key[WASD]|Arrow)/.test(m.code)) s.glide = null; }
    else s.keys.delete(m.code);
  });
  addEventListener("blur", () => s.keys.clear());

  return {
    state: s,
    // x, z: where to stand. yaw: heading when you get there (radians; 0 faces north / -z).
    glideTo(x, z, yaw = s.yaw, pitch = 0) {
      let dyaw = ((yaw - s.yaw) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI; // the short way round
      s.glide = { from: [rig.position.x, rig.position.z, s.yaw, s.pitch], to: [x, z, s.yaw + dyaw, pitch], t: 0 };
    },
    jumpTo(x, z, yaw = s.yaw) { rig.position.set(x, 0, z); s.yaw = yaw; s.pitch = 0; s.glide = null; inside(); },
    update(dt) {
      if (s.glide) {
        const G = s.glide;
        G.t = Math.min(1, G.t + dt / 0.9);
        const e = G.t < 0.5 ? 2 * G.t * G.t : 1 - (-2 * G.t + 2) ** 2 / 2;
        const lerp = (i) => G.from[i] + (G.to[i] - G.from[i]) * e;
        rig.position.x = lerp(0); rig.position.z = lerp(1); s.yaw = lerp(2); s.pitch = lerp(3);
        if (G.t === 1) s.glide = null;
      }
      const k = s.keys, fwd = (k.has("KeyW") || k.has("ArrowUp")) - (k.has("KeyS") || k.has("ArrowDown"));
      const side = k.has("KeyD") - k.has("KeyA"), turn = k.has("ArrowLeft") - k.has("ArrowRight");
      s.yaw += turn * 1.8 * dt;
      if (fwd || side) {
        const v = (k.has("ShiftLeft") || k.has("ShiftRight") ? 3.2 : 1.6) * dt;
        rig.position.x += (-Math.sin(s.yaw) * fwd + Math.cos(s.yaw) * side) * v;
        rig.position.z += (-Math.cos(s.yaw) * fwd - Math.sin(s.yaw) * side) * v;
      }
      inside();
      camera.position.set(0, EYE, 0);
      camera.rotation.set(s.pitch, s.yaw, 0, "YXZ");
    },
  };
}
