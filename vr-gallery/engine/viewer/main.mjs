// The viewer: ?project=<gallery.yaml> in, a walkable room out — on a screen, or in a headset.
//
//   ?project=/path/gallery.yaml   the gallery to load (resolved against this page)
//   ?work=<id>                    open standing at that work with its story showing
//   &hash=0x…&step=<n>            …and, for a live work, replay that moment (a caught frame)
//   &epoch=<n>                    …which, for a chain-broadcast work, can still be minted if live
//   ?chrome=0                     no title / hint — for a host page that draws its own
//
// window.GALLERY exposes the scene for poking from the console.
import * as THREE from "three";
import { parseYAML } from "../src/yaml.mjs";
import { normalize, viewpoint } from "../src/gallery.mjs";
import { buildRoom } from "./room.mjs";
import { walk } from "./walk.mjs";
import { storyHTML, storyPanel, liveHTML } from "./story.mjs";
import { xrButton, xrControllers } from "./xr.mjs";
import { liveRunner } from "./live.mjs";
import { chain as connectChain } from "./chain.mjs";
import { isHash } from "../src/seed.mjs";

const qs = new URLSearchParams(location.search);
const setQuery = (q) => history.replaceState(null, "", "?" + String(q).replace(/%2F/gi, "/")); // keep project paths readable
const $ = (id) => document.getElementById(id);
if (qs.get("chrome") === "0") document.body.classList.add("chrome-off");

function fail(html) { $("msg").innerHTML = html; $("msg").hidden = false; }

async function load() {
  const project = qs.get("project");
  if (!project) return fail("No gallery to show. Add <code>?project=path/to/gallery.yaml</code> to the URL.");
  const url = new URL(project, location.href).href;
  const res = await fetch(url).catch(() => null);
  if (!res?.ok) return fail(`Couldn't load <code>${project}</code>${res ? ` (${res.status})` : ""}.`);
  const gallery = normalize(parseYAML(await res.text()), url);
  for (const w of gallery.warnings) console.warn("[vr-gallery]", w);
  return gallery;
}

const gallery = await load();
if (gallery) start(gallery);

function start(gallery) {
  document.title = gallery.title;
  $("title").innerHTML = `<h1></h1><p></p>`;
  $("title").querySelector("h1").textContent = gallery.title;
  $("title").querySelector("p").textContent = gallery.artist || "";

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType("local-floor");
  document.body.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c0c0d);
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 100);
  // Portrait phones: hold the horizontal field of view instead, or the room is seen through a slot.
  const fitFov = () => {
    camera.aspect = innerWidth / innerHeight;
    camera.fov = camera.aspect >= 1 ? 70 : Math.min(105, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(35)) / camera.aspect)) * 0.8);
    camera.updateProjectionMatrix();
  };
  fitFov();
  if (matchMedia("(pointer: coarse)").matches) $("hint").textContent = "drag to look · tap the floor to go there · tap a work for its story";
  const rig = new THREE.Group();
  rig.add(camera);
  scene.add(rig);

  const room = buildRoom(gallery, renderer);
  scene.add(room.root);
  const size = gallery.room.size;

  // ── screen: walk, tap, story drawer ─────────────────────────────────────────
  const ray = new THREE.Raycaster();
  const pick = (e) => {
    ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
    return ray.intersectObjects([...room.hits, room.floor], false)[0] || null;
  };
  const faceWork = (work) => {
    const [x, z] = viewpoint(work.ex, size, work.height);
    nav.glideTo(x, z, work.ex.rotY, 0);
  };
  // With the drawer open on a wide screen, shift the projection centre into the uncovered part,
  // so the work you're reading about isn't hiding behind its own story.
  const frameView = () => {
    const w = $("story").classList.contains("open") && innerWidth > 720 ? $("story").offsetWidth : 0;
    if (w) camera.setViewOffset(innerWidth, innerHeight, w / 2, 0, innerWidth, innerHeight);
    else camera.clearViewOffset();
  };
  const ch = gallery.chain ? connectChain(gallery.chain) : null;
  let storyWork = null; // whose story is in the drawer
  const mintable = (run) => !!(ch && run?.frozen && run.epoch !== null);
  const drawStory = () => {
    if (!storyWork) return;
    const run = storyWork.live;
    $("story").querySelector(".body").innerHTML = storyHTML(storyWork.ex) + (run ? liveHTML(run, { mintable: mintable(run), handoff: mintable(run) ? momentLink(storyWork) : null }) : "");
  };
  // The URL always says what you're looking at: the work, and for a caught moment, hash + step.
  const syncQuery = () => {
    const q = new URLSearchParams(location.search);
    for (const k of ["work", "hash", "step", "epoch"]) q.delete(k);
    if (storyWork) q.set("work", storyWork.ex.id);
    const run = storyWork?.live;
    if (run?.frozen) { q.set("hash", run.hash); q.set("step", run.step); if (run.epoch !== null) q.set("epoch", run.epoch); }
    setQuery(q);
    if (parent !== window) parent.postMessage({ vrGallery: "view", query: String(q).replace(/%2F/gi, "/") }, "*");
  };
  const openStory = (work) => {
    if (storyWork !== work && storyWork?.live?.frozen) storyWork.live.resume(); // moving on lets the last one run
    storyWork = work;
    drawStory();
    $("story").classList.add("open");
    frameView();
    $("story").scrollTop = 0;
    syncQuery();
  };
  const closeStory = () => {
    const run = storyWork?.live;
    storyWork = null;
    if (run?.frozen) run.resume(); // let it run on
    $("story").classList.remove("open");
    frameView();
    syncQuery();
  };
  $("story").querySelector(".close").onclick = closeStory;
  // Catch a live work at the frame you're seeing — the "click when you see it" moment.
  const catchMoment = (work) => { if (work.live && !work.live.frozen) work.live.freeze(); };
  // A link to a view: the host page's, when we're framed on the same site, else our own.
  const shareURL = (q = new URLSearchParams(location.search)) => {
    try { if (parent !== window) { q.delete("project"); return parent.location.origin + parent.location.pathname + "?" + String(q).replace(/%2F/gi, "/"); } } catch {}
    return location.origin + location.pathname + "?" + String(q).replace(/%2F/gi, "/");
  };
  // The link to a caught moment (what the QR handoff encodes): opening it replays the frame.
  const momentLink = (work) => {
    const run = work.live, q = new URLSearchParams(location.search);
    for (const k of ["work", "hash", "step", "epoch"]) q.delete(k);
    q.set("work", work.ex.id); q.set("hash", run.hash); q.set("step", run.step);
    if (run.epoch !== null) q.set("epoch", run.epoch);
    return shareURL(q);
  };
  $("story").addEventListener("click", async (e) => {
    const act = e.target.closest("[data-live]")?.dataset.live, run = storyWork?.live;
    if (!act || !run) return;
    if (act === "catch") run.freeze();
    if (act === "resume") run.resume();
    if (act === "copy") {
      await navigator.clipboard?.writeText(shareURL()).catch(() => {});
      e.target.textContent = "Copied";
      return;
    }
    if (act === "mint") {
      const status = $("story").querySelector(".mint-status"), btn = e.target;
      btn.disabled = true;
      try {
        const { tokenId, url } = await ch.mint({ piece: storyWork.ex.media.piece, epoch: run.epoch, step: run.step, hash: run.hash }, (s) => (status.textContent = s));
        status.innerHTML = `Minted: moment #${tokenId}.` + (url ? ` <a href="${url}" target="_blank" rel="noopener">Its link</a> replays this frame.` : "");
        btn.textContent = "Minted";
      } catch (err) {
        status.textContent = err.message;
        btn.disabled = false;
      }
      return;
    }
    syncQuery();
  });
  // the step counter ticks while the drawer shows a running piece
  setInterval(() => {
    const el = $("story").querySelector(".step");
    if (el && storyWork?.live) el.textContent = storyWork.live.step;
  }, 200);
  addEventListener("keydown", (e) => e.key === "Escape" && closeStory());

  const nav = walk({
    rig, camera, dom: renderer.domElement, bounds: size,
    onTap(e) {
      const hit = pick(e);
      if (!hit) return;
      const work = hit.object.userData.work;
      if (work) { catchMoment(work); faceWork(work); openStory(work); }
      else { closeStory(); nav.glideTo(hit.point.x, hit.point.z); }
    },
    onHover(e) { renderer.domElement.style.cursor = pick(e)?.object.userData.work ? "pointer" : ""; },
  });

  // ── live pieces ─────────────────────────────────────────────────────────────
  const live = room.works.filter((w) => w.ex.media.type === "live");
  for (const work of live) {
    liveRunner({
      media: work.ex.media, renderer,
      source: work.ex.media.seed === "chain" && ch ? ch.source(work.ex.media.piece) : undefined,
      onChange(run) { // a new iteration (new texture), or caught / resumed
        work.show(run.texture, run.aspect);
        if (storyWork === work) { drawStory(); syncQuery(); }
      },
    }).then((run) => {
      work.live = run;
      if (qs.get("work") === work.ex.id && isHash(qs.get("hash"))) run.seek(qs.get("hash"), +qs.get("step") || 0, qs.has("epoch") ? BigInt(qs.get("epoch")) : null);
      if (storyWork === work) { drawStory(); syncQuery(); }
    }, (err) => console.warn(`[vr-gallery] ${work.ex.id}: couldn't start ${work.ex.media.src}`, err));
  }
  const frustum = new THREE.Frustum(), viewProj = new THREE.Matrix4();
  const stepLive = (dt) => {
    viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProj);
    for (const w of live) w.live?.update(dt, renderer.xr.isPresenting || frustum.intersectsObject(w.art));
  };

  const [sx, sz] = gallery.room.spawn.at;
  const look = gallery.room.spawn.look;
  const LOOK = { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 };
  nav.jumpTo(sx, sz, typeof look === "number" ? THREE.MathUtils.degToRad(look) : LOOK[look] ?? 0);
  const deep = room.works.find((w) => w.ex.id === qs.get("work"));
  if (deep) {
    const [x, z] = viewpoint(deep.ex, size, deep.height);
    nav.jumpTo(x, z, deep.ex.rotY);
    openStory(deep);
  }

  // ── headset: rays, teleport, floating story panel ───────────────────────────
  let panel = null;
  const closePanel = () => {
    if (!panel) return;
    if (panel.userData.work?.live?.frozen) panel.userData.work.live.resume();
    scene.remove(panel);
    panel.material.map.dispose();
    panel = null;
  };
  const xr = xrControllers({
    renderer, rig,
    targets: () => [...(panel ? [panel] : []), ...room.hits, room.floor],
    onSelect(hit) {
      if (!hit || hit.object === panel) return closePanel();
      const work = hit.object.userData.work;
      if (!work) { closePanel(); return xr.teleport(hit.point); }
      closePanel();
      catchMoment(work);
      // float the story an arm's length in front of the head, turned to face it
      panel = storyPanel(work.ex, work.live, { handoff: mintable(work.live) ? momentLink(work) : null });
      panel.userData.work = work;
      const h = xr.head();
      const toHead = new THREE.Vector3(h.x - hit.point.x, 0, h.z - hit.point.z);
      const dist = toHead.length();
      toHead.normalize();
      panel.position.set(h.x - toHead.x * Math.min(0.9, dist * 0.6), h.y - 0.05, h.z - toHead.z * Math.min(0.9, dist * 0.6));
      panel.lookAt(h.x, h.y - 0.05, h.z);
      scene.add(panel);
    },
  });
  xrButton(renderer, $("xr"), {
    onStart() { closeStory(); rig.rotation.y = nav.state.yaw; camera.rotation.set(0, 0, 0); },
    onEnd() { closePanel(); nav.state.yaw = rig.rotation.y; nav.state.pitch = 0; rig.rotation.y = 0; },
  });

  addEventListener("resize", () => {
    fitFov();
    renderer.setSize(innerWidth, innerHeight);
    frameView();
  });

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    if (renderer.xr.isPresenting) xr.update();
    else nav.update(dt);
    stepLive(dt);
    renderer.render(scene, camera);
  });

  window.GALLERY = { gallery, scene, camera, rig, room, nav, renderer };
}
