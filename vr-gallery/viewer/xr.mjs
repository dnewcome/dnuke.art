// Headset mode. An "Enter VR" button that only appears when the browser can actually do
// immersive-vr (no "VR NOT SUPPORTED" on every laptop), a pointing ray per controller, trigger to
// teleport (floor) or open a story (a work), and snap turn on either thumbstick.
// Works on anything with WebXR + controllers: Quest browser, Vision Pro Safari (pinch = select),
// PC VR through Chrome. AR placement is a later slice; this is where it would plug in.
import * as THREE from "three";

const SNAP = Math.PI / 6;

export async function xrButton(renderer, el, { onStart, onEnd } = {}) {
  if (!navigator.xr || !(await navigator.xr.isSessionSupported("immersive-vr").catch(() => false))) return false;
  let session = null;
  el.hidden = false;
  el.textContent = "Enter VR";
  el.onclick = async () => {
    if (session) return session.end();
    session = await navigator.xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor", "bounded-floor", "hand-tracking"] });
    session.addEventListener("end", () => { session = null; el.textContent = "Enter VR"; onEnd?.(); });
    await renderer.xr.setSession(session);
    el.textContent = "Exit VR";
    onStart?.();
  };
  return true;
}

// targets(): meshes a ray can hit. onSelect(hit | null, controller) decides what a trigger means.
export function xrControllers({ renderer, rig, targets, onSelect }) {
  const ray = new THREE.Raycaster();
  const m4 = new THREE.Matrix4();
  const reticle = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.16, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthTest: false }));
  reticle.visible = false;
  reticle.renderOrder = 11;
  rig.parent.add(reticle);

  const hands = [0, 1].map((i) => {
    const c = renderer.xr.getController(i);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }));
    line.scale.z = 5;
    c.add(line, new THREE.Mesh(new THREE.SphereGeometry(0.012), new THREE.MeshBasicMaterial({ color: 0xffffff })));
    c.userData = { line, hit: null, gamepad: null, turned: false };
    c.addEventListener("connected", (e) => { c.userData.gamepad = e.data.gamepad; line.visible = e.data.targetRayMode !== "gaze"; });
    c.addEventListener("disconnected", () => { c.userData.gamepad = null; });
    c.addEventListener("select", () => onSelect(c.userData.hit, c));
    rig.add(c);
    return c;
  });

  const head = () => new THREE.Vector3().setFromMatrixPosition(renderer.xr.getCamera().matrixWorld);

  return {
    // Move the rig so the HEAD (not the rig origin) lands on the point.
    teleport(p) {
      const h = head();
      rig.position.x += p.x - h.x;
      rig.position.z += p.z - h.z;
    },
    // Turn the rig about the head, so you spin in place instead of orbiting the rig origin.
    turn(a) {
      const h = head();
      const off = new THREE.Vector3().subVectors(rig.position, h).applyAxisAngle(THREE.Object3D.DEFAULT_UP, a);
      rig.position.set(h.x + off.x, rig.position.y, h.z + off.z);
      rig.rotation.y += a;
    },
    head,
    update() {
      reticle.visible = false;
      const list = targets();
      for (const c of hands) {
        m4.identity().extractRotation(c.matrixWorld);
        ray.ray.origin.setFromMatrixPosition(c.matrixWorld);
        ray.ray.direction.set(0, 0, -1).applyMatrix4(m4);
        const hit = ray.intersectObjects(list, false)[0] || null;
        c.userData.hit = hit;
        c.userData.line.scale.z = hit ? hit.distance : 5;
        c.userData.line.material.color.set(hit && hit.object.name !== "floor" ? 0xf2c14e : 0xffffff);
        if (hit?.object.name === "floor") { reticle.position.copy(hit.point).setY(0.01); reticle.visible = true; }
        const ax = c.userData.gamepad?.axes;
        const x = ax ? (Math.abs(ax[2] ?? 0) > Math.abs(ax[0] ?? 0) ? ax[2] : ax[0]) : 0;
        if (Math.abs(x) > 0.7 && !c.userData.turned) { this.turn(-Math.sign(x) * SNAP); c.userData.turned = true; }
        if (Math.abs(x) < 0.3) c.userData.turned = false;
      }
    },
  };
}
