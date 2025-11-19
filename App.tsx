import React, { useState, useRef, useCallback, useEffect } from 'react';
import * as THREE from 'three';
import { AppPhase, BuildPlan, ComponentArtifact, LogEntry, ComponentPlan } from './types';
import ThreeStage, { ThreeStageHandle } from './components/ThreeStage';
import { generateBuildPlan, generateComponentCode, performVisualQC, generateAttachmentCode, performAssemblyQC } from './services/geminiService';

// Exporter Imports
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter';

// Icon Imports
const IconBrain = () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M17.636 17.636l-.707-.707M12 21v-1M4.364 17.636l.707-.707M3 12h1M6.364 6.364l.707.707" /></svg>;
const IconCode = () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>;
const IconEye = () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>;
const IconCheck = () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>;
const IconAlert = () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>;
const IconDownload = () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>;

export default function App() {
  // --- State ---
  const [prompt, setPrompt] = useState("A futuristic cyberpunk drone with rotating rotors and a camera mount");
  const [phase, setPhase] = useState<AppPhase>(AppPhase.IDLE);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [buildPlan, setBuildPlan] = useState<BuildPlan | null>(null);
  const [components, setComponents] = useState<Record<string, ComponentArtifact>>({});
  const [currentProcessingId, setCurrentProcessingId] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  
  const threeStageRef = useRef<ThreeStageHandle>(null);
  
  // Stores valid THREE objects for final assembly
  const validatedObjectsRef = useRef<Record<string, THREE.Object3D>>({});

  // --- Logging ---
  const addLog = useCallback((message: string, type: LogEntry['type'] = 'info') => {
    setLogs(prev => [{ timestamp: Date.now(), phase, message, type }, ...prev]);
  }, [phase]);

  // --- Sanitization ---
  const sanitizeCode = (code: string): string => {
    // Double check sanitization on client side before execution
    return code
      .replace(/export\s+default\s+function/g, 'function')
      .replace(/export\s+default\s+/g, '')
      .replace(/export\s+/g, '')
      .replace(/import\s+.*?from\s+.*?;/g, '')
      .replace(/import\s+.*?from\s+.*?/g, '');
  };

  // --- Execution Sandbox ---
  const executeGeneratedCode = (code: string): THREE.Object3D => {
    try {
      const safeCode = sanitizeCode(code);
      const wrappedCode = `
        ${safeCode}
        return createPart(THREE);
      `;
      const generatorFunc = new Function('THREE', wrappedCode);
      const result = generatorFunc(THREE);
      if (!(result instanceof THREE.Object3D)) {
        throw new Error("Generated code did not return a valid THREE.Object3D instance.");
      }
      return result;
    } catch (e: any) {
      throw new Error(`Execution Error: ${e.message}. Stack: ${e.stack}`);
    }
  };

  const executeAttachmentCode = (code: string, root: THREE.Object3D, part: THREE.Object3D): void => {
    try {
      const safeCode = sanitizeCode(code);
      const wrappedCode = `
        ${safeCode}
        return attach(root, part);
      `;
      const attacherFunc = new Function('root', 'part', 'THREE', wrappedCode);
      attacherFunc(root, part, THREE);
    } catch (e: any) {
      throw new Error(`Attachment Execution Error: ${e.message}`);
    }
  };

  // --- Topological Sort for Assembly Order ---
  const sortComponentsTopologically = (components: ComponentPlan[]): ComponentPlan[] => {
    const visited = new Set<string>();
    const sorted: ComponentPlan[] = [];
    const tempVisited = new Set<string>(); // For cycle detection

    const visit = (nodeId: string) => {
      if (visited.has(nodeId)) return;
      if (tempVisited.has(nodeId)) return; // Cycle detected, skip

      tempVisited.add(nodeId);
      
      const node = components.find(c => c.id === nodeId);
      if (node) {
        // Visit dependencies first
        if (node.dependencies) {
          node.dependencies.forEach(depId => visit(depId));
        }
        visited.add(nodeId);
        sorted.push(node);
      }
    };

    // Start visiting all nodes. If dependencies are missing, it just adds them.
    components.forEach(c => visit(c.id));
    return sorted;
  };

  // --- Core Pipeline ---

  const runPipeline = async () => {
    if (!prompt.trim()) return;
    setPhase(AppPhase.PLANNING);
    setLogs([]);
    setComponents({});
    validatedObjectsRef.current = {};
    threeStageRef.current?.resetScene();

    try {
      // 1. Planning
      addLog("Initiating Gemini 3.0 Pro... Generating Build Plan...", 'info');
      const plan = await generateBuildPlan(prompt);
      setBuildPlan(plan);
      addLog(`Plan generated: ${plan.overview}`, 'success');
      
      // Initialize component states
      const initialComponents: Record<string, ComponentArtifact> = {};
      plan.components.forEach(c => {
        initialComponents[c.id] = {
          plan: c,
          code: '',
          status: 'PENDING',
          retryCount: 0,
          qcHistory: [],
          errorLogs: []
        };
      });
      setComponents(initialComponents);
      
      // Local mutable copy of components to prevent stale closure issues in async loop
      const pipelineComponents = { ...initialComponents };

      // Store images of verified parts to pass as context to subsequent parts
      const collectedContextImages: string[] = [];

      // 2. Component Generation Loop
      for (const component of plan.components) {
        const processedArtifact = await processComponent(
          component.id, 
          pipelineComponents[component.id], 
          collectedContextImages
        );
        // Update local tracker
        pipelineComponents[component.id] = processedArtifact;
      }

      // 3. Step-by-Step Assembly Loop
      setPhase(AppPhase.ASSEMBLING);
      addLog("Starting Step-by-Step Assembly...", 'info');
      
      // Determine logical order (Dependencies first)
      const sortedComponents = sortComponentsTopologically(plan.components);
      
      // The first component is treated as the "Root" or "Core"
      const rootComp = sortedComponents[0];
      if (!rootComp) throw new Error("No components to assemble");

      addLog(`Setting Anchor Component: ${rootComp.name}`, 'info');
      
      // Initialize Assembly State with Root
      const rootObject = validatedObjectsRef.current[rootComp.id].clone();
      // Center the root explicitly
      const box = new THREE.Box3().setFromObject(rootObject);
      const center = new THREE.Vector3();
      box.getCenter(center);
      rootObject.position.sub(center);

      // Setup Scene with Root
      threeStageRef.current?.resetScene();
      threeStageRef.current?.addObject(rootObject);
      
      // Capture initial state
      await new Promise(r => setTimeout(r, 400));
      let currentAssemblySnapshots = await threeStageRef.current?.captureSnapshots() || [];

      // Iterate through remaining components and attach them one by one
      const componentsToAttach = sortedComponents.slice(1);

      for (const partComp of componentsToAttach) {
        setCurrentProcessingId(partComp.id);
        
        // Use pipelineComponents instead of state 'components' to get fresh data
        const partArtifact = pipelineComponents[partComp.id];
        
        if (!partArtifact) {
            addLog(`Skipping ${partComp.name} (Data not found)`, 'error');
            continue;
        }
        
        if (partArtifact.status !== 'VERIFIED') {
          addLog(`Skipping ${partComp.name} (Not Verified)`, 'warning');
          continue;
        }

        addLog(`Attaching: ${partComp.name}...`, 'info');
        
        let attached = false;
        let retries = 0;
        let errorContext = "";
        
        while (!attached && retries < 4) {
          try {
            // 1. Generate Attachment Code
            // We show the AI the current assembly state + the new part to add
            const code = await generateAttachmentCode(
              plan.overview,
              partComp.name,
              partComp.description,
              currentAssemblySnapshots,
              undefined, // We don't pass old code here to force fresh thinking, but we pass error context
              errorContext
            );

            // 2. Execute Attachment (on a test clone first to avoid corrupting main state)
            const testRoot = rootObject.clone(); 
            const partObj = validatedObjectsRef.current[partComp.id].clone();
            
            // Reset Scene to Test State
            threeStageRef.current?.resetScene();
            threeStageRef.current?.addObject(testRoot);
            
            // Run logic (mutates testRoot by adding partObj)
            executeAttachmentCode(code, testRoot, partObj);
            
            // 3. Visual QC on this specific step
            await new Promise(r => setTimeout(r, 400));
            const testSnapshots = await threeStageRef.current?.captureSnapshots() || [];
            
            const qcResult = await performAssemblyQC(plan.overview, partComp.name, testSnapshots);
            
            if (qcResult.passed) {
              addLog(`${partComp.name} Attached Successfully.`, 'success');
              
              // Commit changes
              rootObject.copy(testRoot, true); // Copy structure
              // Note: recursive copy might be tricky with ThreeJS, safer to just swap the reference for the next loop if we were tracking it differently.
              // Since we are clearing scene and adding back, let's just update our local reference logic.
              // Actually, the easiest way is to just clear rootObject's children and copy testRoot's children, 
              // OR just set rootObject = testRoot for the next iteration.
              // However, rootObject is a const reference. Let's use structure mutation.
              
              // Better approach: The Scene is the truth.
              // We validated testRoot. Let's make it the new source of truth.
              // But we need to keep 'rootObject' variable updated for the next loop iteration clone.
              rootObject.children = [...testRoot.children]; // Transfer ownership of children (including the new part)
              rootObject.position.copy(testRoot.position);
              rootObject.rotation.copy(testRoot.rotation);
              rootObject.scale.copy(testRoot.scale);
              
              // Update snapshots for next context
              currentAssemblySnapshots = testSnapshots;
              attached = true;
            } else {
              addLog(`Attachment QC Failed for ${partComp.name}: ${qcResult.feedback}`, 'warning');
              errorContext = qcResult.feedback;
              retries++;
            }

          } catch (e: any) {
            addLog(`Attachment Runtime Error: ${e.message}`, 'error');
            errorContext = e.message;
            retries++;
          }
        }

        if (!attached) {
          addLog(`Failed to attach ${partComp.name} after retries. Skipping.`, 'error');
          // Restore scene to last known good state
          threeStageRef.current?.resetScene();
          threeStageRef.current?.addObject(rootObject);
        }
      }

      addLog("Assembly Completed.", 'success');
      setPhase(AppPhase.COMPLETED);
      setCurrentProcessingId(null);

    } catch (e: any) {
      addLog(`Critical Failure: ${e.message}`, 'error');
      setPhase(AppPhase.ERROR);
    }
  };

  const processComponent = async (
    id: string, 
    artifact: ComponentArtifact, 
    contextImages: string[]
  ): Promise<ComponentArtifact> => {
    setCurrentProcessingId(id);
    let currentArtifact: ComponentArtifact = { ...artifact };
    let verified = false;

    while (!verified && currentArtifact.retryCount < 4) {
      try {
        // A. Generation / Fix
        if (currentArtifact.status === 'PENDING' || currentArtifact.status === 'FAILED') {
          setPhase(currentArtifact.retryCount === 0 ? AppPhase.GENERATING : AppPhase.FIXING);
          addLog(`${currentArtifact.retryCount === 0 ? 'Generating' : 'Fixing'} component: ${currentArtifact.plan.name} (Attempt ${currentArtifact.retryCount + 1})`, 'info');
          
          const lastError = currentArtifact.errorLogs.length > 0 ? currentArtifact.errorLogs[currentArtifact.errorLogs.length - 1] : undefined;
          const lastFeedback = currentArtifact.qcHistory.length > 0 && !currentArtifact.qcHistory[0].passed ? currentArtifact.qcHistory[0].feedback : undefined;
          const errorContext = lastError || lastFeedback;

          const code = await generateComponentCode(
            currentArtifact.plan.name, 
            currentArtifact.plan.description,
            currentArtifact.code,
            errorContext,
            contextImages
          );
          
          currentArtifact.code = code;
          currentArtifact.status = 'GENERATED';
          setComponents(prev => ({ ...prev, [id]: currentArtifact }));
        }

        // B. Execution & Render
        threeStageRef.current?.resetScene();
        const object3d = executeGeneratedCode(currentArtifact.code);
        threeStageRef.current?.addObject(object3d);

        // C. Visual QC
        setPhase(AppPhase.QC_ANALYSIS);
        addLog(`Performing Visual QC on ${currentArtifact.plan.name}...`, 'info');
        await new Promise(r => setTimeout(r, 200));
        const snapshots = await threeStageRef.current?.captureSnapshots() || [];
        
        const qcResult = await performVisualQC(currentArtifact.plan.name, snapshots, contextImages);
        currentArtifact.qcHistory.unshift(qcResult);

        if (qcResult.passed) {
          addLog(`QC PASSED: ${currentArtifact.plan.name}. Score: ${qcResult.score}`, 'success');
          currentArtifact.status = 'VERIFIED';
          verified = true;
          validatedObjectsRef.current[id] = object3d; 
          
          if (snapshots.length > 0) {
             contextImages.push(snapshots[0]);
          }
        } else {
          addLog(`QC FAILED: ${currentArtifact.plan.name}. Feedback: ${qcResult.feedback}`, 'warning');
          currentArtifact.status = 'FAILED';
          currentArtifact.retryCount++;
        }

      } catch (e: any) {
        const errorMsg = `Error: ${e.message}`;
        addLog(errorMsg, 'error');
        currentArtifact.errorLogs.push(errorMsg); 
        currentArtifact.status = 'FAILED';
        currentArtifact.retryCount++;
      }
      
      setComponents(prev => ({ ...prev, [id]: currentArtifact }));
    }

    if (!verified) {
      throw new Error(`Failed to generate stable component ${currentArtifact.plan.name} after maximum retries.`);
    }
    
    return currentArtifact;
  };

  // --- Export Logic ---
  const handleExport = async (format: 'glb' | 'obj' | 'stl') => {
    if (!threeStageRef.current || isExporting) return;
    
    const group = threeStageRef.current.getGeneratedGroup();
    if (!group || group.children.length === 0) {
      addLog("Nothing to export", 'warning');
      return;
    }

    setIsExporting(true);
    addLog(`Exporting model as ${format.toUpperCase()}...`, 'info');

    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `neuroforge-${timestamp}.${format}`;

      if (format === 'glb') {
        const exporter = new GLTFExporter();
        exporter.parse(
          group,
          (result) => {
            const blob = new Blob([result as ArrayBuffer], { type: 'application/octet-stream' });
            downloadBlob(blob, filename);
            addLog(`Export success: ${filename}`, 'success');
            setIsExporting(false);
          },
          (err) => { throw err; },
          { binary: true }
        );
      } 
      else if (format === 'obj') {
        const exporter = new OBJExporter();
        const result = exporter.parse(group);
        const blob = new Blob([result], { type: 'text/plain' });
        downloadBlob(blob, filename);
        addLog(`Export success: ${filename}`, 'success');
        setIsExporting(false);
      } 
      else if (format === 'stl') {
        const exporter = new STLExporter();
        const result = exporter.parse(group, { binary: true });
        const blob = new Blob([result], { type: 'application/octet-stream' });
        downloadBlob(blob, filename);
        addLog(`Export success: ${filename}`, 'success');
        setIsExporting(false);
      }

    } catch (e: any) {
      addLog(`Export failed: ${e.message}`, 'error');
      setIsExporting(false);
    }
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-screen bg-neutral-900 text-white font-sans">
      {/* Sidebar: Controls & Logs */}
      <div className="w-96 flex flex-col border-r border-gray-800 bg-neutral-950">
        <div className="p-6 border-b border-gray-800">
          <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent mb-2">
            NeuroForge 3D
          </h1>
          <p className="text-xs text-gray-500">Gemini 3.0 Pro // Three.js // Autonomous Loop</p>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-2">Prompt</label>
            <textarea 
              className="w-full bg-gray-900 border border-gray-700 rounded p-3 text-sm focus:ring-1 focus:ring-blue-500 outline-none resize-none"
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={phase !== AppPhase.IDLE && phase !== AppPhase.COMPLETED && phase !== AppPhase.ERROR}
            />
          </div>
          <button
            onClick={runPipeline}
            disabled={phase !== AppPhase.IDLE && phase !== AppPhase.COMPLETED && phase !== AppPhase.ERROR}
            className={`w-full py-3 rounded font-bold text-sm tracking-wide transition-all
              ${phase === AppPhase.IDLE || phase === AppPhase.COMPLETED || phase === AppPhase.ERROR
                ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-[0_0_15px_rgba(37,99,235,0.5)]' 
                : 'bg-gray-800 text-gray-500 cursor-not-allowed'}`}
          >
            {phase === AppPhase.IDLE ? 'INITIALIZE GENERATION' : phase === AppPhase.ERROR || phase === AppPhase.COMPLETED ? 'RESET & REGENERATE' : 'PROCESSING...'}
          </button>

          {/* Export Controls - Only show when valid model exists */}
          {phase === AppPhase.COMPLETED && (
            <div className="pt-4 border-t border-gray-800">
              <label className="block text-xs font-medium text-gray-400 mb-2 uppercase tracking-wider">Export Model</label>
              <div className="grid grid-cols-3 gap-2">
                <button 
                  onClick={() => handleExport('glb')} 
                  disabled={isExporting}
                  className="flex items-center justify-center gap-1 py-2 bg-gray-800 hover:bg-gray-700 rounded text-xs font-bold border border-gray-700"
                >
                  {isExporting ? '...' : <><IconDownload /> GLB</>}
                </button>
                <button 
                  onClick={() => handleExport('obj')} 
                  disabled={isExporting}
                  className="flex items-center justify-center gap-1 py-2 bg-gray-800 hover:bg-gray-700 rounded text-xs font-bold border border-gray-700"
                >
                   {isExporting ? '...' : <><IconDownload /> OBJ</>}
                </button>
                <button 
                  onClick={() => handleExport('stl')} 
                  disabled={isExporting}
                  className="flex items-center justify-center gap-1 py-2 bg-gray-800 hover:bg-gray-700 rounded text-xs font-bold border border-gray-700"
                >
                   {isExporting ? '...' : <><IconDownload /> STL</>}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Progress Indicator */}
        <div className="px-6 py-2 border-t border-gray-800">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-mono uppercase text-gray-400">System Status</span>
            <span className={`text-xs font-mono font-bold ${phase === AppPhase.ERROR ? 'text-red-500' : 'text-blue-400'}`}>
              {phase}
            </span>
          </div>
          {/* Mini Progress Bar */}
          {buildPlan && (
             <div className="w-full bg-gray-800 h-1 rounded-full overflow-hidden">
               <div 
                 className="h-full bg-blue-500 transition-all duration-500"
                 style={{ width: `${(Object.values(components).filter((c: ComponentArtifact) => c.status === 'VERIFIED').length / buildPlan.components.length) * 100}%` }}
               />
             </div>
          )}
        </div>

        {/* Logs Console */}
        <div className="flex-1 overflow-hidden flex flex-col border-t border-gray-800">
          <div className="p-2 bg-gray-900 text-xs font-mono text-gray-500">CONSOLE OUTPUT</div>
          <div className="flex-1 overflow-y-auto p-4 space-y-2 font-mono text-xs">
            {logs.map((log, i) => (
              <div key={i} className={`flex gap-2 ${
                log.type === 'error' ? 'text-red-400' : 
                log.type === 'success' ? 'text-green-400' : 
                log.type === 'warning' ? 'text-yellow-400' : 'text-gray-300'
              }`}>
                <span className="opacity-50">[{new Date(log.timestamp).toLocaleTimeString().split(' ')[0]}]</span>
                <span>{log.message}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Main Area */}
      <div className="flex-1 flex flex-col relative">
        {/* Visualizer */}
        <div className="flex-1 bg-black relative">
          <ThreeStage ref={threeStageRef} />
          
          {/* Overlay: Current Task */}
          {phase !== AppPhase.IDLE && phase !== AppPhase.COMPLETED && (
             <div className="absolute top-4 left-4 bg-black/70 backdrop-blur border border-gray-800 p-4 rounded text-sm max-w-md">
               <h3 className="text-white font-bold mb-1 flex items-center gap-2">
                 {phase === AppPhase.QC_ANALYSIS ? <IconEye /> : <IconBrain />}
                 {phase}
               </h3>
               <p className="text-gray-300">
                 {currentProcessingId ? `Processing: ${components[currentProcessingId]?.plan.name}` : (phase === AppPhase.ASSEMBLING ? 'Assembling Final Model...' : 'Planning scene structure...')}
               </p>
             </div>
          )}
        </div>

        {/* Component Plan View */}
        <div className="h-64 bg-neutral-900 border-t border-gray-800 flex overflow-x-auto p-4 gap-4">
          {!buildPlan && <div className="w-full flex items-center justify-center text-gray-600 text-sm">Waiting for Plan...</div>}
          {buildPlan && buildPlan.components.map((comp) => {
            const artifact = components[comp.id];
            const isProcessing = currentProcessingId === comp.id;
            const statusColor = 
              artifact?.status === 'VERIFIED' ? 'border-green-500/50 bg-green-900/10' :
              artifact?.status === 'FAILED' ? 'border-red-500/50 bg-red-900/10' :
              isProcessing ? 'border-blue-500 bg-blue-900/10 animate-pulse' : 'border-gray-700 bg-gray-800/30';

            return (
              <div key={comp.id} className={`min-w-[240px] p-4 rounded border ${statusColor} flex flex-col justify-between relative`}>
                <div>
                  <div className="flex justify-between items-start mb-2">
                    <h4 className="font-bold text-sm text-gray-200 truncate">{comp.name}</h4>
                    {artifact?.status === 'VERIFIED' && <span className="text-green-500"><IconCheck /></span>}
                    {artifact?.status === 'FAILED' && <span className="text-red-500"><IconAlert /></span>}
                  </div>
                  <p className="text-xs text-gray-500 line-clamp-2 mb-2">{comp.description}</p>
                  <div className="flex flex-wrap gap-1">
                     <span className="text-[10px] px-1.5 py-0.5 bg-gray-800 rounded text-gray-400">{comp.geometryType}</span>
                  </div>
                </div>
                
                <div className="mt-2 text-[10px] font-mono text-gray-500 flex justify-between">
                  <span>Try: {artifact?.retryCount || 0}</span>
                  <span>{artifact?.status}</span>
                </div>
                
                {/* Last QC Feedback Tooltip-ish */}
                {artifact?.qcHistory.length > 0 && (
                  <div className={`mt-2 text-[10px] p-1 rounded ${artifact.qcHistory[0].passed ? 'bg-green-900/20 text-green-400' : 'bg-red-900/20 text-red-400'}`}>
                    QC: {artifact.qcHistory[0].score}/100
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}