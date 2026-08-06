// State Management
const STATE = {
    pyodide: null,
    editor: null,
    currentScript: null,
    selectedFeature: null, // { id, center: [x,y,z], normal: [x,y,z], type }
    is2DMode: false,
    importedAsset: null, // { name, path, kind }
    lastError: null, // last compilation error message for AI-recovery context
    scriptHistory: [], // snapshots of prior scripts (for Undo)
    aiConfig: {
        provider: 'local',
        apiKey: '',
        apiUrl: 'http://localhost:11434/v1',
        model: 'qwen2.5-coder'
    },
    messages: [],
    three: {
        scene: null,
        camera: null,
        renderer: null,
        controls: null,
        grid: null,
        facesGroup: null,
        edgesGroup: null,
        highlightObject: null,
        raycastObjects: [] // Meshes of faces to intersect
    }
};

const OCP_WASM_INDEX = 'https://yeicor.github.io/OCP.wasm';

const AI_PROVIDER_DEFAULTS = {
    local: {
        apiUrl: 'http://localhost:11434/v1',
        model: 'qwen2.5-coder'
    },
    openai: {
        apiUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o'
    },
    openrouter: {
        apiUrl: 'https://openrouter.ai/api/v1',
        model: 'openai/gpt-4o-mini'
    },
    anthropic: {
        apiUrl: 'https://api.anthropic.com/v1',
        model: 'claude-3-5-sonnet-latest'
    },
    gemini: {
        apiUrl: '',
        model: 'gemini-flash-latest'
    },
    custom: {
        apiUrl: '',
        model: ''
    }
};

function getProviderDefaults(provider) {
    return AI_PROVIDER_DEFAULTS[provider] || AI_PROVIDER_DEFAULTS.local;
}

function getNormalizedProvider(provider) {
    return AI_PROVIDER_DEFAULTS[provider] ? provider : 'local';
}

function shouldResetEndpoint(provider, apiUrl) {
    const endpoint = (apiUrl || '').trim();
    if (!endpoint || provider === 'gemini') return true;

    // Guard against stale app/server URLs from previous settings. This caused
    // OpenRouter/Gemini requests to be accidentally sent to localhost:8000.
    if (/^https?:\/\/(localhost|127\.0\.0\.1):8000\b/i.test(endpoint)) {
        return true;
    }

    if (provider === 'openrouter' && !/openrouter\.ai/i.test(endpoint)) {
        return true;
    }

    return false;
}

function normalizeAIConfig(rawConfig = {}, options = {}) {
    const provider = getNormalizedProvider(rawConfig.provider);
    const defaults = getProviderDefaults(provider);
    const resetEndpoint = Boolean(options.resetEndpoint) || shouldResetEndpoint(provider, rawConfig.apiUrl);
    const resetModel = Boolean(options.resetModel);

    return {
        provider,
        apiKey: rawConfig.apiKey || '',
        apiUrl: resetEndpoint ? defaults.apiUrl : (rawConfig.apiUrl || defaults.apiUrl),
        model: resetModel || !rawConfig.model ? defaults.model : rawConfig.model
    };
}

// Default scripts to start with
// Starter templates are intentionally comment-only: the app opens with an empty
// viewport, so nothing is modelled until the user actually asks for something.
const DEFAULT_SCRIPTS = {
    '3d': `# 3D mode — describe a part in the chat, or write build123d code here.
# Assign the finished solid to a variable named 'part'.
#
# from build123d import *
#
# with BuildPart() as bp:
#     Box(100, 50, 10)
#     with BuildSketch(bp.faces().sort_by(Axis.Z)[-1]) as sk:
#         Circle(10)
#     extrude(amount=-10, mode=Mode.SUBTRACT)
#
# part = bp.part
`,
    '2d': `# 2D mode — describe a profile in the chat, or write build123d code here.
# Assign the finished sketch to a variable named 'sketch'.
#
# from build123d import *
#
# with BuildSketch() as sk:
#     RectangleRounded(80, 40, 5)
#     Circle(6, mode=Mode.SUBTRACT)
#
# sketch = sk.sketch
`
};

// True when a script contains nothing but blank lines and comments. Running one
// of these should quietly leave an empty viewport rather than raising
// "variable 'part' was not found".
function isEffectivelyEmptyScript(script) {
    return !(script || '')
        .split('\n')
        .some(line => {
            const trimmed = line.trim();
            return trimmed !== '' && !trimmed.startsWith('#');
        });
}

// How many times the assistant may automatically re-send a compilation error
// back to the model before giving up and showing it to the user.
const MAX_AUTO_REPAIR_ATTEMPTS = 2;

const TEXT_TO_CAD_SKILL_APPENDIX = `
TEXT-TO-CAD SKILL INTEGRATION (earthtojake/text-to-cad):
- Treat STEP as the primary 3D CAD artifact. STL/3MF/GLB are secondary and are not requested in this browser runtime.
- Prefer parametric build123d source with named dimensions at the top of the script. Use readable names such as length, width, thickness, hole_diameter, wall_thickness, fillet_radius, etc.
- Use millimeters. Default base plane is XY and default up/extrusion axis is +Z.
- For new 3D parts, generate closed positive-volume solids. Avoid decorative or extra geometry unless requested.
- Preserve design intent in source comments and labels where practical, but keep code runnable in Pyodide.
- Keep geometry centered on the origin unless the user gives a placement convention. If a benchmark/spec says bottom at Z = 0, honor it exactly.
- Use normal clearance defaults when unspecified: M3 = 3.4 mm, M4 = 4.5 mm, M5 = 5.5 mm.
- Use conservative cosmetic fillets/chamfers only when local geometry can support them; if a fillet/chamfer is risky, prefer a smaller radius and note it briefly before the code.
- For assemblies, build explicit part placements and combine them into one final 'part' value. The browser runtime may not have cadpy AssemblyHelper, so do not import cadpy unless the current script already does.
- Do not ask for clarification unless the missing information makes the model impossible, fit-critical, safety-critical, or compliance-bound. Otherwise proceed with explicit assumptions.
`;

const TEXT_TO_CAD_BENCHMARKS = [
    {
        label: '01 校準方塊',
        prompt: 'Create a single solid STEP model in millimeters. The part is a rectangular block, 100 mm long in X, 60 mm wide in Y, and 20 mm tall in Z. Center the block on the XY origin, with the bottom face at Z = 0. Add four vertical through-holes, each 8 mm in diameter, located at X = +/-35 mm and Y = +/-20 mm. Add a 2 mm chamfer to the top perimeter edges only. Do not chamfer the holes. Export as a STEP file.'
    },
    {
        label: '02 圓形法蘭',
        prompt: 'Create a single solid circular flange as a STEP model in millimeters. The flange is a cylinder with an outside diameter of 80 mm and a thickness of 10 mm. Its axis is vertical along Z, with the bottom face at Z = 0 and the center at X = 0, Y = 0. Add a central vertical through-bore with diameter 30 mm. Add six equally spaced vertical through-holes, each 6 mm in diameter, on a 60 mm bolt-circle diameter. Add a 1.5 mm fillet to the top and bottom outside circular edges. Export as a STEP file.'
    },
    {
        label: '03 L 型支架',
        prompt: 'Create a single solid L-bracket STEP model in millimeters. The bracket has a horizontal base plate 80 mm long in X, 50 mm wide in Y, and 8 mm thick in Z. Center the base plate on the XY origin, with its bottom at Z = 0. Add a vertical back plate along the rear long edge of the base. The back plate is 80 mm long in X, 8 mm thick in Y, and 50 mm tall in Z, rising from the top of the base plate. The back plate should sit along the rear edge at positive Y. Add two vertical through-holes in the base plate, each 6 mm in diameter, located at X = +/-25 mm and Y = -10 mm. Add two horizontal through-holes in the vertical plate, each 6 mm in diameter, located at X = +/-25 mm and Z = 30 mm, passing through the 8 mm thickness of the vertical plate. Add two triangular gussets, each 8 mm thick in X, located at X = +/-20 mm. Each gusset should connect the base plate to the back plate with a right-triangle side profile 30 mm tall and 30 mm deep. Add 2 mm fillets to the outside corner where the base and back plate meet. Export as a STEP file.'
    },
    {
        label: '04 階梯軸與鍵槽',
        prompt: 'Create a single solid stepped shaft STEP model in millimeters. The shaft axis runs along X. The total length is 120 mm. The left end center is at X = 0, Y = 0, Z = 0. From X = 0 to X = 30, the shaft diameter is 20 mm. From X = 30 to X = 90, the shaft diameter is 30 mm. From X = 90 to X = 120, the shaft diameter is 20 mm. Add a 1 mm chamfer to both end edges. Add a rectangular keyway slot on the top of the 30 mm diameter middle section. The keyway is 6 mm wide in Y, 3 mm deep in Z, and runs from X = 40 to X = 80. Export as a STEP file.'
    },
    {
        label: '05 開口電子外殼',
        prompt: 'Create a single solid open-top electronics enclosure base as a STEP model in millimeters. The outer shape is a rectangular box 100 mm long in X, 70 mm wide in Y, and 30 mm tall in Z. Center it on the XY origin, with the bottom face at Z = 0. The enclosure is open at the top. The wall thickness is 3 mm and the bottom floor thickness is 3 mm. Add four internal cylindrical standoffs rising from the inside floor. Each standoff has an outside diameter of 10 mm and a height of 12 mm above the inside floor. Place the standoffs at X = +/-35 mm and Y = +/-25 mm. Add a centered blind hole in each standoff, 3 mm in diameter and 8 mm deep from the top of the standoff. Add 2 mm radius fillets to the four outside vertical corners of the enclosure. Export as a STEP file.'
    },
    {
        label: '06 叉形輕量化支架',
        prompt: 'Create a single solid aerospace-style clevis bracket as a STEP model in millimeters. The part is symmetric about the XZ plane. Start with a base plate 120 mm long in X, 60 mm wide in Y, and 10 mm thick in Z, centered on the XY origin, with bottom face at Z = 0. Add two vertical clevis lugs rising from the top of the base near the center. Each lug is 18 mm thick in Y, 42 mm tall above the base, and extends 36 mm along X. The two lugs are separated by a 16 mm central gap in Y. The top of each lug has a semicircular rounded profile with radius 18 mm when viewed from the side. Add a horizontal through-hole of diameter 14 mm through both lugs along the Y direction, centered at X = 0 and Z = 34 mm. Add four base mounting holes, diameter 7 mm, through the base plate, located at X = +/-45 mm and Y = +/-20 mm. Add two triangular lightening cutouts through the base web, one on each side, each with rounded corners of radius 3 mm. Add two diagonal reinforcing ribs from the base to the outer faces of the lugs, one on each side, thickness 6 mm. Add 3 mm fillets to the base perimeter and 2 mm fillets at lug-to-base transitions. Export as a STEP file.'
    }
];

// Initialize Application
window.addEventListener('DOMContentLoaded', async () => {
    STATE.currentScript = DEFAULT_SCRIPTS['3d'];
    loadSettings();
    initUI();
    initThree();
    await initPyodide();
    initMonaco();
});

// Load Settings from LocalStorage
function loadSettings() {
    const saved = localStorage.getItem('cad_ai_config');
    if (saved) {
        try {
            STATE.aiConfig = normalizeAIConfig(JSON.parse(saved));
        } catch (e) {
            console.error("Failed to parse AI configuration", e);
        }
    }
    STATE.aiConfig = normalizeAIConfig(STATE.aiConfig);
    
    // Set UI values
    document.getElementById('provider-select').value = STATE.aiConfig.provider;
    document.getElementById('api-key-input').value = STATE.aiConfig.apiKey || '';
    document.getElementById('api-url-input').value = STATE.aiConfig.apiUrl || '';
    document.getElementById('model-name-input').value = STATE.aiConfig.model || '';
    
    updateAPIUIForm();
    updateStatusIndicators();
}

// Save Settings to LocalStorage
function saveSettings() {
    STATE.aiConfig = normalizeAIConfig({
        provider: document.getElementById('provider-select').value,
        apiKey: document.getElementById('api-key-input').value,
        apiUrl: document.getElementById('api-url-input').value,
        model: document.getElementById('model-name-input').value
    });
    
    localStorage.setItem('cad_ai_config', JSON.stringify(STATE.aiConfig));
    updateAPIUIForm();
    updateStatusIndicators();
    appendConsoleLog("AI settings saved successfully.\n");
}

function updateAPIUIForm(options = {}) {
    const provider = document.getElementById('provider-select').value;
    const apiKeyGroup = document.getElementById('api-key-group');
    const apiUrlGroup = document.getElementById('api-url-group');
    const apiUrlInput = document.getElementById('api-url-input');
    const modelInput = document.getElementById('model-name-input');
    const defaults = getProviderDefaults(provider);

    if (options.resetEndpoint || shouldResetEndpoint(provider, apiUrlInput.value)) {
        apiUrlInput.value = defaults.apiUrl;
    }

    if (options.resetModel || !modelInput.value) {
        modelInput.value = defaults.model;
    }
    
    if (provider === 'local') {
        apiKeyGroup.style.display = 'none';
        apiUrlGroup.style.display = 'flex';
    } else {
        apiKeyGroup.style.display = 'flex';
        apiUrlGroup.style.display = 'flex';
        if (provider === 'gemini') {
            apiUrlGroup.style.display = 'none'; // Google SDK endpoint is static
        }
    }
}

function updateStatusIndicators() {
    const pyodideDot = document.querySelector('#status-pyodide .status-dot');
    const aiDot = document.querySelector('#status-ai .status-dot');
    const cadSkillsDot = document.querySelector('#status-cad-skills .status-dot');
    
    if (STATE.pyodide) {
        pyodideDot.className = 'status-dot green';
    } else {
        pyodideDot.className = 'status-dot red';
    }
    
    if (STATE.aiConfig.provider === 'local' || STATE.aiConfig.apiKey) {
        aiDot.className = 'status-dot green';
    } else {
        aiDot.className = 'status-dot red';
    }

    if (cadSkillsDot) {
        cadSkillsDot.className = 'status-dot green';
    }
}

// Log message helper
function appendConsoleLog(message) {
    const logs = document.getElementById('console-logs');
    logs.textContent += message;
    logs.scrollTop = logs.scrollHeight;
}

// Init UI Event Listeners
function initUI() {
    initBenchmarkPicker();

    // Settings modal triggers
    document.getElementById('open-settings-btn').addEventListener('click', () => {
        document.getElementById('settings-modal').classList.remove('hidden');
    });
    
    document.getElementById('close-settings-btn').addEventListener('click', () => {
        document.getElementById('settings-modal').classList.add('hidden');
    });
    
    document.getElementById('cancel-settings-btn').addEventListener('click', () => {
        document.getElementById('settings-modal').classList.add('hidden');
        loadSettings(); // reset UI values
    });
    
    document.getElementById('save-settings-btn').addEventListener('click', () => {
        saveSettings();
        document.getElementById('settings-modal').classList.add('hidden');
    });
    
    document.getElementById('provider-select').addEventListener('change', () => {
        updateAPIUIForm({ resetEndpoint: true, resetModel: true });
    });
    
    // Tab controls
    const tabButtons = document.querySelectorAll('.tab-btn');
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            tabButtons.forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            
            btn.classList.add('active');
            const tabId = btn.getAttribute('data-tab');
            document.getElementById(tabId).classList.add('active');
        });
    });
    
    // 2D/3D Mode switches
    document.getElementById('mode-3d-btn').addEventListener('click', () => {
        setMode('3d');
    });
    
    document.getElementById('mode-2d-btn').addEventListener('click', () => {
        setMode('2d');
    });
    
    // Import buttons
    document.getElementById('import-step-btn').addEventListener('click', () => {
        triggerImportPicker('step');
    });
    document.getElementById('import-dxf-btn').addEventListener('click', () => {
        triggerImportPicker('dxf');
    });
    document.getElementById('import-step-input').addEventListener('change', handleCadImportSelection);
    document.getElementById('import-dxf-input').addEventListener('change', handleCadImportSelection);

    // Export buttons
    document.getElementById('export-step-btn').addEventListener('click', exportStepFile);
    document.getElementById('export-dxf-btn').addEventListener('click', exportDxfFile);
    
    // View actions
    document.getElementById('view-reset-btn').addEventListener('click', () => {
        resetCamera();
    });
    
    document.getElementById('view-grid-btn').addEventListener('click', () => {
        STATE.three.grid.visible = !STATE.three.grid.visible;
        appendConsoleLog(`Grid visibility toggled: ${STATE.three.grid.visible}\n`);
    });
    
    // Send Prompt
    document.getElementById('send-prompt-btn').addEventListener('click', handlePromptSubmit);
    document.getElementById('prompt-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handlePromptSubmit();
        }
    });
    
    // Suggestions
    document.querySelectorAll('.suggest-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('prompt-input').value = btn.getAttribute('data-prompt');
        });
    });
    
    // Clear selection
    document.getElementById('clear-feature-btn').addEventListener('click', clearFeatureSelection);
    
    // Clear chat
    document.getElementById('clear-chat-btn').addEventListener('click', () => {
        const console = document.getElementById('chat-console');
        console.innerHTML = `
            <div class="chat-message system">
                <div class="message-content">
                    Chat cleared. Describe your design changes or start fresh.
                </div>
            </div>
        `;
        STATE.messages = [];
    });
    
    // Run Code manually
    document.getElementById('run-code-btn').addEventListener('click', () => {
        if (!STATE.pyodide) {
            alert("Pyodide is not loaded yet.");
            return;
        }
        const currentScript = STATE.editor ? STATE.editor.getValue() : STATE.currentScript;
        // If the script in the editor differs from STATE.currentScript, snapshot the old one.
        if (STATE.currentScript && currentScript !== STATE.currentScript) {
            STATE.scriptHistory.push({
                script: STATE.currentScript,
                reason: 'manual run',
                timestamp: Date.now()
            });
            if (STATE.scriptHistory.length > MAX_SCRIPT_HISTORY) STATE.scriptHistory.shift();
            updateUndoButtonState();
        }
        STATE.currentScript = currentScript;
        runPythonCode(currentScript, { skipSnapshot: true });
    });

    // Undo button
    const undoBtn = document.getElementById('undo-btn');
    if (undoBtn) {
        undoBtn.addEventListener('click', undoLastChange);
    }

    // CAD Toolbar
    initToolbar();
}

function initBenchmarkPicker() {
    const select = document.getElementById('benchmark-select');
    if (!select) return;

    TEXT_TO_CAD_BENCHMARKS.forEach((benchmark, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = benchmark.label;
        select.appendChild(option);
    });

    select.addEventListener('change', () => {
        if (!select.value) return;

        const benchmark = TEXT_TO_CAD_BENCHMARKS[Number(select.value)];
        if (!benchmark) return;

        setMode('3d', { resetEditor: false });
        document.getElementById('prompt-input').value = benchmark.prompt;
        appendConsoleLog(`Loaded text-to-cad benchmark: ${benchmark.label}\n`);
        select.value = '';
    });
}

function setMode(mode, options = {}) {
    const { resetEditor = true } = options;
    const nextIs2D = mode === '2d';
    const modeChanged = STATE.is2DMode !== nextIs2D;

    STATE.is2DMode = nextIs2D;
    document.getElementById('mode-2d-btn').classList.toggle('active', nextIs2D);
    document.getElementById('mode-3d-btn').classList.toggle('active', !nextIs2D);
    updateViewportTheme();

    if (resetEditor && modeChanged) {
        STATE.importedAsset = null;
        syncEditorScript(DEFAULT_SCRIPTS[mode]);
    }
}

function triggerImportPicker(kind) {
    if (!STATE.pyodide) {
        alert("Pyodide is not loaded yet.");
        return;
    }

    const inputId = kind === 'dxf' ? 'import-dxf-input' : 'import-step-input';
    const input = document.getElementById(inputId);
    input.value = '';
    input.click();
}

async function handleCadImportSelection(event) {
    const input = event.target;
    const file = input.files && input.files[0];
    if (!file) {
        return;
    }

    const kind = input.id.includes('dxf') ? 'dxf' : 'step';
    try {
        await importCadAsset(file, kind);
    } catch (error) {
        console.error(error);
        appendConsoleLog(`Import Error: ${error.message}\n`);
        displayMessage('ai', `Import failed: ${error.message}`, true);
    } finally {
        input.value = '';
    }
}

async function importCadAsset(file, kind) {
    const importMode = kind === 'dxf' ? '2d' : '3d';
    setMode(importMode, { resetEditor: false });

    const fileBytes = new Uint8Array(await file.arrayBuffer());
    const virtualDir = '/cad_imports';
    const safeName = `${Date.now()}_${sanitizeFilenameForFs(file.name)}`;
    const virtualPath = `${virtualDir}/${safeName}`;

    ensurePyodideDir(virtualDir);
    STATE.pyodide.FS.writeFile(virtualPath, fileBytes);

    // New import = new starting point. Snapshot the prior script so the user can undo back to it.
    snapshotCurrentScript('before import');

    STATE.importedAsset = {
        name: file.name,
        path: virtualPath,
        kind
    };

    const importScript = buildImportScript(STATE.importedAsset);
    syncEditorScript(importScript);

    appendConsoleLog(`Imported ${kind.toUpperCase()} source: ${file.name}\n`);
    displayMessage('system', `Imported \`${file.name}\` and prepared it in the editor.`);
    await runPythonCode(importScript);
}

function ensurePyodideDir(path) {
    if (!STATE.pyodide.FS.analyzePath(path).exists) {
        STATE.pyodide.FS.mkdirTree(path);
    }
}

function sanitizeFilenameForFs(filename) {
    return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function buildImportScript(importedAsset) {
    const cleanName = importedAsset.name.replace(/\r?\n/g, ' ');
    if (importedAsset.kind === 'dxf') {
        return `# Imported from browser: ${cleanName}
from build123d import *
from build123d.import_dxf import _process_entity
import ezdxf

doc = ezdxf.readfile("${importedAsset.path}")
imported_shapes = []
skipped_entities = []

for entity in doc.modelspace():
    try:
        imported_shapes.extend(_process_entity(entity, doc))
    except Exception as exc:
        skipped_entities.append(f"{entity.dxftype()}: {exc}")

if skipped_entities:
    print("DXF import warnings:")
    for warning in skipped_entities[:20]:
        print(f" - {warning}")
    if len(skipped_entities) > 20:
        print(f" - ... and {len(skipped_entities) - 20} more skipped entities")

sketch = Sketch(imported_shapes)
`;
    }

    return `# Imported from browser: ${cleanName}
from build123d import *

part = import_step("${importedAsset.path}")
`;
}

function syncEditorScript(script) {
    STATE.currentScript = script;
    if (STATE.editor) {
        STATE.editor.setValue(script);
    }
}

const MAX_SCRIPT_HISTORY = 25;

function snapshotCurrentScript(reason) {
    const current = (STATE.editor ? STATE.editor.getValue() : STATE.currentScript) || '';
    const trimmed = current.trim();
    if (!trimmed) return;

    const last = STATE.scriptHistory[STATE.scriptHistory.length - 1];
    if (last && last.script === current) return; // dedupe consecutive identical snapshots

    STATE.scriptHistory.push({
        script: current,
        reason: reason || 'edit',
        timestamp: Date.now()
    });

    if (STATE.scriptHistory.length > MAX_SCRIPT_HISTORY) {
        STATE.scriptHistory.shift();
    }

    updateUndoButtonState();
}

function updateUndoButtonState() {
    const btn = document.getElementById('undo-btn');
    if (!btn) return;
    btn.disabled = STATE.scriptHistory.length === 0;
    btn.title = STATE.scriptHistory.length === 0
        ? 'Nothing to undo'
        : `Undo last change (${STATE.scriptHistory.length} step${STATE.scriptHistory.length === 1 ? '' : 's'} available)`;
}

async function undoLastChange() {
    if (STATE.scriptHistory.length === 0) {
        appendConsoleLog('Nothing to undo.\n');
        return;
    }
    const previous = STATE.scriptHistory.pop();
    updateUndoButtonState();

    appendConsoleLog(`Undo: restoring previous script (was: ${previous.reason}).\n`);
    syncEditorScript(previous.script);
    displayMessage('system', `Reverted to previous script (${previous.reason}).`);

    if (STATE.pyodide) {
        await runPythonCode(previous.script, { skipSnapshot: true });
    }
}

// Initialize Three.js Viewport
function initThree() {
    const container = document.getElementById('canvas-container');
    const width = container.clientWidth;
    const height = container.clientHeight;
    
    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c0e14);
    
    // Camera
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(100, 100, 150);
    
    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);
    
    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);
    
    const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.6);
    dirLight1.position.set(100, 200, 100);
    scene.add(dirLight1);
    
    const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.3);
    dirLight2.position.set(-100, -100, 200);
    scene.add(dirLight2);
    
    // Controls
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    
    // Grid Helper
    const grid = new THREE.GridHelper(200, 50, 0x4fc3f7, 0x2b303b);
    grid.position.y = -0.1;
    scene.add(grid);
    
    // Groups for geometries
    const facesGroup = new THREE.Group();
    const edgesGroup = new THREE.Group();
    scene.add(facesGroup);
    scene.add(edgesGroup);
    
    // State assignments
    STATE.three = {
        scene,
        camera,
        renderer,
        controls,
        grid,
        facesGroup,
        edgesGroup,
        highlightObject: null,
        raycastObjects: []
    };
    updateViewportTheme();
    
    // Window Resize
    window.addEventListener('resize', () => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    });
    
    // Raycasting event listener for clicking shapes
    renderer.domElement.addEventListener('pointerdown', onCanvasClick);
    
    // Start Render Loop
    function animate() {
        requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
    }
    animate();
}

function updateViewportTheme() {
    const container = document.getElementById('canvas-container');
    if (!container || !STATE.three.scene || !STATE.three.grid) return;

    const is2D = STATE.is2DMode;
    container.classList.toggle('mode-2d', is2D);
    STATE.three.scene.background = new THREE.Color(0xfafaf7);

    const gridColors = { center: 0x9aa3ad, grid: 0xd7dde4 };

    STATE.three.scene.remove(STATE.three.grid);
    STATE.three.grid = new THREE.GridHelper(200, 50, gridColors.center, gridColors.grid);
    STATE.three.grid.position.y = -0.1;
    STATE.three.scene.add(STATE.three.grid);
}

// Raycaster Click Handler
function onCanvasClick(event) {
    if (!STATE.three.renderer) {
        return;
    }

    // Only raycast on left click without panning (detect short click)
    const startX = event.clientX;
    const startY = event.clientY;
    const canvas = STATE.three.renderer.domElement;
    
    const onPointerUp = (upEvent) => {
        const dist = Math.sqrt(Math.pow(upEvent.clientX - startX, 2) + Math.pow(upEvent.clientY - startY, 2));
        if (dist > 3) return; // user was dragging/panning
        
        // Calculate mouse position in normalized device coordinates
        const rect = STATE.three.renderer.domElement.getBoundingClientRect();
        const x = ((upEvent.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((upEvent.clientY - rect.top) / rect.height) * 2 + 1;
        
        const raycaster = new THREE.Raycaster();
        raycaster.params.Line.threshold = 2;
        raycaster.setFromCamera(new THREE.Vector2(x, y), STATE.three.camera);

        const intersects = raycaster.intersectObjects(STATE.three.raycastObjects);
        if (intersects.length > 0) {
            // Prefer edges (Line objects) over faces (Mesh) — otherwise the front face
            // always occludes back-side edges. If the click ray comes within the Line
            // threshold of any edge, pick the closest such edge; only fall back to a
            // face when no edge is in range.
            const edgeHit = intersects.find(h => h.object instanceof THREE.Line);
            const hit = edgeHit || intersects[0];
            const object = hit.object;
            const data = object.userData;
            
            // Highlight the clicked feature
            highlightFeature(object);
            
            // Update selection state
            STATE.selectedFeature = {
                id: data.id,
                center: data.center,
                normal: data.normal,
                type: data.type,
                bbox: data.bbox || null,
                area: (typeof data.area === 'number') ? data.area : null
            };
            
            // Show selection UI
            const featuresBox = document.getElementById('selected-features-box');
            featuresBox.classList.remove('hidden');
            document.getElementById('feature-id-label').textContent = data.id;
            document.getElementById('feature-coord-label').textContent = 
                `(${data.center[0].toFixed(2)}, ${data.center[1].toFixed(2)}, ${data.center[2].toFixed(2)})`;
            
            appendConsoleLog(
                `Selected ${data.type}: ${data.id} at center [${data.center.map(c => c.toFixed(2)).join(', ')}]\n`
            );
        }
    };
    
    canvas.addEventListener('pointerup', onPointerUp, { once: true });
}

// Highlight selected feature
function highlightFeature(object) {
    // Clear previous highlight
    if (STATE.three.highlightObject) {
        STATE.three.highlightObject.material.color.setHex(STATE.three.highlightObject.userData.baseColor);
        STATE.three.highlightObject = null;
    }
    
    // Highlight clicked one
    object.material.color.setHex(0xffb300); // Amber warning color
    STATE.three.highlightObject = object;
}

// Clear Selection
function clearFeatureSelection() {
    if (STATE.three.highlightObject) {
        STATE.three.highlightObject.material.color.setHex(STATE.three.highlightObject.userData.baseColor);
        STATE.three.highlightObject = null;
    }
    STATE.selectedFeature = null;
    document.getElementById('selected-features-box').classList.add('hidden');
    appendConsoleLog("Feature selection cleared.\n");
}

function extractGeminiResponseText(data) {
    if (!data || !Array.isArray(data.candidates) || data.candidates.length === 0) {
        return null;
    }

    const firstCandidate = data.candidates[0];
    const parts = firstCandidate?.content?.parts;
    if (!Array.isArray(parts)) {
        return null;
    }

    return parts
        .map(part => {
            if (typeof part.text === 'string') return part.text;
            if (part.executableCode?.code) return `\`\`\`python\n${part.executableCode.code}\n\`\`\``;
            if (part.codeExecutionResult?.output) return part.codeExecutionResult.output;
            return '';
        })
        .filter(Boolean)
        .join('\n');
}

// Reset Camera Focus
function resetCamera() {
    if (!STATE.three.camera || !STATE.three.controls) return;
    
    // Fit camera to objects
    const box = new THREE.Box3();
    STATE.three.facesGroup.traverse(child => {
        if (child instanceof THREE.Mesh) {
            box.expandByObject(child);
        }
    });
    
    if (box.isEmpty()) {
        STATE.three.camera.position.set(100, 100, 150);
        STATE.three.controls.target.set(0, 0, 0);
    } else {
        const center = new THREE.Vector3();
        box.getCenter(center);
        const size = new THREE.Vector3();
        box.getSize(size);
        
        const maxDim = Math.max(size.x, size.y, size.z);
        const fov = STATE.three.camera.fov * (Math.PI / 180);
        let cameraDist = Math.abs(maxDim / 2 / Math.tan(fov / 2));
        cameraDist *= 1.5; // add buffer
        
        STATE.three.camera.position.set(center.x + cameraDist, center.y + cameraDist, center.z + cameraDist);
        STATE.three.controls.target.copy(center);
    }
    STATE.three.controls.update();
    appendConsoleLog("Camera view reset to fit bounds.\n");
}

// Initialize Monaco Editor
function initMonaco() {
    const monacoBase = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.39.0/min';
    window.MonacoEnvironment = {
        getWorkerUrl: function () {
            const workerSource = `
self.MonacoEnvironment = { baseUrl: '${monacoBase}/' };
importScripts('${monacoBase}/vs/base/worker/workerMain.js');
            `.trim();
            return `data:text/javascript;charset=utf-8,${encodeURIComponent(workerSource)}`;
        }
    };
    require.config({
        paths: {
            vs: `${monacoBase}/vs`
        }
    });

    require(['vs/editor/editor.main'], function () {
        STATE.editor = monaco.editor.create(document.getElementById('code-editor'), {
            value: STATE.currentScript || DEFAULT_SCRIPTS[STATE.is2DMode ? '2d' : '3d'],
            language: 'python',
            theme: 'vs-dark',
            automaticLayout: true,
            fontSize: 14,
            fontFamily: "'Fira Code', Consolas, monospace",
            minimap: { enabled: false }
        });
        
        appendConsoleLog("Monaco Editor loaded.\n");
    });
}

// Initialize Pyodide
async function initPyodide() {
    const updateLoader = (title, subtitle, progress) => {
        document.getElementById('loader-title').textContent = title;
        document.getElementById('loader-subtitle').textContent = subtitle;
        document.getElementById('loader-progress').style.width = `${progress}%`;
    };
    
    try {
        updateLoader("Loading Python WASM Runtime", "Downloading Pyodide core libraries...", 20);
        
        // Load Pyodide
        const pyodide = await loadPyodide({
            indexURL: "https://cdn.jsdelivr.net/pyodide/v0.29.4/full/"
        });
        
        // Redirect stdout/stderr to appendConsoleLog
        pyodide.setStdout({
            batched: (text) => {
                appendConsoleLog(text + "\n");
            }
        });
        pyodide.setStderr({
            batched: (text) => {
                appendConsoleLog("Pyodide Error: " + text + "\n");
            }
        });
        
        updateLoader("Initializing Micropip Package Manager", "Bootstrapping Python pip interface...", 40);
        await pyodide.loadPackage("micropip");

        updateLoader("Loading Scientific Runtime", "Preparing NumPy / SciPy / scikit-learn for build123d...", 52);
        await pyodide.loadPackage(["numpy", "scipy", "scikit-learn"]);
        
        updateLoader("Installing Geometric Engine", "Fetching build123d and OCP.wasm dependencies (~30MB)...", 65);
        
        // Bootstrap the browser-compatible OpenCascade/build123d stack.
        await pyodide.runPythonAsync(`
import micropip
micropip.set_index_urls(["${OCP_WASM_INDEX}", "https://pypi.org/simple"])
await micropip.install("lib3mf")
micropip.add_mock_package(
    "py-lib3mf",
    "2.4.1",
    modules={"py_lib3mf": "from lib3mf import *"},
)
await micropip.install(["build123d", "sqlite3"])
        `);
        
        updateLoader("Finalizing CAD Setup", "Pre-compiling packages and checking OpenCascade kernel...", 90);
        
        // Load build123d to warm up
        await pyodide.runPythonAsync("from build123d import *");
        
        STATE.pyodide = pyodide;
        updateStatusIndicators();
        
        // Remove loading overlay
        document.getElementById('loading-overlay').style.display = 'none';
        appendConsoleLog("Pyodide Kernel and build123d successfully loaded!\n");
        appendConsoleLog("Viewport is empty. Describe a part, pick a benchmark, or import a STEP/DXF file to begin.\n");
        // Deliberately no auto-run: the user starts from an empty viewport rather
        // than a placeholder part they did not ask for.

    } catch (e) {
        console.error(e);
        updateLoader("Initialization Error", "Failed to start Pyodide. Check console for details.", 0);
        document.getElementById('loader-details').innerHTML = `
            <div style="color: var(--accent-error); font-weight: bold; margin-top: 10px;">
                Error: ${e.message}<br>
                Please verify your network connection and reload.
            </div>
        `;
    }
}

// Run Python script inside Pyodide
async function runPythonCode(pythonScript, options = {}) {
    if (!STATE.pyodide) {
        appendConsoleLog("Cannot run code: Pyodide is not initialized yet.\n");
        return;
    }

    // A comment-only starter template is not an error — just show an empty viewport.
    if (isEffectivelyEmptyScript(pythonScript)) {
        clearRenderedGeometry();
        STATE.lastError = null;
        appendConsoleLog("----------------------------------------\n");
        appendConsoleLog("Script is empty — nothing to build. Viewport cleared.\n");
        return true;
    }

    appendConsoleLog("----------------------------------------\n");
    appendConsoleLog("Compiling shape...\n");
    
    // Extract selected feature info for Python helper functions
    const targetInfo = STATE.selectedFeature ? {
        center: STATE.selectedFeature.center,
        normal: STATE.selectedFeature.normal
    } : null;

    // Base python execution wrap script
    const pyWrapperScript = `
import json
import traceback
import sys
from io import StringIO

# Selected feature info is passed in as the __target_info global from JS.

def __wasm_run_and_tessellate(code_to_run, is_2d, target_info):
    # Save standard outputs and capture prints in a buffer.
    # NOTE: pyodide.setStdout() installs a stream with no .getvalue(), so we
    # must swap in a real StringIO before reading the captured output back.
    old_stdout = sys.stdout
    old_stderr = sys.stderr
    _capture = StringIO()
    sys.stdout = _capture
    sys.stderr = _capture

    def log_output(msg):
        print(msg)

    local_scope = {}

    # Pre-inject helpers and selected-feature globals so the LLM never has to
    # write the lookup boilerplate (and never references undefined names).
    try:
        from build123d import Vector as _B123dVector
    except Exception:
        _B123dVector = None

    def _resolve_center(center, kind):
        # NOTE: the None check must happen BEFORE any Vector conversion, otherwise
        # Vector(*None) raises "argument after * must be an iterable, not NoneType".
        if center is None:
            center = local_scope.get("target_center")
            if center is not None:
                # Falling back to the live selection makes the script depend on
                # mutable outside state: re-running it after the user selects a
                # different feature silently retargets this operation. Warn loudly.
                print(
                    "[warning] " + kind + "() was called without explicit coordinates, so it fell "
                    "back to the currently selected feature. This makes the edit unstable — when "
                    "this script is re-run after a different selection, the operation will move. "
                    "Bake the coordinate in instead: " + kind + "(shape, (x, y, z))."
                )
        if center is None:
            return None
        if _B123dVector is None:
            return center
        if isinstance(center, _B123dVector):
            return center
        try:
            return _B123dVector(*center)
        except TypeError:
            raise ValueError(
                kind + ": center must be a Vector or an (x, y, z) sequence, got " + repr(center)
            )

    def find_nearest_face(shape, center=None, tolerance=None):
        c = _resolve_center(center, "find_nearest_face")
        if c is None:
            raise ValueError(
                "find_nearest_face: no coordinates given and nothing is currently selected. "
                "Pass them explicitly: find_nearest_face(shape, (x, y, z))"
            )
        faces = list(shape.faces())
        if not faces:
            raise ValueError("find_nearest_face: shape has no faces")
        if tolerance is not None:
            for f in faces:
                if (f.center() - c).length <= tolerance:
                    return f
        return min(faces, key=lambda f: (f.center() - c).length)

    def find_nearest_edge(shape, center=None, tolerance=None):
        c = _resolve_center(center, "find_nearest_edge")
        if c is None:
            raise ValueError(
                "find_nearest_edge: no coordinates given and nothing is currently selected. "
                "Pass them explicitly: find_nearest_edge(shape, (x, y, z))"
            )
        edges = list(shape.edges())
        if not edges:
            raise ValueError("find_nearest_edge: shape has no edges")
        if tolerance is not None:
            for e in edges:
                if (e.center() - c).length <= tolerance:
                    return e
        return min(edges, key=lambda e: (e.center() - c).length)

    def _safe_blend(shape, edge_list, size, op, label):
        # A cosmetic fillet/chamfer must never destroy the whole model. OCCT's
        # ChFi3d_Builder fails on plenty of valid-looking edge sets ("only 2 faces",
        # "Failed creating a fillet..."), and previously that took the entire script
        # down with it, leaving the user with no geometry at all. Degrade instead:
        # retry smaller, then skip the blend and keep the part.
        try:
            edges = list(edge_list)
        except TypeError:
            edges = [edge_list]
        if not edges:
            print("[warning] " + label + ": no edges matched the selection; left unchanged.")
            return shape

        def apply(r):
            return shape.fillet(radius=r, edge_list=edges) if op == "fillet" \\
                else shape.chamfer(length=r, edge_list=edges)

        try:
            return apply(size)
        except Exception as first_error:
            limit = None
            if op == "fillet":
                try:
                    limit = shape.max_fillet(edges, tolerance=0.05)
                except Exception:
                    limit = None
            fallbacks = []
            if limit and limit > 0.05:
                fallbacks.append(limit * 0.9)
            fallbacks.extend([size * 0.5, size * 0.25])
            for r in fallbacks:
                if r is None or r <= 0.05 or r >= size:
                    continue
                try:
                    result = apply(r)
                    print("[warning] " + label + ": " + str(size) + "mm failed on these "
                          + str(len(edges)) + " edges, applied " + str(round(r, 3)) + "mm instead.")
                    return result
                except Exception:
                    continue
            print("[warning] " + label + ": could not be applied to these " + str(len(edges))
                  + " edges at any radius, so it was SKIPPED and the part was kept. "
                  + "Reason: " + str(first_error)[:120])
            return shape

    def safe_fillet(shape, edge_list, radius):
        return _safe_blend(shape, edge_list, radius, "fillet", "fillet")

    def safe_chamfer(shape, edge_list, length):
        return _safe_blend(shape, edge_list, length, "chamfer", "chamfer")

    local_scope["find_nearest_face"] = find_nearest_face
    local_scope["find_nearest_edge"] = find_nearest_edge
    local_scope["safe_fillet"] = safe_fillet
    local_scope["safe_chamfer"] = safe_chamfer
    local_scope["target_center"] = None
    local_scope["target_normal"] = None

    if target_info and _B123dVector is not None:
        if target_info.get("center"):
            local_scope["target_center"] = _B123dVector(*target_info["center"])
        if target_info.get("normal"):
            local_scope["target_normal"] = _B123dVector(*target_info["normal"])

    try:
        # Run user code. Use one dict for globals+locals so the script behaves
        # like module-level code (comprehensions / nested defs can see names).
        local_scope["__builtins__"] = __builtins__
        exec(code_to_run, local_scope, local_scope)

        import inspect as _inspect
        try:
            from build123d import Shape as _B123dShape
        except Exception:
            _B123dShape = None

        def _is_geometry_instance(v):
            if v is None:
                return False
            if _inspect.isclass(v) or _inspect.ismodule(v) or _inspect.isfunction(v) or _inspect.isbuiltin(v) or _inspect.ismethod(v):
                return False
            return True

        def _unwrap_builder(v):
            for attr in ("part", "sketch", "line", "wire"):
                inner = getattr(v, attr, None)
                if inner is not None and _is_geometry_instance(inner) and inner is not v:
                    return inner
            return v

        target_var = "sketch" if is_2d else "part"
        shape = None

        candidate = local_scope.get(target_var)
        if _is_geometry_instance(candidate):
            shape = _unwrap_builder(candidate)

        if shape is None:
            # Fallback: scan for actual shape instances, skipping classes/modules
            for key, val in local_scope.items():
                if key.startswith("_"):
                    continue
                if not _is_geometry_instance(val):
                    continue
                unwrapped = _unwrap_builder(val)
                # Only accept things that look like real geometry instances
                if _B123dShape is not None and isinstance(unwrapped, _B123dShape):
                    shape = unwrapped
                    break
                if hasattr(unwrapped, "faces") and hasattr(unwrapped, "edges") and not _inspect.isclass(unwrapped):
                    # Verify callable as instance method (would fail with class methods)
                    try:
                        unwrapped.faces()
                        shape = unwrapped
                        break
                    except TypeError:
                        continue

        if shape is None:
            raise Exception(f"Script compiled but variable '{target_var}' was not found. Please define '{target_var}' as your final model.")
        
        export_warning = None

        # Write export file to virtual file system when possible.
        from build123d import ExportDXF, export_step
        try:
            if is_2d:
                exporter = ExportDXF()
                exporter.add_shape(shape)
                exporter.write("model.dxf")
            else:
                export_step(shape, "model.step")
        except Exception as export_exc:
            export_warning = str(export_exc)
            
        # Extract tessellation data
        faces_data = []
        for i, face in enumerate(shape.faces()):
            center = face.center()
            try:
                normal = face.normal_at(center)
            except:
                from build123d import Vector
                normal = Vector(0,0,1)

            try:
                vertices, triangles = face.tessellate(0.2, 0.2)
            except Exception:
                vertices, triangles = [], []

            try:
                bb = face.bounding_box()
                bbox = [bb.min.X, bb.min.Y, bb.min.Z, bb.max.X, bb.max.Y, bb.max.Z]
            except Exception:
                bbox = None

            try:
                area = float(face.area)
            except Exception:
                area = None

            v_list = []
            for v in vertices:
                v_list.extend([v.X, v.Y, v.Z])
            idx_list = []
            for t in triangles:
                idx_list.extend(t)

            faces_data.append({
                "id": f"Face_{i}",
                "center": [center.X, center.Y, center.Z],
                "normal": [normal.X, normal.Y, normal.Z],
                "bbox": bbox,
                "area": area,
                "vertices": v_list,
                "indices": idx_list
            })
            
        edges_data = []
        for j, edge in enumerate(shape.edges()):
            try:
                length = edge.length
                pts = []
                if length > 1e-4:
                    for k in range(21):
                        p = edge @ (k / 20.0)
                        pts.extend([p.X, p.Y, p.Z])
                else:
                    p1 = edge.start_point()
                    p2 = edge.end_point()
                    pts.extend([p1.X, p1.Y, p1.Z, p2.X, p2.Y, p2.Z])
                edges_data.append({
                    "id": f"Edge_{j}",
                    "vertices": pts
                })
            except:
                continue
                
        stdout_output = _capture.getvalue()
        sys.stdout = old_stdout
        sys.stderr = old_stderr

        return json.dumps({
            "success": True,
            "stdout": stdout_output,
            "export_warning": export_warning,
            "mesh": {
                "faces": faces_data,
                "edges": edges_data
            }
        })
    except Exception as e:
        tb = traceback.format_exc()
        stdout_output = _capture.getvalue()
        sys.stdout = old_stdout
        sys.stderr = old_stderr
        return json.dumps({
            "success": False,
            "stdout": stdout_output,
            "error": str(e),
            "traceback": tb
        })

__wasm_run_and_tessellate(__code_to_run, __is_2d, __target_info)
`;

    try {
        // Set local variables in python globals
        STATE.pyodide.globals.set("__code_to_run", pythonScript);
        STATE.pyodide.globals.set("__is_2d", STATE.is2DMode);

        let targetInfoPy = null;
        if (STATE.selectedFeature) {
            const feat = STATE.selectedFeature;
            targetInfoPy = STATE.pyodide.toPy({
                id: feat.id,
                type: feat.type,
                center: Array.isArray(feat.center) ? feat.center : null,
                normal: Array.isArray(feat.normal) ? feat.normal : null
            });
        }
        STATE.pyodide.globals.set("__target_info", targetInfoPy);
        
        const rawResult = await STATE.pyodide.runPythonAsync(pyWrapperScript);
        const result = JSON.parse(rawResult);
        
        if (result.stdout) {
            appendConsoleLog(result.stdout);
        }
        
        if (result.success) {
            appendConsoleLog("Shape compiled successfully.\n");
            if (result.export_warning) {
                appendConsoleLog(`Export Warning: ${result.export_warning}\n`);
            }
            clearRenderedGeometry();
            renderMesh(result.mesh);
            STATE.lastError = null;
            return true;
        } else {
            appendConsoleLog(`Compilation Failed: ${result.error}\n`);
            appendConsoleLog(`${result.traceback}\n`);
            displayMessage('ai', `Compilation failed: ${result.error}`, true);
            appendConsoleLog("Previous viewport geometry preserved because compilation failed.\n");
            STATE.lastError = `${result.error}\n${result.traceback || ''}`.trim();
            return false;
        }
    } catch (e) {
        console.error(e);
        appendConsoleLog(`Runner System Error: ${e.message}\n`);
        appendConsoleLog("Previous viewport geometry preserved because the runner failed.\n");
        return false;
    }
}

function clearRenderedGeometry() {
    clearFeatureSelection();
    disposeGroupChildren(STATE.three.facesGroup);
    disposeGroupChildren(STATE.three.edgesGroup);
    STATE.three.raycastObjects = [];
}

// Render the JSON Mesh returned by Pyodide
function renderMesh(meshData) {
    const palette = STATE.is2DMode
        ? {
            face: 0xe7edf3,
            edge: 0x1e2936
        }
        : {
            face: 0x4a90e2,
            edge: 0x2b303b
        };

    // 1. Build Face Meshes
    meshData.faces.forEach(face => {
        if (face.vertices.length === 0 || face.indices.length === 0) return;
        
        const geometry = new THREE.BufferGeometry();
        const vertices = new Float32Array(face.vertices);
        const indices = new Uint32Array(face.indices);
        
        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        geometry.computeVertexNormals();
        
        const material = new THREE.MeshStandardMaterial({
            color: palette.face,
            roughness: 0.4,
            metalness: 0.25,
            side: THREE.DoubleSide
        });
        
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData = {
            id: face.id,
            center: face.center,
            normal: face.normal,
            bbox: face.bbox || null,
            area: (typeof face.area === 'number') ? face.area : null,
            type: 'face',
            baseColor: palette.face
        };
        
        STATE.three.facesGroup.add(mesh);
        STATE.three.raycastObjects.push(mesh);
    });
    
    // 2. Build Edge Lines
    meshData.edges.forEach(edge => {
        if (edge.vertices.length === 0) return;
        
        const points = [];
        for (let i = 0; i < edge.vertices.length; i += 3) {
            points.push(new THREE.Vector3(edge.vertices[i], edge.vertices[i+1], edge.vertices[i+2]));
        }

        const center = [0, 0, 0];
        points.forEach(point => {
            center[0] += point.x;
            center[1] += point.y;
            center[2] += point.z;
        });
        center[0] /= points.length;
        center[1] /= points.length;
        center[2] /= points.length;
        
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineBasicMaterial({
            color: palette.edge,
            linewidth: 1
        });
        
        // Edge wireframe highlight
        const line = new THREE.Line(geometry, material);
        line.userData = {
            id: edge.id,
            center,
            normal: [0, 0, 0],
            type: 'edge',
            baseColor: palette.edge
        };
        STATE.three.edgesGroup.add(line);
        STATE.three.raycastObjects.push(line);
    });
    
    // Fit camera view
    resetCamera();
}

// Export STEP File from virtual FS
function exportStepFile() {
    if (STATE.is2DMode) {
        alert("The current project is in 2D mode. Switch to 3D mode to download STEP.");
        return;
    }
    
    try {
        const fileData = STATE.pyodide.FS.readFile("model.step");
        triggerDownload(fileData, "model.step", "application/octet-stream");
        appendConsoleLog("STEP file exported successfully.\n");
    } catch (e) {
        if (tryDownloadImportedSource('step')) {
            appendConsoleLog("STEP export fell back to the originally imported file.\n");
            return;
        }
        console.error(e);
        alert("No STEP file generated. Run valid Python code first.");
    }
}

// Export DXF File from virtual FS
function exportDxfFile() {
    if (!STATE.is2DMode) {
        alert("The current project is in 3D mode. Switch to 2D mode to download DXF.");
        return;
    }
    
    try {
        const fileData = STATE.pyodide.FS.readFile("model.dxf");
        triggerDownload(fileData, "model.dxf", "application/octet-stream");
        appendConsoleLog("DXF file exported successfully.\n");
    } catch (e) {
        if (tryDownloadImportedSource('dxf')) {
            appendConsoleLog("DXF export fell back to the originally imported file.\n");
            return;
        }
        console.error(e);
        alert("No DXF file generated. Run valid Python code first.");
    }
}

function triggerDownload(dataArray, filename, mimeType) {
    const blob = new Blob([dataArray], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function tryDownloadImportedSource(kind) {
    if (!STATE.importedAsset || STATE.importedAsset.kind !== kind) {
        return false;
    }

    try {
        const fileData = STATE.pyodide.FS.readFile(STATE.importedAsset.path);
        const defaultMimeType = kind === 'dxf' ? 'application/dxf' : 'application/step';
        triggerDownload(fileData, STATE.importedAsset.name, defaultMimeType);
        return true;
    } catch (readError) {
        console.error(readError);
        return false;
    }
}

function disposeGroupChildren(group) {
    while (group.children.length > 0) {
        const child = group.children[0];
        group.remove(child);
        if (child.geometry) {
            child.geometry.dispose();
        }
        if (child.material) {
            child.material.dispose();
        }
    }
}

// Append messages in assistant view
function displayMessage(role, text, isError = false, htmlSuffix = '') {
    const console = document.getElementById('chat-console');
    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-message ${role} ${isError ? 'error' : ''}`;
    
    // Simple parser to format markdown backticks and bold text
    let formattedText = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>")
        .replace(/\`{3}python([\s\S]*?)\`{3}/g, '<div class="code-block-collapsed"><i class="fa-solid fa-code"></i> Python code generated (placed in Editor tab)</div>')
        .replace(/\`(.*?)\`/g, '<span class="ref-badge">$1</span>');
        
    msgDiv.innerHTML = `<div class="message-content">${formattedText}${htmlSuffix}</div>`;
    console.appendChild(msgDiv);
    console.scrollTop = console.scrollHeight;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getGeminiModelCandidates(requestedModel) {
    return [
        requestedModel,
        'gemini-flash-latest',
        'gemini-2.5-flash'
    ].filter((model, index, models) => model && models.indexOf(model) === index);
}

function summarizeGeminiError(status, errorPayloadText) {
    try {
        const parsed = JSON.parse(errorPayloadText);
        const message = parsed?.error?.message || 'Unknown Gemini error';
        const code = parsed?.error?.code || status;
        const reason = parsed?.error?.status || 'ERROR';

        if (code === 503 || reason === 'UNAVAILABLE') {
            return `Gemini is temporarily overloaded (${code}: ${reason}). The app already tried fallback models; please retry in a moment or use OpenRouter.`;
        }

        if (code === 429 || reason === 'RESOURCE_EXHAUSTED') {
            return `Gemini rate limit reached (${code}: ${reason}). Please wait a bit and try again.`;
        }

        return `Gemini API Error (${code}: ${reason}): ${message}`;
    } catch {
        if (status === 503) {
            return 'Gemini is temporarily overloaded (503). Please retry in a moment or switch provider.';
        }
        if (status === 429) {
            return 'Gemini rate limit reached (429). Please wait a bit and try again.';
        }
        return `Gemini API Error (${status}): ${errorPayloadText}`;
    }
}

function summarizeHTTPError(provider, status, errorPayloadText) {
    const payload = (errorPayloadText || '').trim();

    try {
        const parsed = JSON.parse(payload);
        const message = parsed?.error?.message || parsed?.message || payload;
        const reason = parsed?.error?.code || parsed?.error?.status || status;
        return `${provider} API Error (${status}: ${reason}): ${message}`;
    } catch {
        const titleMatch = payload.match(/<title>(.*?)<\/title>/i);
        const messageMatch = payload.match(/<p>Message:\s*(.*?)<\/p>/i);
        const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
        const message = messageMatch ? messageMatch[1].replace(/\s+/g, ' ').trim() : '';

        if (status === 501 || /Unsupported method/i.test(payload)) {
            return `${provider} endpoint rejected the request (${status}). Check that the API Endpoint URL points to the provider API, not this app server.`;
        }

        return `${provider} API Error (${status})${title ? `: ${title}` : ''}${message ? ` - ${message}` : ''}`;
    }
}

// Dynamic LLM System Prompt builder
function getSystemPrompt() {
    return `You are an expert parametric CAD assistant. You write Python scripts that build 3D or 2D geometry with the build123d library, running inside a browser Pyodide (WebAssembly) sandbox.

OUTPUT FORMAT (strict):
- Reply with at most one short sentence of explanation, followed by ONE fenced \`\`\`python ... \`\`\` block containing the COMPLETE script (no diffs, no ellipses).
- Always return a full, standalone, runnable script — even small edits must restate the entire program.
- Do NOT call export_step / export_dxf / ExportDXF yourself. The host wrapper exports files automatically.
- Units are millimeters.

${TEXT_TO_CAD_SKILL_APPENDIX}

BUILD123D API GUARDRAILS (exact signatures — do NOT invent keyword arguments):
- Polygon(*pts, rotation=0, align=(Align.NONE, Align.NONE), mode=Mode.ADD) — a SKETCH object. It has NO 'close' argument; the outline is always closed automatically. Write Polygon((0,0), (30,0), (0,30)) — never Polygon(pts, close=True).
- Polyline(*pts, close=False, mode=Mode.ADD) — a LINE/curve object. This is the only one of the two with 'close'. Use it inside BuildLine, then make_face() to turn it into a sketch.
- RegularPolygon(radius, side_count, major_radius=True, rotation=0, align=..., mode=...)
- Rectangle(width, height, rotation=0, align=..., mode=...) / Circle(radius, arc_size=360.0, align=..., mode=...)
- Triangle(...) is KEYWORD-ONLY: Triangle(a=30, b=30, c=30) or Triangle(a=30, b=40, C=90). Triangle(30, 30, 30) raises TypeError.
- Box(length, width, height, rotation=..., align=..., mode=...) / Cylinder(radius, height, ...) / Hole(radius, depth=None, mode=Mode.SUBTRACT) / CounterBoreHole / CounterSinkHole
- extrude(to_extrude=None, amount=None, dir=None, until=None, mode=Mode.ADD) — 'amount' is signed; negative extrudes into the part.
- fillet(objects, radius) / chamfer(objects, length, length2=None) as builder functions; or shape.fillet(radius, edge_list) / shape.chamfer(length, length2, edge_list) as methods (length2 is positional and required on the method form — pass None).
- Location((x, y, z)) / Locations(*pts) / PolarLocations(radius, count, start_angle=0) / GridLocations(x_spacing, y_spacing, x_count, y_count).
- Selectors: shape.faces().sort_by(Axis.Z)[-1], .filter_by(Axis.Z), .group_by(Axis.Z)[-1] — there is no .faces(Axis.Z).
- If you are not certain a keyword argument exists, omit it and use positional arguments or an explicit construction instead. A wrong keyword raises TypeError and the whole build fails.

TRIANGULAR GUSSETS / RIBS — preferred recipe (avoids Polygon/Polyline confusion):
\`\`\`python
from build123d import *
with BuildPart() as bp:
    with BuildSketch(Plane.YZ) as gusset:
        Polygon((0, 0), (30, 0), (0, 30))
    extrude(amount=8)
part = bp.part
\`\`\`

REQUIRED FINAL VARIABLE:
- 3D mode → assign final geometry to a variable named exactly 'part' (a Part/Compound/Solid, not a builder).
- 2D mode → assign final geometry to a variable named exactly 'sketch' (a Sketch/Compound, not a builder).
- If you use a context manager, unwrap it at the end:
    with BuildPart() as bp:
        Box(50, 50, 50)
    part = bp.part
- Never leave the target name pointing at a class or a still-open builder.

MODIFICATION WORKFLOW (CUMULATIVE — this is critical):
- The user message includes a [Context] block with: current mode, the imported file path (if any), the selected face/edge ID + center + normal (if any), and the [Current script]. Treat the current script as the source of truth.
- Modifications are CUMULATIVE. The current script already contains every previously-applied edit (extra Edge.make_line calls, holes, fillets, etc.). You MUST preserve ALL of those existing modifications AND add the new requested change on top. Never delete prior additions unless the user explicitly asks you to remove them.
- Return the full updated script with both the old modifications and the new one merged together.
- If the user selected a face/edge, anchor new geometry using its exact coordinates / normal — don't guess.
- DO NOT swap to different import APIs. Preserve the existing import code verbatim. In particular, for DXF the script already uses:
    from build123d.import_dxf import _process_entity
    import ezdxf
    doc = ezdxf.readfile("...")
    imported_shapes = []
    for entity in doc.modelspace():
        imported_shapes.extend(_process_entity(entity, doc))
    sketch = Sketch(imported_shapes)
  To add a new edge (e.g. extending a selected line), append additional edges to imported_shapes BEFORE the final Sketch(...) call:
    imported_shapes.append(Edge.make_line((x1, y1, z1), (x2, y2, z2)))
- For STEP the script uses \`part = import_step("...")\` — keep that, then build new features on top using BuildPart contexts or boolean operations.

EXAMPLES:

3D — hole on the top face of a box (from scratch):
\`\`\`python
from build123d import *
with BuildPart() as bp:
    Box(100, 50, 10)
    with BuildSketch(bp.faces().sort_by(Axis.Z)[-1]) as sk:
        Circle(5)
    extrude(amount=-10, mode=Mode.SUBTRACT)
part = bp.part
\`\`\`

HOST-PROVIDED HELPERS — the runtime pre-defines these, you do NOT import or assign them:
- \`find_nearest_face(shape, (x, y, z))\` — the face in \`shape\` whose center is closest to that point.
- \`find_nearest_edge(shape, (x, y, z))\` — same, for edges.
- \`target_center\` / \`target_normal\` (Vector or None) — the *currently* selected feature. Read-only conveniences.
- \`safe_fillet(shape, edges, radius)\` / \`safe_chamfer(shape, edges, length)\` — see the fillet rule below.

🚨 FILLETS AND CHAMFERS MUST NEVER KILL THE MODEL.

OpenCASCADE fails on many geometrically reasonable edge sets, with errors such as \`ChFi3d_Builder: only 2 faces\` or \`Failed creating a fillet with radius of N\`. A cosmetic rounding is never worth losing the whole part, so:

- Use \`safe_fillet(shape, edges, radius)\` / \`safe_chamfer(shape, edges, length)\` instead of \`.fillet()\` / \`.chamfer()\` whenever the blend is a finishing touch rather than the point of the request. They retry at a smaller radius, then skip the blend and return the unmodified shape with a warning, so the user always gets geometry.
- **Select edges narrowly.** Never pass \`shape.edges()\` (every edge) or a broad \`filter_by(Axis.Z)\` — those sweep in hole rims, gusset intersections, and short edges where the radius cannot fit, and the whole operation fails. Filter down to the specific edges the user asked about, using position:
  \`\`\`python
  rear_edges = [e for e in part.edges() if abs(e.center().Y - 25.0) < 1e-6]
  part = safe_fillet(part, rear_edges, 2.0)
  \`\`\`
- Apply blends **last**, after holes and cutouts exist, and keep the radius comfortably under half the local wall thickness.

🚨 ALWAYS PASS EXPLICIT COORDINATES. This is the single most important rule.

Write \`find_nearest_face(existing, (16.540, 25.000, 16.540))\` — copy the literal numbers out of [Context].
NEVER write the bare \`find_nearest_face(existing)\`.

Why this matters: \`target_center\` changes every time the user clicks something new. A script containing a bare \`find_nearest_face(existing)\` silently retargets when it is re-run under a different selection, so the user's earlier edit jumps to the new face and appears to vanish. Baking the coordinate into each call is what makes edits accumulate correctly. Each operation must permanently remember its own location.

Give each operation a distinct, descriptive variable name (\`extended_face\`, \`fillet_edge\`, \`bore_face\`) rather than reusing \`target_face\` for everything — the script will accumulate several of them.

3D — extend a face outward along its normal (e.g. "extend this face 10mm"):
\`\`\`python
from build123d import *
existing = import_step("/cad_imports/EXISTING_PATH.stp")
extended_face = find_nearest_face(existing, (16.540, 25.000, 16.540))
extension = Solid.extrude(extended_face, extended_face.normal_at(extended_face.center()) * 10)
part = existing + extension
\`\`\`

3D — a SECOND edit stacked on the first. Note that edit 1 keeps its own hard-coded coordinate, and the new operation is applied to the result of edit 1 (\`part\`), not to \`existing\`:
\`\`\`python
from build123d import *
existing = import_step("/cad_imports/EXISTING_PATH.stp")

# --- edit 1: extend a face by 10mm (coordinates frozen, do not touch) ---
extended_face = find_nearest_face(existing, (16.540, 25.000, 16.540))
part = existing + Solid.extrude(extended_face, extended_face.normal_at(extended_face.center()) * 10)

# --- edit 2: drill a 6mm hole through a different face ---
bore_face = find_nearest_face(part, (0.000, 25.000, 25.000))
with BuildPart() as bp:
    add(part)
    with BuildSketch(Plane(bore_face)) as sk:
        Circle(3)
    extrude(amount=-50, mode=Mode.SUBTRACT)
part = bp.part
\`\`\`

3D — drill a hole through the selected face (subtract):
\`\`\`python
from build123d import *
existing = import_step("/cad_imports/EXISTING_PATH.stp")
bore_face = find_nearest_face(existing, (0.000, 25.000, 25.000))
with BuildPart() as bp:
    add(existing)
    with BuildSketch(Plane(bore_face)) as sk:
        Circle(3)            # radius in mm
    extrude(amount=-20, mode=Mode.SUBTRACT)
part = bp.part
\`\`\`

3D — FILLET (倒圓角) the selected edge:
\`\`\`python
from build123d import *
existing = import_step("/cad_imports/EXISTING_PATH.stp")
fillet_edge = find_nearest_edge(existing, (9.080, 25.000, 16.540))
part = existing.fillet(radius=3.0, edge_list=[fillet_edge])
\`\`\`

3D — CHAMFER (倒角) the selected edge:
\`\`\`python
from build123d import *
existing = import_step("/cad_imports/EXISTING_PATH.stp")
chamfer_edge = find_nearest_edge(existing, (9.080, 25.000, 16.540))
part = existing.chamfer(length=3.0, edge_list=[chamfer_edge])
\`\`\`

3D — add a 1mm × 1mm rib along the selected edge by 10mm (edges have no thickness, so "extend an edge" becomes a small prism along its direction):
\`\`\`python
from build123d import *
existing = import_step("/cad_imports/EXISTING_PATH.stp")
rib_edge = find_nearest_edge(existing, (25.000, 17.040, 25.000))
edge_dir = (rib_edge.end_point() - rib_edge.start_point()).normalized()
plane = Plane(origin=rib_edge.end_point(), z_dir=edge_dir)
with BuildPart() as rib:
    with BuildSketch(plane) as sk:
        Rectangle(1.0, 1.0)
    extrude(amount=10)
part = existing + rib.part
\`\`\`

2D — extend a selected edge of an imported DXF by appending a new collinear segment to imported_shapes (preserve the original script's import scaffold!):
\`\`\`python
from build123d.import_dxf import _process_entity
from build123d import *
import ezdxf

doc = ezdxf.readfile("/cad_imports/EXISTING_PATH.dxf")
imported_shapes = []
for entity in doc.modelspace():
    imported_shapes.extend(_process_entity(entity, doc))

# Extend the selected edge (center 30,50,0) by 5mm to the right.
# The selected edge ran horizontally near y=50, so add a 5mm segment continuing rightward:
imported_shapes.append(Edge.make_line((50, 50, 0), (55, 50, 0)))

sketch = Sketch(imported_shapes)
\`\`\`

ERROR RECOVERY:
- If the previous run failed, the error message is in chat history. Read it, find the root cause, and fix the script.`;
}

// Submit prompt to LLM
async function handlePromptSubmit() {
    const promptInput = document.getElementById('prompt-input');
    const userPrompt = promptInput.value.trim();
    if (!userPrompt) return;

    const contextParts = [];

    contextParts.push(`Mode: ${STATE.is2DMode ? '2D (sketch / DXF)' : '3D (part / STEP)'}`);

    if (STATE.importedAsset) {
        contextParts.push(`Imported file in virtual FS: "${STATE.importedAsset.path}" (original name: ${STATE.importedAsset.name}, kind: ${STATE.importedAsset.kind.toUpperCase()}). You may load it from that path with build123d importers.`);
    }

    if (STATE.selectedFeature) {
        const feat = STATE.selectedFeature;
        const parts = [
            `Selected topological ${feat.type} '${feat.id}' at center (${feat.center[0].toFixed(3)}, ${feat.center[1].toFixed(3)}, ${feat.center[2].toFixed(3)})`
        ];
        if (feat.type === 'face') {
            parts.push(`normal vector (${feat.normal[0].toFixed(3)}, ${feat.normal[1].toFixed(3)}, ${feat.normal[2].toFixed(3)})`);
        }
        if (feat.bbox) {
            const b = feat.bbox;
            const sx = (b[3] - b[0]).toFixed(3);
            const sy = (b[4] - b[1]).toFixed(3);
            const sz = (b[5] - b[2]).toFixed(3);
            parts.push(`axis-aligned bbox min (${b[0].toFixed(3)}, ${b[1].toFixed(3)}, ${b[2].toFixed(3)}) max (${b[3].toFixed(3)}, ${b[4].toFixed(3)}, ${b[5].toFixed(3)}), size ${sx} x ${sy} x ${sz} mm`);
        }
        if (feat.area !== null && feat.area !== undefined) {
            parts.push(`area ${feat.area.toFixed(3)} mm²`);
        }
        contextParts.push(parts.join('; '));
    }

    const currentScript = (STATE.editor ? STATE.editor.getValue() : STATE.currentScript) || '';
    contextParts.push(`Current script (modify and return the FULL updated version, do not return a diff):\n\`\`\`python\n${currentScript.trim()}\n\`\`\``);

    if (STATE.lastError) {
        contextParts.push(`Previous run FAILED with this error — please fix it:\n\`\`\`\n${STATE.lastError}\n\`\`\``);
    }

    const promptWithContext = `[Context]\n${contextParts.join('\n\n')}\n\n[User Request]\n${userPrompt}`;

    let contextHTML = '';
    if (STATE.selectedFeature) {
        contextHTML = ` <span class="ref-badge"><i class="fa-solid fa-tag"></i> ${STATE.selectedFeature.id}</span>`;
    }
    
    displayMessage('user', userPrompt, false, contextHTML);
    promptInput.value = '';
    
    // Disable send btn
    const sendBtn = document.getElementById('send-prompt-btn');
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<span>Thinking...</span> <i class="fa-solid fa-circle-notch fa-spin"></i>';
    
    try {
        appendConsoleLog(`Sending prompt to ${STATE.aiConfig.provider} endpoint...\n`);
        const responseCode = await generateCAD(promptWithContext);
        
        if (responseCode) {
            displayMessage('ai', `Updated model code. Processing script...`);

            // Snapshot the *previous* script so Undo can roll back this AI change.
            snapshotCurrentScript('AI edit');

            // Set Monaco editor value
            syncEditorScript(responseCode);

            // Auto run compiled script
            let compiled = await runPythonCode(responseCode, { skipSnapshot: true });

            // Automatic single repair pass: feed the traceback straight back to
            // the model instead of making the user re-click Generate.
            for (let attempt = 0; !compiled && STATE.lastError && attempt < MAX_AUTO_REPAIR_ATTEMPTS; attempt++) {
                const failedScript = STATE.editor ? STATE.editor.getValue() : responseCode;
                displayMessage('ai', `Auto-repair ${attempt + 1}/${MAX_AUTO_REPAIR_ATTEMPTS}: sending the error back to the model...`);
                appendConsoleLog(`Auto-repair attempt ${attempt + 1}/${MAX_AUTO_REPAIR_ATTEMPTS}...\n`);

                const repairPrompt = `[Context]\nThe script below failed to compile. Fix it and return the COMPLETE corrected script.\n\n` +
                    `Failed script:\n\`\`\`python\n${failedScript.trim()}\n\`\`\`\n\n` +
                    `Error:\n\`\`\`\n${STATE.lastError}\n\`\`\`\n\n` +
                    `[User Request]\nFix the error above while still satisfying the original request. If the error is an unexpected keyword argument, remove that argument and use a signature that actually exists in build123d.`;

                const repairedCode = await generateCAD(repairPrompt);
                if (!repairedCode) break;

                syncEditorScript(repairedCode);
                compiled = await runPythonCode(repairedCode, { skipSnapshot: true });
            }

            if (compiled) {
                clearFeatureSelection();
            }
        } else {
            displayMessage('ai', 'Error: No valid Python code block found in LLM response.', true);
        }
    } catch (e) {
        console.error(e);
        displayMessage('ai', `Connection failed: ${e.message}`, true);
        appendConsoleLog(`LLM Error: ${e.message}\n`);
    } finally {
        sendBtn.disabled = false;
        sendBtn.innerHTML = '<span>Generate</span> <i class="fa-solid fa-paper-plane"></i>';
    }
}

// Unified BYOK request dispatcher
async function generateCAD(promptText) {
    const config = normalizeAIConfig(STATE.aiConfig);
    STATE.aiConfig = config;
    localStorage.setItem('cad_ai_config', JSON.stringify(STATE.aiConfig));
    const system = getSystemPrompt();
    
    // Construct standard history messages
    const formattedMessages = [
        { role: 'system', content: system }
    ];
    
    // Add current history
    STATE.messages.forEach(msg => {
        formattedMessages.push({ role: msg.role, content: msg.content });
    });
    
    formattedMessages.push({ role: 'user', content: promptText });
    
    let responseText = '';
    
    if (config.provider === 'gemini') {
        // Direct Gemini Developer API
        const requestedModel = (config.model || getProviderDefaults('gemini').model).trim();
        const modelCandidates = getGeminiModelCandidates(requestedModel);
        
        // Map roles to gemini user/model schema
        const contents = formattedMessages.filter(m => m.role !== 'system').map(m => ({
            role: m.role === 'user' ? 'user' : 'model',
            parts: [{ text: m.content }]
        }));
        
        // Prepend system prompt to the user contents or instructions
        const payload = {
            contents: contents,
            system_instruction: {
                parts: [{ text: system }]
            },
            generation_config: {
                temperature: 0.2
            }
        };

        let data = null;
        let lastGeminiError = null;
        const retryDelays = [0, 900, 1800];

        for (const modelName of modelCandidates) {
            const modelPath = modelName.startsWith('models/') ? modelName : `models/${modelName}`;
            const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent`;
            appendConsoleLog(`Trying Gemini model: ${modelName}\n`);

            for (let attempt = 0; attempt < retryDelays.length; attempt++) {
                if (retryDelays[attempt] > 0) {
                    appendConsoleLog(`Gemini retry ${attempt + 1}/${retryDelays.length} after ${retryDelays[attempt]}ms...\n`);
                    await sleep(retryDelays[attempt]);
                }

                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-goog-api-key': config.apiKey
                    },
                    body: JSON.stringify(payload)
                });

                if (response.ok) {
                    data = await response.json();
                    lastGeminiError = null;
                    break;
                }

                const errText = await response.text();
                lastGeminiError = {
                    status: response.status,
                    text: errText
                };

                if (![429, 500, 503].includes(response.status) || attempt === retryDelays.length - 1) {
                    break;
                }
            }

            if (data) {
                break;
            }
        }

        if (!data) {
            throw new Error(summarizeGeminiError(lastGeminiError.status, lastGeminiError.text));
        }

        responseText = extractGeminiResponseText(data);
        if (!responseText) {
            throw new Error(`Gemini returned no text output. Response: ${JSON.stringify(data)}`);
        }
        
    } else {
        // OpenAI, Anthropic, Ollama, LM Studio compatible /chat/completions endpoint
        let headers = {
            'Content-Type': 'application/json'
        };
        
        if (config.apiKey) {
            if (config.provider === 'anthropic') {
                headers['x-api-key'] = config.apiKey;
                headers['anthropic-version'] = '2023-06-01';
            } else if (config.provider === 'openrouter') {
                headers['Authorization'] = `Bearer ${config.apiKey}`;
                headers['HTTP-Referer'] = window.location.origin;
                headers['X-Title'] = 'Text-to-CAD Studio';
            } else {
                headers['Authorization'] = `Bearer ${config.apiKey}`;
            }
        }
        
        // Set endpoint
        let endpoint = config.apiUrl;
        if (!endpoint.endsWith('/chat/completions') && !endpoint.endsWith('/messages')) {
            endpoint = endpoint.replace(/\/$/, '') + '/chat/completions';
        }
        
        const payload = {
            model: config.model,
            messages: formattedMessages,
            temperature: 0.2,
            stream: false  // Omniroute for qwen2.5-coder requires stream: false
        };
        
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(summarizeHTTPError(config.provider, response.status, errText));
        }
        
        const data = await response.json();
        
        // Extract text
        if (data.choices && data.choices[0] && data.choices[0].message) {
            responseText = data.choices[0].message.content;
        } else if (data.content && data.content[0]) {
            responseText = data.content[0].text; // Anthropic messages
        } else {
            throw new Error("Unexpected API response format. Check developer logs.");
        }
    }
    
    // Save to dialogue history state
    STATE.messages.push({ role: 'user', content: promptText });
    STATE.messages.push({ role: 'assistant', content: responseText });
    if (STATE.messages.length > 20) {
        STATE.messages.shift(); // Keep logs manageable
        STATE.messages.shift();
    }
    
    // Extract Python code block
    const codeMatch = responseText.match(/```python([\s\S]*?)```/);
    if (codeMatch && codeMatch[1]) {
        return codeMatch[1].trim();
    }
    
    // Fallback: If no markdown block but response looks like python
    if (responseText.includes("import build123d") || responseText.includes("from build123d")) {
        return responseText.trim();
    }
    
    return null;
}

// CAD Toolbar Logic
// Build an explicit find_nearest_face(...) call pinned to the coordinates of the
// feature selected right now. Snippets must not emit a bare find_nearest_face(part):
// that resolves against the live selection, so re-running the script after the user
// clicks elsewhere would silently move the operation onto the new face.
function selectedFaceLookup(shapeVar = 'part') {
    const center = STATE.selectedFeature && STATE.selectedFeature.center;
    if (!center) return null;
    const coords = center.map(v => v.toFixed(3)).join(', ');
    return `find_nearest_face(${shapeVar}, (${coords}))`;
}

const TOOLBAR_CONFIG = {
    line: {
        title: "Create Line",
        fields: [
            { label: "Start Point X", name: "x1", type: "number", default: 0 },
            { label: "Start Point Y", name: "y1", type: "number", default: 0 },
            { label: "End Point X", name: "x2", type: "number", default: 10 },
            { label: "End Point Y", name: "y2", type: "number", default: 0 }
        ],
        generator: (vals) => `Line((${vals.x1}, ${vals.y1}), (${vals.x2}, ${vals.y2}))`
    },
    arc: {
        title: "Create Three-Point Arc",
        fields: [
            { label: "Point 1 X", name: "x1", type: "number", default: 0 },
            { label: "Point 1 Y", name: "y1", type: "number", default: 0 },
            { label: "Point 2 X", name: "x2", type: "number", default: 5 },
            { label: "Point 2 Y", name: "y2", type: "number", default: 2 },
            { label: "Point 3 X", name: "x3", type: "number", default: 10 },
            { label: "Point 3 Y", name: "y3", type: "number", default: 0 }
        ],
        generator: (vals) => `ThreePointArc((${vals.x1}, ${vals.y1}), (${vals.x2}, ${vals.y2}), (${vals.x3}, ${vals.y3}))`
    },
    rectangle: {
        title: "Create Rectangle",
        fields: [
            { label: "Width", name: "width", type: "number", default: 20 },
            { label: "Height", name: "height", type: "number", default: 10 },
            { label: "Rounded Corner Radius", name: "radius", type: "number", default: 0 }
        ],
        generator: (vals) => vals.radius > 0 
            ? `RectangleRounded(${vals.width}, ${vals.height}, ${vals.radius})` 
            : `Rectangle(${vals.width}, ${vals.height})`
    },
    circle: {
        title: "Create Circle",
        fields: [
            { label: "Radius", name: "radius", type: "number", default: 10 }
        ],
        generator: (vals) => `Circle(${vals.radius})`
    },
    bezier: {
        title: "Create Bezier Curve",
        fields: [
            { label: "Points (JSON array e.g. [[0,0],[5,5],[10,0]])", name: "points", type: "text", default: "[[0,0],[5,5],[10,0]]" }
        ],
        generator: (vals) => {
            try {
                const pts = JSON.parse(vals.points);
                const ptsStr = pts.map(p => `(${p[0]}, ${p[1]})`).join(', ');
                return `Bezier([${ptsStr}])`;
            } catch (e) {
                return `Bezier([(0, 0), (5, 5), (10, 0)])`;
            }
        }
    },
    polygon: {
        title: "Create Regular Polygon",
        fields: [
            { label: "Radius", name: "radius", type: "number", default: 10 },
            { label: "Number of Sides", name: "sides", type: "number", default: 6 }
        ],
        generator: (vals) => `RegularPolygon(radius=${vals.radius}, side_count=${vals.sides})`
    },
    box: {
        title: "Create 3D Box",
        fields: [
            { label: "Length (X)", name: "length", type: "number", default: 20 },
            { label: "Width (Y)", name: "width", type: "number", default: 20 },
            { label: "Height (Z)", name: "height", type: "number", default: 20 }
        ],
        generator: (vals) => `Box(${vals.length}, ${vals.width}, ${vals.height})`
    },
    "thick-solid": {
        title: "Create Thick Solid (Shell)",
        fields: [
            { label: "Thickness (negative for outer, positive for inner)", name: "thickness", type: "number", default: -2 }
        ],
        generator: (vals) => {
            const lookup = STATE.selectedFeature && STATE.selectedFeature.type === 'face'
                ? selectedFaceLookup()
                : null;
            if (lookup) {
                return `offset(amount=${vals.thickness}, openings=${lookup})`;
            }
            return `offset(amount=${vals.thickness})`;
        }
    },
    move: {
        title: "Translate Geometry",
        fields: [
            { label: "DX (X Offset)", name: "dx", type: "number", default: 10 },
            { label: "DY (Y Offset)", name: "dy", type: "number", default: 0 },
            { label: "DZ (Z Offset)", name: "dz", type: "number", default: 0 }
        ],
        generator: (vals) => `with Locations((${vals.dx}, ${vals.dy}, ${vals.dz})):`
    },
    rotate: {
        title: "Rotate Geometry",
        fields: [
            { label: "Axis (X, Y, Z)", name: "axis", type: "select", options: ["Z", "X", "Y"], default: "Z" },
            { label: "Angle (degrees)", name: "angle", type: "number", default: 45 }
        ],
        generator: (vals) => {
            if (vals.axis === 'X') return `with Locations(Rotation(${vals.angle}, 0, 0)):`;
            if (vals.axis === 'Y') return `with Locations(Rotation(0, ${vals.angle}, 0)):`;
            return `with Locations(Rotation(0, 0, ${vals.angle})):`;
        }
    },
    mirror: {
        title: "Mirror Geometry",
        fields: [
            { label: "Plane (XY, YZ, XZ)", name: "plane", type: "select", options: ["XY", "YZ", "XZ"], default: "XY" }
        ],
        generator: (vals) => `mirror(about=Plane.${vals.plane})`
    },
    offset: {
        title: "Offset Geometry",
        fields: [
            { label: "Amount", name: "amount", type: "number", default: 2 }
        ],
        generator: (vals) => `offset(amount=${vals.amount})`
    },
    delete: {
        title: "Subtract Selection",
        fields: [
            { label: "Extrusion depth to subtract", name: "depth", type: "number", default: 10 }
        ],
        generator: (vals) => {
            const lookup = STATE.selectedFeature && STATE.selectedFeature.type === 'face'
                ? selectedFaceLookup()
                : null;
            if (lookup) {
                return `# Subtracting selected face\nwith BuildSketch(${lookup}) as sketch:\n    # Inner geometry to subtract\n    pass\nextrude(amount=-${vals.depth}, mode=Mode.SUBTRACT)`;
            }
            return `# Define subtraction manually\nextrude(amount=-${vals.depth}, mode=Mode.SUBTRACT)`;
        }
    },
    break: {
        title: "Split Geometry",
        fields: [
            { label: "Split Plane (XY, YZ, XZ)", name: "plane", type: "select", options: ["XY", "YZ", "XZ"], default: "XY" }
        ],
        generator: (vals) => `split(keep=Keep.BOTH)`
    },
    trim: {
        title: "Trim Outline",
        fields: [],
        generator: () => `# Trim or edit sketch elements manually\n# sketch = sketch.clean()`
    },
    "to-wire": {
        title: "Convert to Wire",
        fields: [],
        generator: () => `wire = Wire(sketch.edges())`
    },
    "to-face": {
        title: "Convert to Face",
        fields: [],
        generator: () => `face = Face(sketch.outer_wire())`
    },
    prism: {
        title: "Prism (Extrude)",
        fields: [
            { label: "Extrude Amount", name: "amount", type: "number", default: 10 },
            { label: "Mode", name: "mode", type: "select", options: ["ADD", "SUBTRACT", "INTERSECT"], default: "ADD" }
        ],
        generator: (vals) => {
            const lookup = STATE.selectedFeature && STATE.selectedFeature.type === 'face'
                ? selectedFaceLookup()
                : null;
            if (lookup) {
                return `with BuildSketch(${lookup}) as sketch:\n    # Define sketch geometry here\n    pass\nextrude(amount=${vals.amount}, mode=Mode.${vals.mode})`;
            }
            return `extrude(amount=${vals.amount}, mode=Mode.${vals.mode})`;
        }
    },
    sweep: {
        title: "Sweep Along Path",
        fields: [],
        generator: () => `sweep(sections=sketch, path=path_wire)`
    },
    revol: {
        title: "Revolve Sketch",
        fields: [
            { label: "Revolve Axis (X, Y, Z)", name: "axis", type: "select", options: ["X", "Y", "Z"], default: "X" },
            { label: "Angle (degrees)", name: "angle", type: "number", default: 360 }
        ],
        generator: (vals) => `revolve(axis=Axis.${vals.axis}, revolution_arc=${vals.angle})`
    },
    common: {
        title: "Boolean Intersection",
        fields: [],
        generator: () => `mode=Mode.INTERSECT`
    },
    cut: {
        title: "Boolean Cut (Subtract)",
        fields: [],
        generator: () => `mode=Mode.SUBTRACT`
    },
    fuse: {
        title: "Boolean Fuse (Union)",
        fields: [],
        generator: () => `mode=Mode.ADD`
    },
    "set-workplane": {
        title: "Set Workplane",
        fields: [
            { label: "Plane / Axis", name: "plane", type: "select", options: ["XY", "YZ", "XZ"], default: "XY" }
        ],
        generator: (vals) => {
            const lookup = STATE.selectedFeature && STATE.selectedFeature.type === 'face'
                ? selectedFaceLookup()
                : null;
            if (lookup) {
                return `with BuildSketch(${lookup}) as sketch:`;
            }
            return `with BuildSketch(Plane.${vals.plane}) as sketch:`;
        }
    },
    "align-to-plane": {
        title: "Align to Plane",
        fields: [
            { label: "Target Plane", name: "plane", type: "select", options: ["XY", "YZ", "XZ"], default: "XY" }
        ],
        generator: (vals) => STATE.is2DMode
            ? `sketch = Plane.${vals.plane} * sketch`
            : `part = Plane.${vals.plane} * part`
    },
    section: {
        title: "Cross Section",
        fields: [
            { label: "Section Plane", name: "plane", type: "select", options: ["XZ", "XY", "YZ"], default: "XZ" }
        ],
        generator: (vals) => `section(section_by=Plane.${vals.plane})`
    },
    split: {
        title: "Split Body",
        fields: [
            { label: "Split Plane", name: "plane", type: "select", options: ["XY", "YZ", "XZ"], default: "XY" }
        ],
        generator: (vals) => `split(keep=Keep.BOTH)`
    }
};

let currentToolbarAction = null;

function initToolbar() {
    const toolbar = document.getElementById('cad-toolbar');
    if (!toolbar) return;

    toolbar.addEventListener('click', (e) => {
        const btn = e.target.closest('.toolbar-btn');
        if (!btn) return;

        const action = btn.getAttribute('data-action');
        handleToolbarAction(action);
    });

    // Close parameter modal events
    document.getElementById('close-param-modal-btn').addEventListener('click', closeParameterModal);
    document.getElementById('cancel-param-modal-btn').addEventListener('click', closeParameterModal);
    document.getElementById('apply-param-modal-btn').addEventListener('click', applyParameterModal);
}

function handleToolbarAction(action) {
    if (action === 'import') {
        const importChoice = confirm("Click OK to import STEP file, or Cancel to import DXF file.");
        triggerImportPicker(importChoice ? 'step' : 'dxf');
        return;
    }
    if (action === 'export') {
        const exportChoice = confirm("Click OK to export STEP file, or Cancel to export DXF file.");
        if (exportChoice) {
            exportStepFile();
        } else {
            exportDxfFile();
        }
        return;
    }

    const config = TOOLBAR_CONFIG[action];
    if (!config) return;

    currentToolbarAction = action;

    if (!config.fields || config.fields.length === 0) {
        const code = config.generator({});
        insertCodeAtCursor(code);
        return;
    }

    renderParameterForm(config);
}

function renderParameterForm(config) {
    const titleEl = document.getElementById('param-modal-title');
    titleEl.innerHTML = `<i class="fa-solid fa-sliders text-accent"></i> ${config.title}`;

    const container = document.getElementById('param-modal-fields');
    container.innerHTML = '';

    config.fields.forEach(field => {
        const group = document.createElement('div');
        group.className = 'param-form-group';

        const label = document.createElement('label');
        label.textContent = field.label;
        group.appendChild(label);

        if (field.type === 'select') {
            const select = document.createElement('select');
            select.name = field.name;
            field.options.forEach(opt => {
                const o = document.createElement('option');
                o.value = opt;
                o.textContent = opt;
                if (opt === field.default) o.selected = true;
                select.appendChild(o);
            });
            group.appendChild(select);
        } else {
            const input = document.createElement('input');
            input.type = field.type;
            input.name = field.name;
            input.value = field.default;
            group.appendChild(input);
        }

        container.appendChild(group);
    });

    document.getElementById('parameter-modal').classList.remove('hidden');
}

function closeParameterModal() {
    document.getElementById('parameter-modal').classList.add('hidden');
    currentToolbarAction = null;
}

function applyParameterModal() {
    if (!currentToolbarAction) return;

    const config = TOOLBAR_CONFIG[currentToolbarAction];
    if (!config) return;

    const vals = {};
    const container = document.getElementById('param-modal-fields');
    const inputs = container.querySelectorAll('input, select');
    inputs.forEach(input => {
        const val = input.value;
        const name = input.name;
        if (input.type === 'number') {
            vals[name] = parseFloat(val);
        } else {
            vals[name] = val;
        }
    });

    const code = config.generator(vals);
    insertCodeAtCursor(code);
    closeParameterModal();
}

const SKETCH_SNIPPET_RE = /^(Line|ThreePointArc|Rectangle|RectangleRounded|Circle|Bezier|RegularPolygon)\s*\(/;
const PART_SNIPPET_RE = /^(Box|extrude|sweep|revolve|section|split)\s*\(/;
const BUILDER_SNIPPET_RE = /^(offset|mirror|fillet|chamfer)\s*\(/;

function classifyToolbarSnippet(text) {
    const firstCodeLine = text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#')) || '';
    if (SKETCH_SNIPPET_RE.test(firstCodeLine)) return 'sketch';
    if (PART_SNIPPET_RE.test(firstCodeLine)) return 'part';
    if (BUILDER_SNIPPET_RE.test(firstCodeLine)) return 'builder';
    return 'other';
}

// Locates the last `with BuildSketch/BuildPart ...:` block matching headRe and
// returns where new body statements should go: the line after the block's last
// body line, at body indentation. Also reports a lone `pass` body so callers
// can replace it instead of leaving dead code.
function findBuilderBlockInsertion(model, headRe) {
    let head = null;
    for (let i = 1; i <= model.getLineCount(); i++) {
        const line = model.getLineContent(i);
        if (headRe.test(line)) {
            head = { line: i, indent: (line.match(/^\s*/) || [''])[0] };
        }
    }
    if (!head) return null;

    let lastBodyLine = head.line;
    for (let i = head.line + 1; i <= model.getLineCount(); i++) {
        const line = model.getLineContent(i);
        if (!line.trim()) continue;
        const indent = (line.match(/^\s*/) || [''])[0];
        if (indent.length > head.indent.length) {
            lastBodyLine = i;
        } else {
            break;
        }
    }

    const bodyIsLonePass = lastBodyLine !== head.line
        && model.getLineContent(lastBodyLine).trim() === 'pass';

    return {
        afterLine: lastBodyLine,
        indent: head.indent + '    ',
        passLine: bodyIsLonePass ? lastBodyLine : null
    };
}

function insertCodeAtCursor(text) {
    snapshotCurrentScript('insert toolbar snippet');

    const isBlockStart = text.trim().endsWith(':');

    if (!STATE.editor) {
        const fallback = isBlockStart ? text + '\n    pass' : text;
        STATE.currentScript = (STATE.currentScript || '') + '\n' + fallback;
        if (!isBlockStart) {
            runPythonCode(STATE.currentScript);
        }
        return;
    }

    const selection = STATE.editor.getSelection();
    const model = STATE.editor.getModel();
    const lineContent = model.getLineContent(selection.startLineNumber);
    const baseIndent = (lineContent.match(/^\s*/) || [''])[0];
    const cursorInsideBlock = baseIndent.length > 0;

    let range;
    let insertionText;

    if (cursorInsideBlock) {
        // The user deliberately placed the cursor inside a builder block:
        // insert right there, preserving the surrounding indentation.
        const prefix = lineContent.substring(0, selection.startColumn - 1);
        const suffix = lineContent.substring(selection.endColumn - 1);

        insertionText = text.replace(/\n/g, '\n' + baseIndent);
        if (prefix.trim() !== '') {
            insertionText = '\n' + baseIndent + insertionText;
        }
        if (isBlockStart) {
            insertionText += '\n' + baseIndent + '    pass';
        } else if (suffix.trim() !== '') {
            insertionText += '\n' + baseIndent;
        }

        range = new monaco.Range(
            selection.startLineNumber,
            selection.startColumn,
            selection.endLineNumber,
            selection.endColumn
        );
    } else {
        // Cursor is at top level (typical when clicking toolbar buttons from
        // the 3D viewport): place the snippet where it can actually execute.
        const kind = classifyToolbarSnippet(text);
        const headRe = kind === 'sketch' ? /^\s*with\s+BuildSketch\b.*:\s*$/
            : kind === 'part' ? /^\s*with\s+BuildPart\b.*:\s*$/
            : kind === 'builder' ? /^\s*with\s+Build(Sketch|Part|Line)\b.*:\s*$/
            : null;
        const target = headRe ? findBuilderBlockInsertion(model, headRe) : null;

        if (target) {
            insertionText = target.indent + text.replace(/\n/g, '\n' + target.indent);
            if (isBlockStart) {
                insertionText += '\n' + target.indent + '    pass';
            }
            if (target.passLine) {
                range = new monaco.Range(target.passLine, 1, target.passLine, model.getLineMaxColumn(target.passLine));
            } else {
                range = new monaco.Range(target.afterLine, model.getLineMaxColumn(target.afterLine), target.afterLine, model.getLineMaxColumn(target.afterLine));
                insertionText = '\n' + insertionText;
            }
        } else {
            // No matching builder block in the script (e.g. a DXF/STEP import
            // script): append a self-contained block that merges any existing
            // geometry and reassigns the variable the renderer displays.
            const scriptText = model.getValue();
            let block;
            if (kind === 'sketch') {
                const hasSketch = /^sketch\s*=/m.test(scriptText);
                block = '\nwith BuildSketch(Plane.XY) as toolbar_builder:\n'
                    + (hasSketch ? '    add(sketch)\n' : '')
                    + `    ${text.replace(/\n/g, '\n    ')}\n`
                    + 'sketch = toolbar_builder.sketch\n';
            } else if (kind === 'part') {
                const hasPart = /^part\s*=/m.test(scriptText);
                block = '\nwith BuildPart() as toolbar_builder:\n'
                    + (hasPart ? '    add(part)\n' : '')
                    + `    ${text.replace(/\n/g, '\n    ')}\n`
                    + 'part = toolbar_builder.part\n';
            } else {
                block = '\n' + text + (isBlockStart ? '\n    pass' : '') + '\n';
            }
            const lastLine = model.getLineCount();
            range = new monaco.Range(lastLine, model.getLineMaxColumn(lastLine), lastLine, model.getLineMaxColumn(lastLine));
            insertionText = block;
        }
    }

    const op = {
        identifier: { major: 1, minor: 1 },
        range: range,
        text: insertionText,
        forceMoveMarkers: true
    };
    STATE.editor.executeEdits("toolbar", [op]);

    const currentScript = STATE.editor.getValue();
    STATE.currentScript = currentScript;

    if (!isBlockStart) {
        runPythonCode(currentScript, { skipSnapshot: true });
    }

    appendConsoleLog(`Inserted CAD operation: ${text.split('\n')[0]}...\n`);
}
