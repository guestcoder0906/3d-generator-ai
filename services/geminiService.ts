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
export const generateComponentCode = async (componentName: string, description: string, previousCode?: string, errorContext?: string): Promise<string> => {
  const systemInstruction = `
    You are an autonomous THREE.js Code Generator.
    Your task: Write a JavaScript function that creates a specific 3D component.
    
    Context:
    - The function MUST be named 'createPart'.
    - It receives 'THREE' as an argument.
    - It MUST return a THREE.Object3D (Mesh or Group).
    - DO NOT create scene, camera, renderer, or lights. These are pre-configured.
    - Use high-fidelity PBR materials (MeshStandardMaterial/MeshPhysicalMaterial).
    - Ensure geometry is centered at (0,0,0) locally unless specified.
    - Scaling should be roughly appropriate for a unit scale of 1 unit = 1 meter.
    - NO 'export', 'import' or 'require' statements. This code runs inside a Function constructor.
    - ONLY return the JavaScript code block.
  `;

  let prompt = `Create a component: "${componentName}". Description: ${description}.`;

  if (previousCode && errorContext) {
    prompt += `\n\nPREVIOUS ATTEMPT FAILED.\nError/Feedback: ${errorContext}\n\nPrevious Code:\n${previousCode}\n\nFIX THE CODE. Do not use export default.`;
  }

  const response = await ai.models.generateContent({
    model: MODEL_LOGIC,
    contents: prompt,
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
export const performVisualQC = async (componentName: string, images: string[]): Promise<QCResult> => {
  // images are base64 strings
  const parts = images.map(img => ({
    inlineData: {
      mimeType: "image/png",
      data: img.split(',')[1] // remove data:image/png;base64, prefix
    }
  }));

  const prompt = `
    You are a Visual Quality Control Agent for a 3D pipeline.
    Subject: "${componentName}"
    
    Analyze these 6 viewpoints (Front, Back, Top, Bottom, Left, Right).
    
    CRITICAL INSTRUCTIONS:
    1. IGNORE SHADOWS: The rendering environment uses directional lighting. Dark areas, black shadows, or gradients (especially on the Bottom or shaded sides) are EXPECTED and NORMAL. DO NOT flag them as errors.
    2. FOCUS ON GEOMETRY: Only fail the model if there are clear GEOMETRIC defects (e.g., fragmented mesh, exploded vertices, missing faces where you can see through the object, or totally unrecognizable shapes).
    3. IGNORE COLOR/LIGHTING: Do not judge the lighting quality.
    
    Check for:
    1. Structural integrity (Is it a solid, coherent object?)
    2. Visual artifacts (Severe Z-fighting, reversed normals causing transparency).
    3. Relevance (Does it look like a ${componentName}?)
    
    Return JSON.
  `;

  const schema: Schema = {
    type: Type.OBJECT,
    properties: {
      passed: { type: Type.BOOLEAN },
      feedback: { type: Type.STRING, description: "Specific instructions on what to fix if failed, or praise if passed." },
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

  if (!response.text) throw new Error("QC failed to respond");
  return JSON.parse(response.text) as QCResult;
};

/**
 * Phase 3: Assembly Code Generation
 */
export const generateAssemblyCode = async (plan: BuildPlan, previousCode?: string, errorContext?: string): Promise<string> => {
   const systemInstruction = `
    You are the Assembly Engineer.
    You have a set of existing functions named by their component IDs (e.g. 'chassis', 'wheels').
    
    Your task: Write a function 'assemble' that takes a 'components' dictionary as input.
    'components' is an object where keys are component IDs and values are THREE.Object3D instances.
    
    The function should:
    1. Create a root THREE.Group.
    2. Clone the components from the dictionary.
    3. Position, Rotate, and Scale them to form the final object based on the Plan Overview: "${plan.overview}".
    4. Add them to the root group.
    5. Return the root group.
    
    CONSTRAINTS:
    - NO 'export', 'import' or 'require'.
    - The function MUST be named 'assemble'.
    - Do not assume components have specific geometry properties (like .geometry.parameters), rely on bounding boxes if needed.
    - ONLY return the code block.
  `;

  const componentList = plan.components.map(c => `${c.id} (${c.name}): ${c.description}`).join('\n');
  let prompt = `Generate assembly logic for these components:\n${componentList}`;

  if (previousCode && errorContext) {
    prompt += `\n\nPREVIOUS ASSEMBLY ATTEMPT FAILED.\nError: ${errorContext}\n\nPrevious Code:\n${previousCode}\n\nFIX THE ASSEMBLY CODE. Ensure valid JavaScript.`;
  }

  const response = await ai.models.generateContent({
    model: MODEL_LOGIC,
    contents: prompt,
    config: {
      systemInstruction,
    }
  });

  const text = response.text || "";
  return cleanCode(text);
};