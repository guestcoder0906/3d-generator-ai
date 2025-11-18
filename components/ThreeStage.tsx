import React, { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';

export interface ThreeStageHandle {
  resetScene: () => void;
  addObject: (obj: THREE.Object3D) => void;
  captureSnapshots: () => Promise<string[]>;
  getScene: () => THREE.Scene;
  getGeneratedGroup: () => THREE.Group | null;
}

const ThreeStage = forwardRef<ThreeStageHandle, {}>((props, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rootGroupRef = useRef<THREE.Group | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);

  // Initialization (Run Once)
  useEffect(() => {
    if (!containerRef.current) return;

    // 1. Immutable Renderer Setup
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // 2. Immutable Scene Setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#111111');
    scene.fog = new THREE.Fog('#111111', 10, 50);
    
    // Grid for visual reference (not used in snapshots technically, but good for UX)
    const grid = new THREE.GridHelper(20, 20, 0x444444, 0x222222);
    scene.add(grid);
    sceneRef.current = scene;

    // 3. Immutable Camera Setup
    const camera = new THREE.PerspectiveCamera(45, containerRef.current.clientWidth / containerRef.current.clientHeight, 0.1, 1000);
    camera.position.set(5, 5, 5);
    cameraRef.current = camera;

    // 4. Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controlsRef.current = controls;

    // 5. Immutable Lighting (Enhanced 3-Point Setup for QC Stability)
    // Increased ambient to prevent pitch black shadows
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    // Hemisphere light to give better form definition
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x222222, 0.6);
    hemiLight.position.set(0, 20, 0);
    scene.add(hemiLight);

    // Key Light (Main Shadow Caster)
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
    keyLight.position.set(5, 10, 7);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.bias = -0.0001;
    scene.add(keyLight);

    // Fill Light (Soften Shadows)
    const fillLight = new THREE.DirectionalLight(0xffeedd, 0.5);
    fillLight.position.set(-5, 2, 5);
    scene.add(fillLight);

    // Back Light (Rim Light)
    const backLight = new THREE.DirectionalLight(0xddeeff, 0.5);
    backLight.position.set(0, 5, -10);
    scene.add(backLight);

    // Bottom Light (Specific fix for "Black Bottom" false positives in QC)
    // Illuminates the underside of models so the AI sees geometry instead of void
    const bottomLight = new THREE.DirectionalLight(0x888888, 0.8);
    bottomLight.position.set(0, -10, 0);
    scene.add(bottomLight);

    // Root group for AI generated content
    const rootGroup = new THREE.Group();
    scene.add(rootGroup);
    rootGroupRef.current = rootGroup;

    // Animation Loop
    const animate = () => {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // Resize Handler
    const handleResize = () => {
      if (!containerRef.current || !cameraRef.current || !rendererRef.current) return;
      const width = containerRef.current.clientWidth;
      const height = containerRef.current.clientHeight;
      cameraRef.current.aspect = width / height;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(width, height);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      renderer.dispose();
      if (containerRef.current) containerRef.current.innerHTML = '';
    };
  }, []);

  useImperativeHandle(ref, () => ({
    resetScene: () => {
      if (rootGroupRef.current) {
        rootGroupRef.current.clear();
      }
    },
    getScene: () => {
      return sceneRef.current!;
    },
    getGeneratedGroup: () => {
      return rootGroupRef.current;
    },
    addObject: (obj: THREE.Object3D) => {
      if (rootGroupRef.current) {
        rootGroupRef.current.add(obj);
      }
    },
    captureSnapshots: async () => {
      if (!rendererRef.current || !sceneRef.current || !rootGroupRef.current || !cameraRef.current) return [];
      
      const snapshots: string[] = [];
      const originalPos = cameraRef.current.position.clone();
      const originalTarget = controlsRef.current?.target.clone() || new THREE.Vector3();
      
      // Isolate object: Hide grid/helper for clean shot
      const grid = sceneRef.current.children.find(c => c instanceof THREE.GridHelper);
      if (grid) grid.visible = false;

      // --- Auto-Framing Logic ---
      // 1. Calculate Bounding Box
      const box = new THREE.Box3().setFromObject(rootGroupRef.current);
      const size = new THREE.Vector3();
      box.getSize(size);
      const center = new THREE.Vector3();
      box.getCenter(center);

      // 2. Determine optimal distance
      const maxDim = Math.max(size.x, size.y, size.z);
      const fov = cameraRef.current.fov * (Math.PI / 180);
      
      // Calculate distance to fit object vertically/horizontally in FOV
      // Add 50% padding (1.5x) to ensure edges aren't touching
      let cameraDistance = Math.abs(maxDim / (2 * Math.tan(fov / 2))) * 1.5;
      
      // Fallback for empty/tiny objects (prevent zero distance)
      if (maxDim === 0 || !isFinite(cameraDistance) || cameraDistance < 0.1) cameraDistance = 5;

      // 3. Define relative positions based on calculated distance
      // Use a tiny offset (0.001) for Top/Bottom to prevent LookAt singularity with Up vector
      const positions = [
        new THREE.Vector3(0, 0, cameraDistance), // Front
        new THREE.Vector3(0, 0, -cameraDistance), // Back
        new THREE.Vector3(0.001, cameraDistance, 0), // Top
        new THREE.Vector3(0.001, -cameraDistance, 0), // Bottom
        new THREE.Vector3(cameraDistance, 0, 0), // Right
        new THREE.Vector3(-cameraDistance, 0, 0), // Left
      ];

      for (const offset of positions) {
        // Position camera relative to the object's actual center
        cameraRef.current.position.copy(center).add(offset);
        cameraRef.current.lookAt(center);

        // Adjust clipping planes to accommodate scale
        cameraRef.current.near = Math.max(0.01, cameraDistance / 100);
        cameraRef.current.far = Math.max(1000, cameraDistance * 10);
        cameraRef.current.updateProjectionMatrix();

        // Render
        rendererRef.current.render(sceneRef.current, cameraRef.current);
        snapshots.push(rendererRef.current.domElement.toDataURL('image/png'));
        
        // Small delay to ensure buffer clear
        await new Promise(r => setTimeout(r, 50)); 
      }

      // Restore
      if (grid) grid.visible = true;
      cameraRef.current.position.copy(originalPos);
      if (controlsRef.current) controlsRef.current.target.copy(originalTarget);
      cameraRef.current.lookAt(originalTarget);
      
      // Reset default clipping
      cameraRef.current.near = 0.1;
      cameraRef.current.far = 1000;
      cameraRef.current.updateProjectionMatrix();
      
      return snapshots;
    }
  }));

  return (
    <div ref={containerRef} className="w-full h-full relative rounded-lg overflow-hidden border border-gray-800 shadow-2xl" />
  );
});

export default ThreeStage;