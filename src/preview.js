// three.js preview of the generated solids. Model units are mm with Z up.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createPreview(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15181d);
  const camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
  camera.position.set(0, 160, 220);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.maxPolarAngle = Math.PI * 0.495;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f4a, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(-1.2, 2, 1.4);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.5);
  fill.position.set(1.5, 0.8, -1);
  scene.add(fill);

  // model group: rotate so that model Z is up and north points away from the camera
  const model = new THREE.Group();
  model.rotation.x = -Math.PI / 2;
  scene.add(model);
  let grid = null;
  let meshes = [];
  let lastSize = '';

  const frame = (w, h, t) => {
    const r = Math.hypot(w, h, t) / 2;
    const dist = (r / Math.sin((camera.fov * Math.PI) / 360)) * 1.3;
    controls.target.set(0, t / 2, 0);
    camera.position.set(0, t / 2 + dist * 0.62, dist * 0.78);
    camera.near = dist / 100;
    camera.far = dist * 20;
    camera.updateProjectionMatrix();
  };

  const render = () => {
    controls.update();
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(render);

  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false); // CSS sizes the canvas, so it can never push the layout
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  };
  new ResizeObserver(resize).observe(container);
  resize();

  return {
    /**
     * @param {{tris:Float32Array,color:string}[]} parts
     * @param {{width:number,depth:number,height:number}} size  mm
     */
    setModel(parts, size) {
      for (const m of meshes) {
        model.remove(m);
        m.geometry.dispose();
        m.material.dispose();
      }
      meshes = parts.map((p) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(p.tris, 3));
        const mat = new THREE.MeshStandardMaterial({ color: p.color, flatShading: true, roughness: 0.82, metalness: 0 });
        const mesh = new THREE.Mesh(g, mat);
        mesh.position.set(-size.width / 2, -size.depth / 2, 0);
        model.add(mesh);
        return mesh;
      });

      const key = `${size.width.toFixed(1)}x${size.depth.toFixed(1)}`;
      if (key !== lastSize) {
        lastSize = key;
        if (grid) {
          scene.remove(grid);
          grid.geometry.dispose();
          grid.material.dispose();
        }
        const span = Math.ceil((Math.max(size.width, size.depth) * 1.5) / 20) * 20;
        grid = new THREE.GridHelper(span, span / 10, 0x4a5261, 0x2a2f38);
        grid.position.y = -0.02;
        scene.add(grid);
        frame(size.width, size.depth, size.height);
      }
      render(); // also paints while the tab is in the background
    },
    setColors(colors) {
      meshes.forEach((m, i) => colors[i] && m.material.color.set(colors[i]));
    },
    resetView(size) {
      frame(size.width, size.depth, size.height);
    },
  };
}
