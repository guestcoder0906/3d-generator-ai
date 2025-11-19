import { GoogleGenAI, Type, Schema } from "@google/genai";
import { BuildPlan, QCResult } from "../types";

// Initialize Gemini Client
// Using gemini-3-pro-preview for complex logic and coding tasks
// Using gemini-2.5-flash for rapid visual analysis
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

const MODEL_LOGIC = "gemini-3-pro-preview";
const MODEL_VISION = "gemini-2.5-flash";

/**
 * Helper to clean AI code output
 * Removes markdown blocks, export statements, and imports
 */
const cleanCode = (text: string): string => {
  // Extract code from markdown if present
  const match = text.match(/```(?:javascript|js)?\s*([\s\S]*?)\s*```/);
  let code = match ? match[1] : text;

  // Remove export/import keywords which cause syntax errors in Function constructor
  code = code
    .replace(/export\s+default\s+function/g, 'function')
    .replace(/export\s+default\s+/g, '')
    .replace(/export\s+/g, '')
    .replace(/import\s+.*?from\s+.*?;/g, '')
    .replace(/import\s+.*?from\s+.*?/g, '');

  return code;
};

/**
 * Helper to format base64 images for Gemini API
 */
const formatImagesForPrompt = (b64Images: string[]) => {
  return b64Images.map(img => ({
    inlineData: {
      mimeType: "image/png",
      data: img.includes('base64,') ? img.split('base64,')[1] : img
    }
  }));
};

/**
 * Phase 1: Planning and Decomposition
 */
export const generateBuildPlan = async (userPrompt: string): Promise<BuildPlan> => {
  const systemInstruction = `
    You are a Senior 3D Graphics Architect. 
    Your goal is to decompose a user's request for a 3D object/scene into a structured build plan.
    The system uses THREE.js. You cannot import external models (GLTF/OBJ). 
    Everything must be built procedurally using THREE primitives, lathed geometries, extrusions, or math-based custom geometries.
    
    Break the object down into logical, distinct components (e.g., for a "Car": Chassis, Wheels, Body, Windows).
    Limit to max 5-7 major components to ensure stability.
  `;

  const schema: Schema = {
    type: Type.OBJECT,
    properties: {
      overview: { type: Type.STRING, description: "Brief strategy for the procedural generation" },
      components: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING },
            name: { type: Type.STRING },
            description: { type: Type.STRING, description: "Detailed visual description for the generator" },
            geometryType: { type: Type.STRING, description: "e.g., BoxGeometry, LatheGeometry, ParametricGeometry" },
            materialType: { type: Type.STRING, description: "e.g., MeshStandardMaterial, MeshPhysicalMaterial" },
            dependencies: { type: Type.ARRAY, items: { type: Type.STRING }, description: "IDs of components this attaches to" }
          },
          required: ["id", "name", "description", "geometryType", "materialType", "dependencies"]
        }
      }
    },
    required: ["overview", "components"]
  };

  const response = await ai.models.generateContent({
    model: MODEL_LOGIC,
    contents: userPrompt,
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema: schema,
      thinkingConfig: { thinkingBudget: 2048 } // Enable thinking for architectural planning
    }
  });

  if (!response.text) throw new Error("No plan generated");
  return JSON.parse(response.text) as BuildPlan;
};

/**
 * Phase 2: Component Code Generation
 */
export const generateComponentCode = async (
  componentName: string, 
  description: string, 
  previousCode?: string, 
  errorContext?: string,
  contextImages: string[] = []
): Promise<string> => {
  const systemInstruction = `
    You are an autonomous THREE.js Code Generator.
    Your task: Write a JavaScript function that creates a specific 3D component.
    
    Context:
    - The function MUST be named 'createPart'.
    - It receives 'THREE' as an argument.
    - It MUST return a THREE.Object3D (Mesh or Group).
    - DO NOT create scene, camera, renderer, or lights. These are pre-configured.
    - Use high-fidelity PBR materials (MeshStandardMaterial/MeshPhysicalMaterial).
    - Ensure geometry is centered at (0,0,0) locally.
    - Scaling should be roughly appropriate for a unit scale of 1 unit = 1 meter.
    - NO 'export', 'import' or 'require' statements. This code runs inside a Function constructor.
    - ONLY return the JavaScript code block.
  `;

  let prompt = `Create a component: "${componentName}". Description: ${description}.`;

  if (previousCode && errorContext) {
    prompt += `\n\nPREVIOUS ATTEMPT FAILED.\nError/Feedback: ${errorContext}\n\nPrevious Code:\n${previousCode}\n\nFIX THE CODE. Do not use export default.`;
  }

  const parts: any[] = [{ text: prompt }];

  if (contextImages.length > 0) {
    parts.push({ text: "\n\nVISUAL CONTEXT: Below are images of the parts generated so far for this model. Ensure the new part maintains stylistic consistency (scale, detail level, aesthetics) with these existing parts." });
    parts.push(...formatImagesForPrompt(contextImages));
  }

  const response = await ai.models.generateContent({
    model: MODEL_LOGIC,
    contents: { parts },
    config: {
      systemInstruction,
      temperature: 0.4, // Lower temperature for more stable code
    }
  });

  const text = response.text || "";
  return cleanCode(text);
};

/**
 * Phase 2b: Visual QC Analysis
 */
export const performVisualQC = async (
  componentName: string, 
  images: string[],
  contextImages: string[] = []
): Promise<QCResult> => {
  const parts = formatImagesForPrompt(images);

  let prompt = `
    You are a Visual Quality Control Agent for a 3D pipeline.
    Subject: "${componentName}"
    
    Analyze these 6 viewpoints (Front, Back, Top, Bottom, Left, Right).
    
    CRITICAL INSTRUCTIONS:
    1. IGNORE SHADOWS: The rendering environment uses directional lighting. Dark areas, black shadows, or gradients are EXPECTED.
    2. FOCUS ON GEOMETRY: Only fail the model if there are clear GEOMETRIC defects (e.g., fragmented mesh, exploded vertices, missing faces).
    3. IGNORE COLOR/LIGHTING: Do not judge the lighting quality.
    
    Check for:
    1. Structural integrity (Is it a solid, coherent object?)
    2. Visual artifacts (Severe Z-fighting, reversed normals).
    3. Relevance (Does it look like a ${componentName}?)
  `;

  if (contextImages.length > 0) {
    prompt += `\n\n4. CONSISTENCY: Compare with the 'CONTEXT IMAGES' provided. Does this part fit the style and scale of the rest of the model?`;
  }
    
  prompt += `\nReturn JSON.`;

  const schema: Schema = {
    type: Type.OBJECT,
    properties: {
      passed: { type: Type.BOOLEAN },
      feedback: { type: Type.STRING, description: "Specific instructions on what to fix if failed, or praise if passed." },
      score: { type: Type.INTEGER }
    },
    required: ["passed", "feedback", "score"]
  };

  const contentParts: any[] = [...parts, { text: prompt }];

  if (contextImages.length > 0) {
    contentParts.push({ text: "CONTEXT IMAGES (Previously verified parts):" });
    contentParts.push(...formatImagesForPrompt(contextImages));
  }

  const response = await ai.models.generateContent({
    model: MODEL_VISION,
    contents: {
      parts: contentParts
    },
    config: {
      responseMimeType: "application/json",
      responseSchema: schema
    }
  });

  if (!response.text) throw new Error("QC failed to respond");
  return JSON.parse(response.text) as QCResult;
};

/**
 * Phase 3a: Step-by-Step Attachment Code Generation
 * Replaces the old "Assembly Code" with an iterative attachment approach.
 */
export const generateAttachmentCode = async (
  overview: string,
  partName: string,
  partDescription: string,
  currentAssemblyImages: string[],
  previousCode?: string, 
  errorContext?: string
): Promise<string> => {
   const systemInstruction = `
    You are an expert 3D Assembly Engineer specializing in THREE.js.
    
    TASK: Write a JavaScript function 'attach(root, part)' to attach a NEW PART to an EXISTING ASSEMBLY.
    
    CONTEXT:
    - 'root' (THREE.Object3D): The main assembly so far.
    - 'part' (THREE.Object3D): The new component to be added (currently at 0,0,0).
    - The 'root' is already assembled. Do NOT move the root.
    - You must MOVE, ROTATE, and SCALE the 'part' to fit onto the 'root' correctly.
    
    INSTRUCTIONS:
    1. **Analyze Bounding Boxes**:
       - Use 'new THREE.Box3().setFromObject(root)' to find the dimensions of the assembly.
       - Use 'new THREE.Box3().setFromObject(part)' to find the dimensions of the new part.
       
    2. **Rescaling**:
       - Compare the dimensions. Rescale 'part' to a logical size relative to 'root'.
       - Example: If 'part' is a Door, it should fit within the height of the 'root' (House).
       - Apply 'part.scale.setScalar(ratio)'.

    3. **Positioning & Orientation**:
       - Move 'part' to the correct location on 'root' (e.g., wheels go to the bottom corners).
       - Rotate 'part' if needed (e.g., wheels need to face outward).
    
    4. **Duplication**:
       - If the part name implies multiple instances (e.g., "Wheels", "Headlights", "Propellers") but 'part' is a single object:
         - CLONE 'part' for each instance needed.
         - Position each clone correctly.
         - Add ALL clones to 'root'.
         - If it's a single item (e.g., "Turret"), just add 'part' to 'root'.
    
    5. **Final Step**:
       - Ensure 'part' (or its clones) is added to 'root' via 'root.add(part)'.
    
    RETURN:
    - Only the 'attach' function code.
    - No imports/exports.
  `;

  let prompt = `
    Assembly Plan: ${overview}
    Task: Attach "${partName}" (${partDescription}) to the current model.
    
    Write the 'attach' function.
  `;

  if (previousCode && errorContext) {
    prompt += `\n\nPREVIOUS ATTEMPT FAILED.\nFeedback: ${errorContext}\n\nPrevious Code:\n${previousCode}\n\nFIX THE CODE. \n- Adjust coordinates, scale, or rotation based on the visual feedback.`;
  }

  const parts: any[] = [
    { text: "CURRENT ASSEMBLY STATE (Visual Context):" },
    ...formatImagesForPrompt(currentAssemblyImages),
    { text: prompt }
  ];

  const response = await ai.models.generateContent({
    model: MODEL_LOGIC,
    contents: { parts },
    config: {
      systemInstruction,
      thinkingConfig: { thinkingBudget: 2048 },
      temperature: 0.2 
    }
  });

  const text = response.text || "";
  return cleanCode(text);
};

/**
 * Phase 3b: Assembly Visual QC (Targeted)
 */
export const performAssemblyQC = async (
  planOverview: string, 
  currentPartName: string,
  images: string[]
): Promise<QCResult> => {
  const parts = formatImagesForPrompt(images);

  const prompt = `
    You are a Visual QA Agent for a 3D Scene Assembler.
    The scene represents: "${planOverview}".
    
    ACTION PERFORMED: Added component "${currentPartName}".
    
    Analyze the 6 viewpoints provided.
    
    Task: Verify that "${currentPartName}" is correctly attached to the model.
    
    Pass criteria:
    1. "${currentPartName}" is physically connected to the main body (not floating miles away).
    2. "${currentPartName}" is scaled appropriately (not microscopic, not 100x too big).
    3. "${currentPartName}" is oriented correctly (e.g. wheels touch ground, turret on top).
    
    Fail criteria:
    1. The new part is floating in void.
    2. The new part is clipping completely inside another part (invisible).
    3. The new part is drastically incorrectly scaled.
    
    Return JSON.
  `;
  
  const schema: Schema = {
    type: Type.OBJECT,
    properties: {
      passed: { type: Type.BOOLEAN },
      feedback: { type: Type.STRING, description: "Specific feedback on how to fix the specific part (e.g. 'Move wheel down 2 units', 'Scale turret up 2x')." },
      score: { type: Type.INTEGER }
    },
    required: ["passed", "feedback", "score"]
  };

  const response = await ai.models.generateContent({
    model: MODEL_VISION,
    contents: {
      parts: [...parts, { text: prompt }]
    },
    config: {
      responseMimeType: "application/json",
      responseSchema: schema
    }
  });

  if (!response.text) throw new Error("Assembly QC failed to respond");
  return JSON.parse(response.text) as QCResult;
};