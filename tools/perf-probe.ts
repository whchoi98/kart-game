/**
 * In-page instrumentation shared by the perf tools (tools/perf-*.ts). Plain JS in a string so that
 * tsx/esbuild helpers never leak into page.evaluate(). Installs window.__perf:
 *   install()     wraps the live RaceSession / pipeline / renderer methods to time sim, visual updates,
 *                 audio and render submission per frame, count shadow-pass calls/triangles and (on demand)
 *                 attribute every draw call to its scene object (breakdown).
 *   sceneStats()  meshes, instancing, shadow casters, materials, programs, textures (with sizes) of the race scene.
 * Nothing here ships with the game.
 */
// Plain JS (a string, so tsx/esbuild helpers never leak into the page).
export const PROBE = String.raw`
(() => {
  if (window.__perf) return;
  const T = window.__turbo, view = T.view;
  const now = () => performance.now();
  const heap = () => (performance.memory ? performance.memory.usedJSHeapSize : 0);
  const P = window.__perf = { frames: [], cur: null, session: null, recording: false, breakdown: null, wantBreakdown: false, lastHeap: 0 };
  const labels = new WeakMap();
  function label(o) {
    let l = labels.get(o);
    if (l) return l;
    let top = o, named = o.name ? o : null;
    while (top.parent && !top.parent.isScene) { top = top.parent; if (!named && top.name) named = top; }
    l = (top.name || top.type) + (named && named !== top ? '/' + named.name : '');
    labels.set(o, l);
    return l;
  }
  P.install = function () {
    const s = view.session;
    if (!s || P.session === s) return !!s;
    P.session = s;
    const pipe = s.deps.pipeline, r = pipe.renderer;
    const wrap = (obj, name, key) => {
      const orig = obj[name];
      if (typeof orig !== 'function') return;
      obj[name] = function (...a) { const t = now(); try { return orig.apply(this, a); } finally { if (P.cur) P.cur[key] += now() - t; } };
    };
    wrap(s, 'stepSimulation', 'sim');
    wrap(s, 'handleEvents', 'vis'); wrap(s, 'updateVisuals', 'vis'); wrap(s, 'updateCameras', 'vis');
    wrap(s.scenery, 'update', 'vis'); wrap(s.particles, 'update', 'vis');
    wrap(s.hud, 'advance', 'vis'); wrap(s.hud, 'onEvents', 'vis');
    wrap(s.deps.audio, 'update', 'audio'); wrap(s.deps.audio, 'handleEvents', 'audio');
    wrap(pipe, 'render', 'submit');
    const w = s.world, oStep = w.step;
    w.step = function (...a) { const t = now(); try { return oStep.apply(this, a); } finally { if (P.cur) { P.cur.steps++; P.cur.worldStep += now() - t; } } };
    if (!r.__perfWrapped) {
      r.__perfWrapped = true;
      const sm = r.shadowMap, oSm = sm.render;
      sm.render = function (...a) {
        const c0 = r.info.render.calls, t0 = r.info.render.triangles, t = now();
        P.inShadow = true;
        try { return oSm.apply(this, a); } finally {
          P.inShadow = false;
          if (P.cur) { P.cur.shadow += now() - t; P.cur.shadowCalls += r.info.render.calls - c0; P.cur.shadowTris += r.info.render.triangles - t0; }
        }
      };
      const oRBD = r.renderBufferDirect;
      r.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
        if (P.breakdown) {
          const k = (P.inShadow ? 'S ' : 'M ') + label(object);
          const e = P.breakdown[k] || (P.breakdown[k] = { calls: 0, tris: 0 });
          const t0 = r.info.render.triangles;
          oRBD.call(this, camera, scene, geometry, material, object, group);
          e.calls++; e.tris += r.info.render.triangles - t0;
          return;
        }
        return oRBD.call(this, camera, scene, geometry, material, object, group);
      };
    }
    const oFrame = s.frame;
    s.frame = function (...a) {
      const h0 = heap();
      if (P.wantBreakdown) { P.breakdown = {}; }
      const c = P.cur = { sim: 0, vis: 0, submit: 0, audio: 0, shadow: 0, shadowCalls: 0, shadowTris: 0, steps: 0, worldStep: 0, loopAlloc: P.lastHeap ? h0 - P.lastHeap : 0 };
      const t = now();
      try { return oFrame.apply(this, a); } finally {
        c.total = now() - t;
        c.calls = r.info.render.calls; c.tris = r.info.render.triangles;
        c.frameAlloc = heap() - h0;
        c.rs = s.raceSeconds;
        P.lastHeap = heap();
        if (P.breakdown && P.wantBreakdown) { P.lastBreakdown = P.breakdown; P.breakdown = null; P.wantBreakdown = false; }
        if (P.recording) P.frames.push(c);
        P.cur = null;
      }
    };
    return true;
  };
  P.sceneStats = function () {
    const s = view.session; if (!s) return null;
    const r = s.deps.pipeline.renderer;
    let meshes = 0, instanced = 0, instances = 0, visibleMeshes = 0, casters = 0, receivers = 0, points = 0, lines = 0, sprites = 0, objects = 0;
    const mats = new Set(), geos = new Set(), texs = new Set();
    let geoTris = 0;
    const casterTris = {};
    s.scene.traverse(o => {
      objects++;
      if (o.isPoints) points++;
      if (o.isLine) lines++;
      if (o.isSprite) sprites++;
      if (!o.isMesh) return;
      meshes++;
      if (o.isInstancedMesh) { instanced++; instances += o.count; }
      let vis = true; for (let p = o; p; p = p.parent) if (!p.visible) { vis = false; break; }
      if (vis) visibleMeshes++;
      if (o.castShadow && vis) {
        casters++;
        const g = o.geometry; const tri = g.index ? g.index.count / 3 : (g.attributes.position ? g.attributes.position.count / 3 : 0);
        const lab = label(o); const n = o.isInstancedMesh ? o.count : 1;
        const e = casterTris[lab] || (casterTris[lab] = { n: 0, tris: 0 }); e.n++; e.tris += tri * n;
      }
      if (o.receiveShadow) receivers++;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) {
        mats.add(m);
        for (const k in m) { const v = m[k]; if (v && v.isTexture) texs.add(v); }
        if (m.uniforms) for (const k in m.uniforms) { const v = m.uniforms[k] && m.uniforms[k].value; if (v && v.isTexture) texs.add(v); }
      }
      if (!geos.has(o.geometry)) { geos.add(o.geometry); const g = o.geometry; geoTris += g.index ? g.index.count / 3 : (g.attributes.position ? g.attributes.position.count / 3 : 0); }
    });
    let texBytes = 0; const bigTex = [];
    for (const t of texs) {
      const img = t.image; if (!img) continue;
      const w = img.width || 0, h = img.height || 0, d = img.depth || 1;
      const b = w * h * d * 4 * (t.generateMipmaps !== false && t.minFilter !== 1006 && t.minFilter !== 1003 ? 1.333 : 1);
      texBytes += b;
      bigTex.push({ name: t.name || (img.nodeName || img.constructor && img.constructor.name || '?'), w, h, mb: +(b / 1048576).toFixed(2) });
    }
    bigTex.sort((a, b) => b.mb - a.mb);
    const matTypes = {};
    for (const m of mats) matTypes[m.type] = (matTypes[m.type] || 0) + 1;
    const progs = (r.info.programs || []).map(p => p.name);
    const progNames = {};
    for (const n of progs) progNames[n] = (progNames[n] || 0) + 1;
    const topCasters = Object.entries(casterTris).sort((a, b) => b[1].tris - a[1].tris).slice(0, 12).map(([k, v]) => ({ k, n: v.n, tris: Math.round(v.tris) }));
    const sm = r.shadowMap;
    return {
      objects, meshes, instanced, instances, visibleMeshes, casters, receivers, points, lines, sprites,
      materials: mats.size, matTypes, sceneGeometries: geos.size, geoTris: Math.round(geoTris),
      sceneTextures: texs.size, texMB: +(texBytes / 1048576).toFixed(1), bigTex: bigTex.slice(0, 10),
      programs: progs.length, progNames, topCasters,
      memGeometries: r.info.memory.geometries, memTextures: r.info.memory.textures,
      shadowMapSize: (() => { let sz = 0; s.scene.traverse(o => { if (o.isDirectionalLight) sz = o.shadow.mapSize.x; }); return sz; })(),
      shadowsOn: sm.enabled, pixelRatio: r.getPixelRatio(),
      drawBuffer: [r.domElement.width, r.domElement.height],
    };
  };
})();
`;
