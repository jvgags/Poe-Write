/* ========== POE WRITE APP.JS - DOCUMENT-BASED VERSION ========== */

// Global Variables
let projects = [];
let documents = [];
let folders = []; // { id, projectId, name, parentId, order, collapsed }
let settings = {
    theme: 'default',
    fontSize: 16,
    fontFamily: 'georgia',
    autoSaveInterval: 60000,
    lastProjectId: null,
    lastDocumentId: null,
    favoriteModels: [],
    customSystemPrompt: null,
    customUserPrompt: null,
    continueUserPrompt: null,
    goUserPrompt: null,
    lastUsedModel: 'anthropic/claude-3.5-sonnet',
    lastTemperature: 0.7,
    lastTokenCount: 2048,
    highlightColor: '#fff59d',
    customThemeColors: {},
    aiismsList: null
};

let currentProjectId = null;
let currentDocumentId = null;
let autoSaveTimer = null;
let hasUnsavedChanges = false;
let lastAiResponse = '';
let cmEditor = null; // CodeMirror editor instance
let currentEditorMode = 'markdown'; // 'markdown' or 'preview'
let draggedElement = null;

let apiKey = localStorage.getItem('openrouterApiKey');

// OpenRouter Models List - will be populated from API
let OPENROUTER_MODELS = [];
let modelsLoaded = false;

let isStreaming = false;
let streamingInterval = null;
let generatedTextStartIndex = null;
let generatedTextLength = 0;
let chatHistory = [];
let lastSearchIndex = 0;
let searchMarkers = []; // Store search highlight markers

// IndexedDB Setup
const DB_NAME = 'AINovelWriterDB';
const DB_VERSION = 3;
const STORE_NAME = 'data';
let db;

/* ========== CODEMIRROR HELPER FUNCTIONS ========== */

// Editor Mode Switching
function switchEditorMode(mode) {
    currentEditorMode = mode;
    const editorDiv = document.getElementById('editor');
    const previewDiv = document.getElementById('preview');
    const markdownToggle = document.getElementById('markdownToggle');
    const previewToggle = document.getElementById('previewToggle');
    
    if (mode === 'markdown') {
        editorDiv.style.display = 'flex';
        previewDiv.style.display = 'none';
        if (markdownToggle) markdownToggle.classList.add('active');
        if (previewToggle) previewToggle.classList.remove('active');
        if (cmEditor) cmEditor.refresh();
    } else {
        editorDiv.style.display = 'none';
        previewDiv.style.display = 'block';
        if (markdownToggle) markdownToggle.classList.remove('active');
        if (previewToggle) previewToggle.classList.add('active');
        updatePreview();
    }
}

// Toggle between markdown and preview (kept for backwards compatibility)
function togglePreview() {
    if (currentEditorMode === 'markdown') {
        switchEditorMode('preview');
    } else {
        switchEditorMode('markdown');
    }
}

// Flag to prevent feedback loop when we programmatically update preview innerHTML
let _previewUpdating = false;

// Update markdown preview
function updatePreview() {
    let markdown = cmEditor.getValue();
    
    // Get the current highlight color
    const highlightColor = settings.highlightColor || '#fff59d';
    
    // Convert ==highlight== to <mark>highlight</mark> with custom color before parsing
    markdown = markdown.replace(/==([^=]+)==/g, `<mark style="background-color: ${highlightColor};">$1</mark>`);
    
    const html = marked.parse(markdown);
    const clean = DOMPurify.sanitize(html);
    
    _previewUpdating = true;
    document.getElementById('preview').innerHTML = clean;
    _previewUpdating = false;

    // Apply AI-ism squiggles to the rendered preview
    applyPreviewAIismHighlights();
}

// Initialize editable preview — called once after DOM ready
function initEditablePreview() {
    const previewDiv = document.getElementById('preview');
    if (!previewDiv) return;

    // Make it editable
    previewDiv.contentEditable = 'true';
    previewDiv.spellcheck = true;

    let _previewSyncTimer = null;

    previewDiv.addEventListener('input', () => {
        // Ignore programmatic updates
        if (_previewUpdating) return;

        clearTimeout(_previewSyncTimer);
        _previewSyncTimer = setTimeout(() => {
            // Convert preview HTML → markdown and push to CodeMirror
            const html = previewDiv.innerHTML;
            const md = htmlToMarkdown(html);

            _previewUpdating = true;
            const scrollInfo = cmEditor.getScrollInfo();
            cmEditor.setValue(md);
            cmEditor.scrollTo(scrollInfo.left, scrollInfo.top);
            hasUnsavedChanges = true;
            updateWordCount();
            resetAutoSaveTimer();
            _previewUpdating = false;
        }, 400);
    });

    // Escape key exits preview mode back to markdown
    previewDiv.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            switchEditorMode('markdown');
        }
    });
}

// Get editor text
function getEditorText() {
    return cmEditor.getValue();
}

// Set editor text
function setEditorText(text) {
    cmEditor.setValue(text);
}

// Get editor selection
function getEditorSelection() {
    return cmEditor.getSelection();
}

// Insert text at cursor
function insertTextAtCursor(text) {
    cmEditor.replaceSelection(text);
}

// Get cursor position
function getCursorPosition() {
    return cmEditor.getCursor();
}

// Set cursor position
function setCursorPosition(line, ch) {
    cmEditor.setCursor({line: line, ch: ch});
}

// Get text before cursor
function getTextBeforeCursor() {
    const cursor = cmEditor.getCursor();
    return cmEditor.getRange({line: 0, ch: 0}, cursor);
}

// Get text from position to end
function getTextFromPosition(pos) {
    const lastLine = cmEditor.lastLine();
    const lastCh = cmEditor.getLine(lastLine).length;
    return cmEditor.getRange(pos, {line: lastLine, ch: lastCh});
}

// Count words in editor
function countEditorWords() {
    const text = cmEditor.getValue();
    return countWords(text);
}

// Clear editor
function clearEditorContent() {
    cmEditor.setValue('');
}

// Get character position (index) from line/ch
function getCharacterIndex(pos) {
    return cmEditor.indexFromPos(pos);
}

// Get line/ch from character position
function getPositionFromIndex(index) {
    return cmEditor.posFromIndex(index);
}

// Focus editor
function focusEditor() {
    cmEditor.focus();
}

// Scroll to position
function scrollToPosition(pos) {
    cmEditor.scrollIntoView(pos);
}

// Get line count
function getLineCount() {
    return cmEditor.lineCount();
}

// Apply theme to CodeMirror
function applyCMTheme(theme) {
    const themeMap = {
        'default': 'default',
        'dark': 'monokai',
        'sepia': 'default',
        'nord': 'material',
        'dracula': 'dracula'
    };
    cmEditor.setOption('theme', themeMap[theme] || 'default');
}

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (e) => {
            db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };

        request.onsuccess = (e) => {
            db = e.target.result;
            resolve(db);
        };

        request.onerror = (e) => {
            console.error('IndexedDB error:', e.target.error);
            showToast('Database error. Data may not save.');
            reject(e);
        };
    });
}

async function saveToDB(id, data) {
    if (!db) await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({ id, value: data });
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e);
    });
}

async function loadFromDB(id) {
    if (!db) await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).get(id);
        request.onsuccess = () => resolve(request.result ? request.result.value : null);
        request.onerror = (e) => reject(e);
    });
}

/* ========== INITIALIZATION ========== */

window.onload = async function() {
    try {
        await openDB();
        await loadData();
    } catch (e) {
        showToast('Failed to open database.');
    }

    // Ensure localStorage is synced with the loaded database settings
    if (settings.theme) {
        localStorage.setItem('poeTheme', settings.theme);
    }

    // Initialize CodeMirror Editor
    cmEditor = CodeMirror(document.getElementById('editor'), {
        mode: 'markdown',
        theme: 'default',
        lineNumbers: false,
        lineWrapping: true,
        autofocus: true,
        inputStyle: 'contenteditable', // Enables browser spellcheck and potentially Grammarly
        spellcheck: true, // Enable browser spellcheck
        placeholder: 'Select a document from the sidebar to start writing...',
        extraKeys: {
            'Tab': function(cm) {
                const cursor = cm.getCursor();
                const line = cm.getLine(cursor.line);
                const textBeforeCursor = line.substring(0, cursor.ch);
                const wordCount = textBeforeCursor.trim().split(/\s+/).filter(w => w.length > 0).length;
                
                // Only trigger AI continue if there's substantial text (>8 words)
                if (wordCount > 8) {
                    continueFromCursor();
                } else {
                    // Default tab behavior for short text
                    cm.replaceSelection('    ');
                }
            },
            'Ctrl-Enter': function(cm) {
                continueFromCursor();
            },
            'Cmd-Enter': function(cm) {
                continueFromCursor();
            },
            'Ctrl-S': function(cm) {
                saveDocument();
                return false;
            },
            'Cmd-S': function(cm) {
                saveDocument();
                return false;
            },
            'Ctrl-B': function(cm) {
                insertMarkdown('bold');
                return false;
            },
            'Cmd-B': function(cm) {
                insertMarkdown('bold');
                return false;
            },
            'Ctrl-I': function(cm) {
                insertMarkdown('italic');
                return false;
            },
            'Cmd-I': function(cm) {
                insertMarkdown('italic');
                return false;
            },
            'Ctrl-F': function(cm) {
                toggleSearchReplace();
                return false;
            },
            'Cmd-F': function(cm) {
                toggleSearchReplace();
                return false;
            },
            'Enter': 'newlineAndIndentContinueMarkdownList'
        }
    });

    // CodeMirror change listener
    cmEditor.on('change', () => {
        hasUnsavedChanges = true;
        updateWordCount();
        resetAutoSaveTimer();
        
        // Update floating continue button after typing
        setTimeout(updateFloatingContinueButton, 100);
        
        // Refresh AI-ism highlights if this is a Chapter document
        const currentDoc = documents.find(d => d.id === currentDocumentId);
        if (currentDoc && currentDoc.type === 'Chapter') {
            setTimeout(refreshAIismHighlights, 150);
        }

        // Update right sidebar (debounced)
        clearTimeout(window._rightSidebarTimer);
        window._rightSidebarTimer = setTimeout(updateRightSidebar, 500);
    });

    // Selection change listener for floating button
    cmEditor.on('cursorActivity', () => {
        updateFloatingContinueButton();
    });

    // Apply font size to CodeMirror
    const editorElement = document.querySelector('.CodeMirror');
    if (editorElement) {
        editorElement.style.fontSize = settings.fontSize + 'px';
    }

    // Hide floating button when clicking elsewhere
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#floatingContinueBtn') && 
            !e.target.closest('#floatingGoBtn') && 
            !e.target.closest('.CodeMirror')) {
            hideFloatingContinueButton();
        }
    });

    // Enter key in improve instructions
    const improveInput = document.getElementById('improveInstructions');
    if (improveInput) {
        improveInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                executeImprove();
            }
        });
    }

    // Check API key
    if (!apiKey || apiKey === 'null') {
        if (apiKey === 'null') {
            localStorage.removeItem('openrouterApiKey');
            apiKey = null;
        }
        document.getElementById('apiKeyModal').style.display = 'flex';
        document.getElementById('apiKeyInput').focus();
    }

    // Update UI
    updateProjectsList();
    updateProjectDropdown();
    updateDocumentsList();
    updateWordCount();
    await fetchOpenRouterModels();
    populateModelSelect();

    // Restore saved AI settings
    document.getElementById('modelSelect').value = settings.lastUsedModel;
    document.getElementById('temperature').value = settings.lastTemperature;
    document.getElementById('temperatureValue').textContent = settings.lastTemperature;
    document.getElementById('tokensToGenerate').value = settings.lastTokenCount;

    // Menu toggle
    document.getElementById('hamburger').addEventListener('click', toggleMenu);
    document.getElementById('menuOverlay').addEventListener('click', closeMenu);

    // Initialize highlight color picker
    const colorPicker = document.getElementById('highlightColorPicker');
    if (colorPicker) {
        colorPicker.value = settings.highlightColor || '#fff59d';
        colorPicker.addEventListener('change', (e) => {
            settings.highlightColor = e.target.value;
            saveSettings();
            refreshHighlightMarkers();
            if (currentEditorMode === 'preview') {
                updatePreviewHighlightColors(e.target.value);
            }
        });
    }

    // Debounced highlight refresh on content changes
    let highlightRefreshTimer = null;
    cmEditor.on('change', () => {
        clearTimeout(highlightRefreshTimer);
        highlightRefreshTimer = setTimeout(refreshHighlightMarkers, 150);
    });
    
    // Initial highlight markers rendering
    refreshHighlightMarkers();


    // Temperature slider
    const tempSlider = document.getElementById('temperature');
    tempSlider.addEventListener('input', (e) => {
        const val = e.target.value;
        document.getElementById('temperatureValue').textContent = val;
        settings.lastTemperature = parseFloat(val);
        autoSave();
    });

    // Tokens select change
    document.getElementById('tokensToGenerate').addEventListener('change', (e) => {
        settings.lastTokenCount = parseInt(e.target.value);
        autoSave();
    });

    // Model select change
    document.getElementById('modelSelect').addEventListener('change', (e) => {
        settings.lastUsedModel = e.target.value;
        autoSave();
        updateFavoriteButton();
    });

    // Apply settings
    applyTheme(settings.theme);
    document.getElementById('themeSelect').value = settings.theme;
    document.getElementById('fontSizeSelect').value = settings.fontSize;
    document.getElementById('fontFamilySelect').value = settings.fontFamily || 'georgia';
    document.getElementById('autoSaveInterval').value = settings.autoSaveInterval;
    
    // Apply font settings
    applyFontSettings(settings.fontSize, settings.fontFamily);

    // Restore last open project/document
    if (settings.lastProjectId && settings.lastDocumentId) {
        currentProjectId = settings.lastProjectId;
        currentDocumentId = settings.lastDocumentId;
        loadDocumentToEditor();
    }

     // Load chat history
    loadChatHistory();

    // Enter key in chat input
    const chatInput = document.getElementById('chatInput');
    if (chatInput) {
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage();
            }
        });
    }

    initializeFloatingToolbarVisibility();

    // Initialize editable preview
    initEditablePreview();
};

/* ========== API KEY MANAGEMENT ========== */

function setApiKey() {
    const input = document.getElementById('apiKeyInput');
    const key = input.value.trim();
    
    if (!key) {
        showToast('Please enter a valid API key');
        input.focus();
        return;
    }
    
    // Save to both global variable and localStorage
    apiKey = key;
    localStorage.setItem('openrouterApiKey', apiKey);
    
    // Close the modal
    document.getElementById('apiKeyModal').style.display = 'none';
    
    showToast('API key saved successfully! ✅');
    
    // Fetch models now that we have an API key
    if (!modelsLoaded) {
        fetchOpenRouterModels();
    }
}

function skipApiKey() {
    document.getElementById('apiKeyModal').style.display = 'none';
    showToast('You can add an API key later in Settings');
}

function updateApiKey() {
    const key = document.getElementById('settingsApiKey').value.trim();
    if (!key) {
        showToast('Please enter a valid API key');
        return;
    }
    
    // Save to both global variable and localStorage
    apiKey = key;
    localStorage.setItem('openrouterApiKey', apiKey);
    
    // Clear the input field
    document.getElementById('settingsApiKey').value = '';
    
    // Update placeholder to show masked key
    document.getElementById('settingsApiKey').placeholder = '••••••••' + apiKey.slice(-8);
    
    showToast('API key updated! ✅');
    
    // Refresh models list if needed
    if (!modelsLoaded) {
        fetchOpenRouterModels();
    }
}

/* ========== DATA PERSISTENCE ========== */

async function autoSave() {
    const data = {
        projects,
        documents,
        folders,
        settings,
        chatHistory,
        version: '3.0',
        timestamp: new Date().toISOString()
    };
    const encrypted = CryptoJS.AES.encrypt(JSON.stringify(data), 'poe-secret-key-2025').toString();
    try {
        await saveToDB('PoeData', encrypted);
    } catch (e) {
        showToast('Auto-save failed.');
    }
}

async function loadData() {
    let encrypted = null;
    try {
        encrypted = await loadFromDB('PoeData');
    } catch (e) {
        console.error('Load failed:', e);
    }

    let savedData = null;
    if (encrypted) {
        try {
            const decrypted = CryptoJS.AES.decrypt(encrypted, 'poe-secret-key-2025').toString(CryptoJS.enc.Utf8);
            savedData = JSON.parse(decrypted);
        } catch (e) {
            showToast('Could not load saved data');
        }
    }

    projects = savedData?.projects || [];
    documents = savedData?.documents || [];
    folders = savedData?.folders || [];
    settings = { ...settings, ...(savedData?.settings || {}) };
    chatHistory = savedData?.chatHistory || [];
}

/* ========== BACKUP & RESTORE ========== */

async function createBackup() {
    try {
        const data = {
            projects,
            documents,
            folders,
            settings,
            chatHistory,
            version: '3.0',
            timestamp: new Date().toISOString()
        };

        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        
        const date = new Date().toISOString().slice(0, 10);
        a.download = `PoeWrite_Backup_${date}.poe`;
        
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast('Backup created successfully!');
    } catch (err) {
        console.error('Backup failed:', err);
        showToast('Backup failed. Check console.');
    }
}

async function restoreFromBackup(file) {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const data = JSON.parse(e.target.result);

            projects = data.projects || [];
            documents = data.documents || [];
            folders = data.folders || [];
            settings = { ...settings, ...(data.settings || {}) };
            chatHistory = data.chatHistory || [];

            // Sync imported theme to localStorage
            if (settings.theme) {
                localStorage.setItem('poeTheme', settings.theme);
            }

            await autoSave();

            updateProjectsList();
            updateProjectDropdown();
            updateDocumentsList();
            loadChatHistory();
            
            document.getElementById('themeSelect').value = settings.theme || 'default';
            applyTheme(settings.theme || 'default');

            showToast('Restore complete!');
            closeMenu();
        } catch (err) {
            console.error('Restore failed:', err);
            showToast('Restore failed. Invalid file.');
        }
    };

    reader.readAsText(file);
}

/* ========== PROJECT MANAGEMENT ========== */

function openNewProjectModal() {
    document.getElementById('newProjectModal').style.display = 'flex';
    document.getElementById('newProjectTitle').focus();
}

function closeNewProjectModal() {
    document.getElementById('newProjectModal').style.display = 'none';
    document.getElementById('newProjectForm').reset();
}

function createProject(event) {
    event.preventDefault();

    const project = {
        id: Date.now(),
        title: document.getElementById('newProjectTitle').value.trim(),
        genre: document.getElementById('newProjectGenre').value,
        description: document.getElementById('newProjectDescription').value.trim(),
        targetWordCount: parseInt(document.getElementById('newProjectWordCount').value) || 0,
        currentWordCount: 0,
        created: new Date().toISOString(),
        updated: new Date().toISOString()
    };

    projects.push(project);
    autoSave();
    updateProjectsList();
    updateProjectDropdown();
    closeNewProjectModal();
    showToast(`Project "${project.title}" created!`);
}

function deleteProject(id) {
    const project = projects.find(p => p.id === id);
    if (!project) return;

    if (!confirm(`Delete project "${project.title}" and all its documents?`)) return;

    projects = projects.filter(p => p.id !== id);
    documents = documents.filter(d => d.projectId !== id);
    folders = folders.filter(f => f.projectId !== id);

    if (currentProjectId === id) {
        currentProjectId = null;
        currentDocumentId = null;
        document.getElementById('editor').value = '';
        document.getElementById('documentInfo').style.display = 'none';
    }

    autoSave();
    updateProjectsList();
    updateProjectDropdown();
    updateDocumentsList();
    showToast('Project deleted');
}

// app.js

function switchProject() {
    const projectId = parseInt(document.getElementById('projectSelect').value);
    
    // 1. Clear the Editor correctly (CodeMirror method)
    if (cmEditor) {
        cmEditor.setValue(""); // This actually clears the text
    }

    // 2. Hide the Document Info Header
    const docInfo = document.getElementById('documentInfo');
    if (docInfo) {
        docInfo.style.display = 'none';
    }

    // 3. Reset Current Document State
    currentDocumentId = null;
    settings.lastDocumentId = null; // Also clear the saved preference

    // 4. Handle "No Project Selected" or "New Project" logic
    if (!projectId) {
        currentProjectId = null;
        settings.lastProjectId = null;
    } else {
        currentProjectId = projectId;
        settings.lastProjectId = projectId;
    }

    // 5. Refresh Data & UI
    autoSave();
    updateDocumentsList();
    updateMasterToggleState();
}

function updateProjectDropdown() {
    const select = document.getElementById('projectSelect');
    select.innerHTML = '<option value="">No Project Selected</option>';
    
    projects.forEach(project => {
        const option = document.createElement('option');
        option.value = project.id;
        option.textContent = project.title;
        if (project.id === currentProjectId) {
            option.selected = true;
        }
        select.appendChild(option);
    });
}

function updateProjectsList() {
    const container = document.getElementById('projectsList');
    if (!container) return;
    
    if (projects.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:#999; padding:40px;">No projects yet. Create one to get started!</p>';
        return;
    }

    // Ensure all projects have an order
    projects.forEach((project, index) => {
        if (project.order === undefined) {
            project.order = index;
        }
    });

    // Sort by order
    const sortedProjects = [...projects].sort((a, b) => (a.order || 0) - (b.order || 0));

    container.innerHTML = sortedProjects.map(project => {
        const projectDocs = documents.filter(d => d.projectId === project.id);
        
        // UPDATED: Count only Chapter documents
        const chapterDocs = projectDocs.filter(d => d.type === 'Chapter');
        const totalChapterWords = chapterDocs.reduce((sum, doc) => sum + (doc.wordCount || 0), 0);
        
        // Also count all document types for reference
        const totalAllWords = projectDocs.reduce((sum, doc) => sum + (doc.wordCount || 0), 0);
        
        project.currentWordCount = totalChapterWords;

        return `
            <div class="project-card" 
                 draggable="true" 
                 data-project-id="${project.id}"
                 ondragstart="handleProjectDragStart(event)"
                 ondragover="handleProjectDragOver(event)"
                 ondrop="handleProjectDrop(event)"
                 ondragend="handleProjectDragEnd(event)">
                <div class="project-header">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <div class="drag-handle" title="Drag to reorder">⋮⋮</div>
                        <div>
                            <h3>${project.title}</h3>
                            <span class="genre-badge">${project.genre}</span>
                        </div>
                    </div>
                    <div class="project-actions">
                        <button class="icon-btn" onclick="openEditProjectModal(${project.id})" title="Edit Project">✏️</button>
                        <button class="icon-btn" onclick="copyProject(${project.id})" title="Copy Project">📋</button>
                        <button class="icon-btn" onclick="viewProjectDocuments(${project.id})" title="View Documents">📄</button>
                        <button class="icon-btn delete-icon" onclick="deleteProject(${project.id})" title="Delete">🗑️</button>
                    </div>
                </div>
                ${project.description ? `<p class="project-description">${project.description}</p>` : ''}
                <div class="project-stats">
                    <div class="stat">
                        <span class="stat-label">Documents:</span>
                        <span class="stat-value">${projectDocs.length}</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">Chapter Words:</span>
                        <span class="stat-value">${totalChapterWords.toLocaleString()}</span>
                    </div>
                    ${project.targetWordCount > 0 ? `
                        <div class="stat">
                            <span class="stat-label">Target:</span>
                            <span class="stat-value">${project.targetWordCount.toLocaleString()}</span>
                        </div>
                        <div class="stat">
                            <span class="stat-label">Progress:</span>
                            <span class="stat-value">${Math.round((totalChapterWords / project.targetWordCount) * 100)}%</span>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');
}

function viewProjectDocuments(projectId) {
    // 1. Set the new project
    currentProjectId = projectId;
    document.getElementById('projectSelect').value = projectId;
    
    // 2. CLEAR PREVIOUS DOCUMENT STATE
    currentDocumentId = null;
    settings.lastDocumentId = null;
    
    // 3. Hide the Document Header initially
    const docInfo = document.getElementById('documentInfo');
    if (docInfo) {
        docInfo.style.display = 'none';
    }

    // 4. Clear the Editor Content initially
    if (cmEditor) {
        cmEditor.setValue("");
    }
    
    // 5. Switch to Write Tab
    switchTab('write');
    
    // 6. Refresh Lists
    updateDocumentsList();
    
    // 7. NEW: Auto-open first document if any exist
    const projectDocs = documents
        .filter(d => d.projectId === projectId)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
    
    if (projectDocs.length > 0) {
        // Open the first document in the list
        const firstDoc = projectDocs[0];
        setTimeout(() => {
            openDocumentInEditor(firstDoc.id);
        }, 100); // Small delay to ensure UI is ready
    }
    
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ========== DOCUMENT MANAGEMENT ========== */

function openNewDocumentModal() {
    if (!currentProjectId) {
        showToast('Please select a project first');
        return;
    }
    document.getElementById('documentModalTitle').textContent = 'Create New Document';
    document.getElementById('newDocumentModal').style.display = 'flex';
    document.getElementById('newDocumentTitle').focus();
}

function closeNewDocumentModal() {
    document.getElementById('newDocumentModal').style.display = 'none';
    document.getElementById('newDocumentForm').reset();
    const folderField = document.getElementById('newDocumentFolderId');
    if (folderField) folderField.value = '';
}

function createDocument(event) {
    event.preventDefault();

    if (!currentProjectId) {
        showToast('Please select a project first');
        return;
    }

    const folderIdVal = document.getElementById('newDocumentFolderId') ? document.getElementById('newDocumentFolderId').value : '';
    const folderId = folderIdVal ? parseInt(folderIdVal) : null;

    const projectDocs = documents.filter(d => d.projectId === currentProjectId && (d.folderId || null) === folderId);
    const maxOrder = projectDocs.length > 0 ? Math.max(...projectDocs.map(d => d.order || 0)) : -1;

    const doc = {
        id: Date.now(),
        projectId: currentProjectId,
        title: document.getElementById('newDocumentTitle').value.trim(),
        type: document.getElementById('newDocumentType').value,
        content: '',
        wordCount: 0,
        enabled: true,
        folderId: folderId,
        order: maxOrder + 1,
        created: new Date().toISOString(),
        updated: new Date().toISOString()
    };

    documents.push(doc);
    autoSave();
    updateDocumentsList();
    updateProjectsList();
    closeNewDocumentModal();

    openDocumentInEditor(doc.id);

    setTimeout(() => {
        if (cmEditor) {
            cmEditor.setCursor(0, 0);
            cmEditor.focus();
            
            // Also scroll to top
            const cmContainer = document.querySelector('.CodeMirror-scroll');
            if (cmContainer) {
                cmContainer.scrollTop = 0;
            }
        }
    }, 100);

    showToast(`Document "${doc.title}" created!`);
    
}

function deleteDocument(id) {
    const doc = documents.find(d => d.id === id);
    if (!doc) return;

    if (!confirm(`Delete document "${doc.title}"?`)) return;

    documents = documents.filter(d => d.id !== id);

    if (currentDocumentId === id) {
        currentDocumentId = null;
        document.getElementById('editor').value = '';
        document.getElementById('documentInfo').style.display = 'none';
    }

    autoSave();
    updateDocumentsList();
    updateProjectsList();
    showToast('Document deleted');
}

function duplicateDocument(id) {
    const doc = documents.find(d => d.id === id);
    if (!doc) return;

    // Create a new document with copied properties
    const newDoc = {
        id: Date.now(),
        projectId: doc.projectId,
        title: `${doc.title} (Copy)`,
        type: doc.type,
        content: doc.content,
        wordCount: doc.wordCount,
        enabled: doc.enabled,
        folderId: doc.folderId || null,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        order: doc.order + 0.5 // Place it right after the original
    };

    documents.push(newDoc);
    
    // Reindex order values
    const projectDocs = documents.filter(d => d.projectId === doc.projectId);
    projectDocs.sort((a, b) => a.order - b.order);
    projectDocs.forEach((d, index) => {
        d.order = index;
    });

    autoSave();
    updateDocumentsList();
    updateProjectsList();
    showToast(`Document duplicated! 📋`);
}

function toggleDocument(id) {
    const doc = documents.find(d => d.id === id);
    if (!doc) return;

    doc.enabled = !doc.enabled;
    autoSave();
    updateDocumentsList();
}

function openDocumentInEditor(docId) {
    // Save current document before switching
    if (currentDocumentId && hasUnsavedChanges) {
        saveDocument(false);
    }

    currentDocumentId = docId;
    settings.lastDocumentId = docId;
    autoSave();
    loadDocumentToEditor();
}

function loadDocumentToEditor() {
    const doc = documents.find(d => d.id === currentDocumentId);
    if (!doc) return;

    let content = doc.content || "";
    
    // Auto-convert HTML to Markdown if detected (preserves formatting)
    if (content.includes('<') && content.includes('>')) {
        content = htmlToMarkdown(content);
        
        // Auto-save the converted content
        doc.content = content;
        autoSave();
        
        console.log('Converted HTML document to Markdown');
    }
    
    // Load content into editor
    cmEditor.setValue(content);
    cmEditor.setCursor(0, 0);

    document.getElementById('documentTitle').textContent = doc.title;
    document.getElementById('documentType').textContent = doc.type;
    document.getElementById('documentWordCount').textContent = `${doc.wordCount || 0} words`;
    document.getElementById('documentInfo').style.display = 'block';
    
    // Update dropdowns
    document.getElementById('projectSelect').value = doc.projectId;
    currentProjectId = doc.projectId;
    
    hasUnsavedChanges = false;
    updateWordCount();
    updateDocumentsList();
    
    // Refresh highlight markers after content loads
    setTimeout(refreshHighlightMarkers, 50);
    
    // Refresh AI-ism highlights if this is a Chapter document
    if (doc.type === 'Chapter') {
        setTimeout(refreshAIismHighlights, 50);
    }
    
    // Update preview if in preview mode
    if (currentEditorMode === 'preview') {
        updatePreview();
    }

    // Update right sidebar
    setTimeout(updateRightSidebar, 100);
}

function saveDocument(showNotification = true) {
    if (!currentDocumentId) {
        if (showNotification) {
            showToast('No document selected');
        }
        return;
    }

    const doc = documents.find(d => d.id === currentDocumentId);
    if (!doc) return;

    doc.content = cmEditor.getValue();
    doc.wordCount = countWords(cmEditor.getValue());
    doc.updated = new Date().toISOString();

    autoSave();
    hasUnsavedChanges = false;
    
    if (showNotification) {
        showToast('Document saved! 💾');
    }
    
    updateWordCount();
    updateProjectsList();
    updateDocumentsList();
}

function clearEditor() {
    if (!confirm('Clear the editor? Unsaved changes will be lost.')) return;
    cmEditor.setValue("");
    hasUnsavedChanges = false;
    updateWordCount();
}


// Replace the updateDocumentsList() function with this version that includes an Edit button

/* ========== FOLDER-AWARE DOCUMENT LIST ========== */

// State for the current drag operation (shared for docs and folders)
let _dragType = null;   // 'doc' | 'folder'
let _dragId   = null;   // id of the item being dragged

function updateDocumentsList() {
    const container = document.getElementById('documentsList');

    if (!currentProjectId) {
        container.innerHTML = '<p style="text-align:center; color:#999; padding:20px;">Select a project to manage documents</p>';
        return;
    }

    let projectDocs = documents.filter(d => d.projectId === currentProjectId);

    if (projectDocs.length === 0 && folders.filter(f => f.projectId === currentProjectId).length === 0) {
        container.innerHTML = '<p style="text-align:center; color:#999; padding:20px;">No documents yet. Create one to get started!</p>';
        updateMasterToggleState();
        return;
    }

    // Ensure order fields exist
    projectDocs.forEach((doc, i) => { if (doc.order === undefined) doc.order = i; });
    folders.filter(f => f.projectId === currentProjectId)
           .forEach((f, i) => { if (f.order === undefined) f.order = i; });

    container.innerHTML = renderFolderLevel(null, 0);
    updateMasterToggleState();
}

// Render one level of the tree (parentId = null → top level)
function renderFolderLevel(parentId, depth) {
    const indent = depth * 14;
    let html = '';

    // Folders at this level
    const levelFolders = folders
        .filter(f => f.projectId === currentProjectId && (f.parentId || null) === parentId)
        .sort((a, b) => (a.order || 0) - (b.order || 0));

    // Docs at this level
    const levelDocs = documents
        .filter(d => d.projectId === currentProjectId && (d.folderId || null) === parentId)
        .sort((a, b) => (a.order || 0) - (b.order || 0));

    // Render folders first
    levelFolders.forEach(folder => {
        const collapsed = folder.collapsed || false;
        const childDocs = documents.filter(d => d.projectId === currentProjectId && (d.folderId || null) === folder.id);
        const childFolders = folders.filter(f => f.projectId === currentProjectId && (f.parentId || null) === folder.id);
        const hasChildren = childDocs.length > 0 || childFolders.length > 0;

        html += `
        <div class="folder-row"
             data-folder-id="${folder.id}"
             draggable="true"
             ondragstart="handleFolderDragStart(event, ${folder.id})"
             ondragover="handleTreeDragOver(event)"
             ondrop="handleTreeDrop(event)"
             ondragend="handleTreeDragEnd(event)"
             style="padding-left: ${indent + 4}px">
            <div class="folder-row-inner">
                <span class="drag-handle folder-drag-handle" title="Drag folder">⋮⋮</span>
                <button class="folder-collapse-btn" onclick="toggleFolderCollapse(${folder.id})" title="${collapsed ? 'Expand' : 'Collapse'}">
                    ${collapsed ? '▶' : '▼'}
                </button>
                <span class="folder-icon">📁</span>
                <span class="folder-name" ondblclick="startFolderRename(${folder.id})" title="Double-click to rename">${escapeHtml(folder.name)}</span>
                <div class="folder-actions">
                    <button class="icon-btn" onclick="event.stopPropagation(); openNewDocumentInFolder(${folder.id})" title="New document here">➕</button>
                    <button class="icon-btn" onclick="event.stopPropagation(); openNewSubfolderModal(${folder.id})" title="New subfolder">📁</button>
                    <button class="icon-btn" onclick="event.stopPropagation(); startFolderRename(${folder.id})" title="Rename">✏️</button>
                    <button class="icon-btn delete-icon" onclick="event.stopPropagation(); deleteFolder(${folder.id})" title="Delete folder">🗑️</button>
                </div>
            </div>
            <div class="folder-drop-zone ${collapsed ? 'hidden' : ''}" 
                 data-folder-id="${folder.id}"
                 ondragover="handleFolderDropZoneOver(event)"
                 ondrop="handleFolderDropZoneDrop(event, ${folder.id})">
            </div>
        </div>`;

        if (!collapsed) {
            html += renderFolderLevel(folder.id, depth + 1);
        }
    });

    // Render documents at this level
    levelDocs.forEach(doc => {
        const isActive = doc.id === currentDocumentId;
        html += `
        <div class="document-card ${doc.enabled ? 'enabled' : 'disabled'} ${isActive ? 'active-doc' : ''}"
             draggable="true"
             data-doc-id="${doc.id}"
             data-folder-id="${doc.folderId || ''}"
             ondragstart="handleDocDragStart(event, ${doc.id})"
             ondragover="handleTreeDragOver(event)"
             ondrop="handleTreeDrop(event)"
             ondragend="handleTreeDragEnd(event)"
             onclick="openDocumentInEditor(${doc.id})"
             style="padding-left: ${indent + 8}px; margin-left: 0;">
            <div class="document-header">
                <div class="drag-handle" title="Drag to reorder">⋮⋮</div>
                <div class="document-title">
                    <h4 title="${escapeHtml(doc.title)}"><span class="doc-type-icon">${getTypeIcon(doc.type)}</span> ${escapeHtml(doc.title)}</h4>
                </div>
                <div class="document-actions">
                    <button class="icon-btn" onclick="event.stopPropagation(); duplicateDocument(${doc.id})" title="Duplicate">📋</button>
                    <button class="icon-btn" onclick="event.stopPropagation(); openEditDocumentModal(${doc.id})" title="Edit">✏️</button>
                    <button class="icon-btn delete-icon" onclick="event.stopPropagation(); deleteDocument(${doc.id})" title="Delete">🗑️</button>
                </div>
            </div>
            <div class="document-footer">
                <label class="toggle-container" onclick="event.stopPropagation();" title="${doc.enabled ? 'Enabled' : 'Disabled'}">
                    <input type="checkbox" ${doc.enabled ? 'checked' : ''} onchange="toggleDocument(${doc.id})">
                    <span class="toggle-slider"></span>
                </label>
                <span class="document-meta">${doc.wordCount || 0} words • ${doc.type}</span>
            </div>
        </div>`;
    });

    // Drop zone for empty folder / end of list at this level (only at top level for ungrouped)
    if (parentId === null) {
        html += `<div class="doc-list-end-drop"
                      ondragover="handleFolderDropZoneOver(event)"
                      ondrop="handleFolderDropZoneDrop(event, null)"></div>`;
    }

    return html;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* ========== FOLDER OPERATIONS ========== */

function openNewFolderModal(parentId = null) {
    if (!currentProjectId) { showToast('Select a project first'); return; }
    document.getElementById('newFolderParentId').value = parentId || '';
    document.getElementById('newFolderName').value = '';
    document.getElementById('newFolderModal').style.display = 'flex';
    document.getElementById('newFolderName').focus();
}

function openNewSubfolderModal(parentId) {
    openNewFolderModal(parentId);
}

function closeNewFolderModal() {
    document.getElementById('newFolderModal').style.display = 'none';
}

function createFolder(event) {
    event.preventDefault();
    const name = document.getElementById('newFolderName').value.trim();
    if (!name) return;
    const parentIdVal = document.getElementById('newFolderParentId').value;
    const parentId = parentIdVal ? parseInt(parentIdVal) : null;

    const projectFolders = folders.filter(f => f.projectId === currentProjectId && (f.parentId || null) === parentId);
    const maxOrder = projectFolders.length > 0 ? Math.max(...projectFolders.map(f => f.order || 0)) : -1;

    folders.push({
        id: Date.now(),
        projectId: currentProjectId,
        name,
        parentId,
        order: maxOrder + 1,
        collapsed: false
    });

    autoSave();
    updateDocumentsList();
    closeNewFolderModal();
    showToast(`Folder "${name}" created! 📁`);
}

function deleteFolder(folderId) {
    const folder = folders.find(f => f.id === folderId);
    if (!folder) return;

    const childDocs = documents.filter(d => d.folderId === folderId);
    const childFolders = folders.filter(f => f.parentId === folderId);
    const hasChildren = childDocs.length > 0 || childFolders.length > 0;

    let message = `Delete folder "${folder.name}"?`;
    if (hasChildren) {
        message += `\n\nThis folder contains ${childDocs.length} document(s) and ${childFolders.length} subfolder(s).\nAll contents will be moved to the parent level.`;
    }

    if (!confirm(message)) return;

    // Move children up one level
    const newParentId = folder.parentId || null;
    childDocs.forEach(d => { d.folderId = newParentId; });

    // Recursively move subfolders up
    function reparentFolders(pid, newPid) {
        folders.filter(f => f.parentId === pid).forEach(f => {
            f.parentId = newPid;
        });
    }
    reparentFolders(folderId, newParentId);

    folders = folders.filter(f => f.id !== folderId);
    autoSave();
    updateDocumentsList();
    showToast('Folder deleted');
}

function toggleFolderCollapse(folderId) {
    const folder = folders.find(f => f.id === folderId);
    if (!folder) return;
    folder.collapsed = !folder.collapsed;
    autoSave();
    updateDocumentsList();
}

// Inline rename
function startFolderRename(folderId) {
    const folder = folders.find(f => f.id === folderId);
    if (!folder) return;

    // Find the folder-name span and replace it with an input
    const rows = document.querySelectorAll(`.folder-row[data-folder-id="${folderId}"]`);
    if (!rows.length) return;
    const nameSpan = rows[0].querySelector('.folder-name');
    if (!nameSpan) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = folder.name;
    input.className = 'folder-rename-input';
    input.onclick = e => e.stopPropagation();

    const finish = () => {
        const newName = input.value.trim();
        if (newName && newName !== folder.name) {
            folder.name = newName;
            autoSave();
            showToast('Folder renamed');
        }
        updateDocumentsList();
    };

    input.addEventListener('blur', finish);
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = folder.name; input.blur(); }
    });

    nameSpan.replaceWith(input);
    input.focus();
    input.select();
}

// Open new doc modal pre-set to a folder
function openNewDocumentInFolder(folderId) {
    if (!currentProjectId) { showToast('Select a project first'); return; }
    document.getElementById('newDocumentFolderId').value = folderId || '';
    document.getElementById('documentModalTitle').textContent = 'Create New Document';
    document.getElementById('newDocumentModal').style.display = 'flex';
    document.getElementById('newDocumentTitle').focus();
}

/* ========== UNIFIED DRAG & DROP (docs + folders) ========== */

function handleDocDragStart(event, docId) {
    _dragType = 'doc';
    _dragId   = docId;
    const el = event.currentTarget;
    el.style.opacity = '0.4';
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(docId));
}

function handleFolderDragStart(event, folderId) {
    _dragType = 'folder';
    _dragId   = folderId;
    const el = event.currentTarget;
    el.style.opacity = '0.4';
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(folderId));
    event.stopPropagation();
}

function handleTreeDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    // Clear all indicators
    document.querySelectorAll('.document-card, .folder-row').forEach(el => {
        el.style.borderTop = '';
        el.style.borderBottom = '';
    });

    const card = event.target.closest('.document-card');
    const folderRow = event.target.closest('.folder-row');
    const target = card || folderRow;
    if (!target) return;

    const rect = target.getBoundingClientRect();
    const mid  = rect.top + rect.height / 2;

    if (folderRow && _dragType === 'doc') {
        // Hovering a folder: highlight it as a drop target
        folderRow.style.borderBottom = '2px solid var(--accent-primary)';
    } else if (target) {
        if (event.clientY < mid) {
            target.style.borderTop = '3px solid var(--accent-primary)';
        } else {
            target.style.borderBottom = '3px solid var(--accent-primary)';
        }
    }
    return false;
}

function handleFolderDropZoneOver(event) {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    event.currentTarget.classList.add('drop-zone-active');
}

function handleTreeDrop(event) {
    event.stopPropagation();

    // Clear all indicators
    document.querySelectorAll('.document-card, .folder-row').forEach(el => {
        el.style.borderTop = '';
        el.style.borderBottom = '';
    });
    document.querySelectorAll('.folder-drop-zone, .doc-list-end-drop').forEach(el => {
        el.classList.remove('drop-zone-active');
    });

    const targetCard      = event.target.closest('.document-card');
    const targetFolderRow = event.target.closest('.folder-row');

    if (_dragType === 'doc') {
        const draggedDoc = documents.find(d => d.id === _dragId);
        if (!draggedDoc) { _dragType = null; _dragId = null; return false; }

        if (targetFolderRow && !targetCard) {
            // Drop onto a folder row: move doc into that folder
            const targetFolderId = parseInt(targetFolderRow.dataset.folderId);
            draggedDoc.folderId = targetFolderId;
            autoSave();
            updateDocumentsList();
        } else if (targetCard) {
            // Reorder within same level
            const targetDocId = parseInt(targetCard.dataset.docId);
            if (targetDocId === _dragId) { _dragType = null; _dragId = null; return false; }
            const targetDoc = documents.find(d => d.id === targetDocId);
            if (!targetDoc || targetDoc.projectId !== draggedDoc.projectId) { _dragType = null; _dragId = null; return false; }

            // Move dragged doc to same folder as target
            draggedDoc.folderId = targetDoc.folderId || null;

            // Reorder
            const sameLevelDocs = documents
                .filter(d => d.projectId === currentProjectId && (d.folderId || null) === (targetDoc.folderId || null))
                .sort((a, b) => (a.order || 0) - (b.order || 0));

            const dragIdx   = sameLevelDocs.findIndex(d => d.id === _dragId);
            const targetIdx = sameLevelDocs.findIndex(d => d.id === targetDocId);
            if (dragIdx === -1) { sameLevelDocs.push(draggedDoc); }
            else { sameLevelDocs.splice(dragIdx, 1); }

            const rect = targetCard.getBoundingClientRect();
            const insertAfter = event.clientY >= rect.top + rect.height / 2;
            let newIdx = sameLevelDocs.findIndex(d => d.id === targetDocId);
            if (insertAfter) newIdx++;
            sameLevelDocs.splice(newIdx, 0, draggedDoc);
            sameLevelDocs.forEach((d, i) => { d.order = i; });

            autoSave();
            updateDocumentsList();
        }
    } else if (_dragType === 'folder') {
        const draggedFolder = folders.find(f => f.id === _dragId);
        if (!draggedFolder) { _dragType = null; _dragId = null; return false; }

        if (targetFolderRow && !targetCard) {
            const targetFolderId = parseInt(targetFolderRow.dataset.folderId);
            if (targetFolderId === _dragId) { _dragType = null; _dragId = null; return false; }

            // Prevent dropping a folder into its own descendant
            if (isFolderDescendant(targetFolderId, _dragId)) {
                showToast("Can't move a folder into its own subfolder");
                _dragType = null; _dragId = null;
                return false;
            }

            const targetFolder = folders.find(f => f.id === targetFolderId);
            const rect = targetFolderRow.getBoundingClientRect();
            const mid  = rect.top + rect.height / 2;

            if (event.clientY >= mid - 10 && event.clientY <= mid + 10) {
                // Drop onto centre: make it a subfolder
                draggedFolder.parentId = targetFolderId;
            } else {
                // Drop above/below: reorder at same level as target
                draggedFolder.parentId = targetFolder.parentId || null;
                const sameLevelFolders = folders
                    .filter(f => f.projectId === currentProjectId && (f.parentId || null) === (targetFolder.parentId || null) && f.id !== _dragId)
                    .sort((a, b) => (a.order || 0) - (b.order || 0));
                const targetIdx = sameLevelFolders.findIndex(f => f.id === targetFolderId);
                const insertAfter = event.clientY >= mid;
                const insertIdx = insertAfter ? targetIdx + 1 : targetIdx;
                sameLevelFolders.splice(insertIdx, 0, draggedFolder);
                sameLevelFolders.forEach((f, i) => { f.order = i; });
            }

            autoSave();
            updateDocumentsList();
        }
    }

    _dragType = null;
    _dragId   = null;
    return false;
}

function handleFolderDropZoneDrop(event, targetFolderId) {
    event.stopPropagation();
    document.querySelectorAll('.folder-drop-zone, .doc-list-end-drop').forEach(el => {
        el.classList.remove('drop-zone-active');
    });

    if (_dragType === 'doc') {
        const draggedDoc = documents.find(d => d.id === _dragId);
        if (draggedDoc) {
            draggedDoc.folderId = targetFolderId;
            // Put it at end of that level
            const sameLevelDocs = documents.filter(d =>
                d.projectId === currentProjectId && (d.folderId || null) === targetFolderId && d.id !== _dragId
            );
            draggedDoc.order = sameLevelDocs.length;
            autoSave();
            updateDocumentsList();
        }
    } else if (_dragType === 'folder') {
        const draggedFolder = folders.find(f => f.id === _dragId);
        if (draggedFolder && targetFolderId !== _dragId && !isFolderDescendant(targetFolderId, _dragId)) {
            draggedFolder.parentId = targetFolderId;
            autoSave();
            updateDocumentsList();
        }
    }

    _dragType = null;
    _dragId   = null;
}

function handleTreeDragEnd(event) {
    event.currentTarget.style.opacity = '1';
    document.querySelectorAll('.document-card, .folder-row').forEach(el => {
        el.style.borderTop = '';
        el.style.borderBottom = '';
    });
    document.querySelectorAll('.folder-drop-zone, .doc-list-end-drop').forEach(el => {
        el.classList.remove('drop-zone-active');
    });
    _dragType = null;
    _dragId   = null;
}

// Check if checkId is a descendant of ancestorId
function isFolderDescendant(checkId, ancestorId) {
    if (!checkId) return false;
    let current = folders.find(f => f.id === checkId);
    while (current) {
        if ((current.parentId || null) === ancestorId) return true;
        current = folders.find(f => f.id === (current.parentId || null));
    }
    return false;
}

// Keep old drag handlers as stubs so any residual calls don't break
function handleDragStart(e) { handleTreeDragOver(e); }
function handleDragOver(e) { handleTreeDragOver(e); }
function handleDrop(e) { handleTreeDrop(e); }
function handleDragEnd(e) { handleTreeDragEnd(e); }

function getTypeIcon(type) {
    const icons = {
        'Chapter': '📖',
        'Instructions': '📋',
        'Synopsis': '📝',
        'Writing Style': '✍️',
        'Characters': '👥',
        'Locations': '🗺️',
        'Worldbuilding': '🌍',
        'Plot': '🎭',
        'Research': '🔬',
        'Notes': '📌',
        'Other': '📄'
    };
    return icons[type] || '📄';
}

/* ========== WORD COUNT ========== */

function countWords(text) {
    if (!text || text.trim() === '') return 0;
    return text.trim().split(/\s+/).length;
}

function updateWordCount() {
    const text = cmEditor.getValue();
    const words = countWords(text);
    document.getElementById('wordCount').textContent = words.toLocaleString();
    
    if (currentDocumentId) {
        document.getElementById('documentWordCount').textContent = `${words.toLocaleString()} words`;
    }
}

/* ========== AUTO-SAVE TIMER ========== */

function resetAutoSaveTimer() {
    if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
    }
    
    autoSaveTimer = setTimeout(() => {
        if (hasUnsavedChanges && currentDocumentId) {
            saveDocument(false);
        }
    }, settings.autoSaveInterval);
}

/* ========== MODEL SELECTION ========== */

async function fetchOpenRouterModels() {
    if (modelsLoaded) return;

    try {
        showToast('Loading models from OpenRouter...');
        
        const response = await fetch('https://openrouter.ai/api/v1/models', {
            headers: {
                'HTTP-Referer': window.location.origin,
                'X-Title': 'Poe Write'
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch models: ${response.status}`);
        }

        const data = await response.json();
        
        // Transform the API response into our format
        OPENROUTER_MODELS = data.data.map(model => ({
            id: model.id,
            name: model.name,
            provider: extractProvider(model.id),
            contextLength: model.context_length || 0,
            pricing: model.pricing || {},
            isFree: isFreeModel(model.pricing)
        }));

        // Sort models: free first, then by provider
        OPENROUTER_MODELS.sort((a, b) => {
            if (a.isFree && !b.isFree) return -1;
            if (!a.isFree && b.isFree) return 1;
            return a.provider.localeCompare(b.provider);
        });

        modelsLoaded = true;
        populateModelSelect();
        showToast(`Loaded ${OPENROUTER_MODELS.length} models!`);
        
    } catch (error) {
        console.error('Error fetching models:', error);
        showToast('Failed to load models. Using default list.');
        
        // Fallback to a basic list if API fails
        OPENROUTER_MODELS = [
            { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'Anthropic', isFree: false },
            { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo', provider: 'OpenAI', isFree: false },
            { id: 'openai/gpt-3.5-turbo', name: 'GPT-3.5 Turbo', provider: 'OpenAI', isFree: false },
            { id: 'google/gemini-pro', name: 'Gemini Pro', provider: 'Google', isFree: false },
            { id: 'meta-llama/llama-3-8b-instruct:free', name: 'Llama 3 8B (Free)', provider: 'Meta', isFree: true }
        ];
        modelsLoaded = true;
        populateModelSelect();
    }
}

function extractProvider(modelId) {
    const parts = modelId.split('/');
    if (parts.length > 0) {
        const provider = parts[0];
        return provider.charAt(0).toUpperCase() + provider.slice(1);
    }
    return 'Unknown';
}

function isFreeModel(pricing) {
    if (!pricing) return false;
    
    const promptPrice = parseFloat(pricing.prompt) || 0;
    const completionPrice = parseFloat(pricing.completion) || 0;
    
    return promptPrice === 0 && completionPrice === 0;
}

function populateModelSelect() {
    const select = document.getElementById('modelSelect');
    const showFavorites = document.getElementById('showFavoritesOnly')?.checked || false;
    const showFreeOnly = document.getElementById('showFreeOnly')?.checked || false;
    
    if (!modelsLoaded || OPENROUTER_MODELS.length === 0) {
        select.innerHTML = '<option value="">Loading models...</option>';
        return;
    }
    
    select.innerHTML = '';
    
    let modelsToShow = OPENROUTER_MODELS;
    
    if (showFavorites) {
        modelsToShow = modelsToShow.filter(m => settings.favoriteModels.includes(m.id));
    }
    
    if (showFreeOnly) {
        modelsToShow = modelsToShow.filter(m => m.isFree);
    }

    if (modelsToShow.length === 0) {
        select.innerHTML = '<option value="">No models match filters</option>';
        return;
    }

    const freeModels = modelsToShow.filter(m => m.isFree);
    const paidModels = modelsToShow.filter(m => !m.isFree);

    if (freeModels.length > 0) {
        const freeGroup = document.createElement('optgroup');
        freeGroup.label = '🆓 Free Models';
        freeModels.forEach(model => {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = `${model.name} (${model.provider})`;
            freeGroup.appendChild(option);
        });
        select.appendChild(freeGroup);
    }

    if (paidModels.length > 0) {
        const paidGroup = document.createElement('optgroup');
        paidGroup.label = '💳 Paid Models';
        paidModels.forEach(model => {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = `${model.name} (${model.provider})`;
            paidGroup.appendChild(option);
        });
        select.appendChild(paidGroup);
    }
    
    // Set saved model
    if (settings.lastUsedModel) {
        select.value = settings.lastUsedModel;
    }
    
    updateFavoriteButton();
}

function toggleFavoriteModel() {
    const modelId = document.getElementById('modelSelect').value;
    if (!modelId) return;

    const index = settings.favoriteModels.indexOf(modelId);
    if (index > -1) {
        settings.favoriteModels.splice(index, 1);
        showToast('Removed from favorites');
    } else {
        settings.favoriteModels.push(modelId);
        showToast('Added to favorites ⭐');
    }

    autoSave();
    updateFavoriteButton();
}

function updateFavoriteButton() {
    const modelId = document.getElementById('modelSelect').value;
    const btn = document.getElementById('favoriteBtn');
    if (!btn) return;

    if (settings.favoriteModels.includes(modelId)) {
        btn.textContent = '⭐';
        btn.title = 'Remove from favorites';
    } else {
        btn.textContent = '☆';
        btn.title = 'Add to favorites';
    }
}

function toggleFavoritesFilter() {
    populateModelSelect();
}

/* ========== AI FUNCTIONS ========== */

// Default prompts
const DEFAULT_SYSTEM_PROMPT = `You are a creative writing assistant helping to continue a story. 
{CONTEXT_NOTES}
{DOCUMENTS_CONTEXT}

Generate approximately {TOKENS_TO_GENERATE} tokens that naturally continue the narrative. Match the writing style, tone, and voice of the existing text. Do not repeat content from the existing text.`;

const DEFAULT_USER_PROMPT = `Here is the story so far:\n\n{RECENT_TEXT}\n\nPlease continue the story naturally from where it left off.`;

const DEFAULT_CONTINUE_USER_PROMPT = `Please continue the story naturally from where it left off.`;

const DEFAULT_GO_USER_PROMPT = `Based on all the instructions and context provided, write the article now.`;

const DEFAULT_AIISMS = `## Commonly used words:

absolutely
abyssal
affection
aftermath
algorithmic
aligned
almost alive
amidst
amiss
analyzed
ancient
anticipating
anticipation
apprehension
bashfully
beacon
beacon of hope
blown wide
cacophony
calculate
calculated
calculating
calibrated
calloused fingers
can't help but feel
carried the weight
cascading
cast a warm glow
casual indifference
cataloged
ceaseless
chaotic
charged
charm
chill
chilled
chilling
chromatic
churl
churn
churned
churning
clandestine
clenching
clenching her jaw
clenching his jaw
coded
comfortable
comforting
complex
computed
constructed
could feel
crystal
crystalline
crystallized
dance
dances
dancing
dart
database
delve
delved
delving
depths
desire
determined
determining
disrupt
disrupted
disrupting
down her spine
down his spine
down my spine
dust mote
echo
echoed
echoes
echoing
efficient
effortless
electric
encounter
enigma
enigmatic
ensure
ensuring
ephemeral
etch
etched
etching
ethereal
eyebrow
facade
familiar
fascinating
firmly
flawless
fleeting
flicked
flicker
flickered
flowing
fluttered
footfall
footsteps
foreboding
fractured
fragmented
framework
furrowed
furrowing
galaxies
galaxy
gleaming
glean
gleaning
glided
glint
glinting
glistening
gloom
glooming
grapple
grappling
grave
heart
high-stake
hulking
implicating
implication
impose
imposing
indexed
input
intensity
intricate
intrigue
intriguing
jaw clenched
kaleidoscope
layers of complexity
learned
leveraging
lilt
long shadow
loomed
looming
looms
luminous
lurch
lurched
lurching
macabre
magnetic
marble
marveled
mask of indifference
maw
measured
mechanical
methodical
mosaic
moth to a flame
moths to flame
murmured
navigate
navigated
navigating
newfound
normalcy
oppression
oppressive
optimized
otherworldly
output
palpable
pang
parameters
pattern
patterned
pawn
perfect
peril
playfully
political landscape
pomposity
pools
porcelain
potential
pounding
practiced ease
predator
predictable
preposterous
pristine
processed
profound
programmatic
pull
pulse
pulsed
pumping
quickened
quivered
race
raced
racing
racing heart
radiant
remarkable
reminder
repository
resolve
resolved
resolving
resonance
resonated
restrained
reverberated
rhythmic
roaring
same
sanctuary
satin
scanned
scanning
scratched her head
scratched his head
scripted
searing
sense of
sent shivers down
sentinel
sentinels
sequenced
shared breath
shattered
shimmered
silence
silk
simmering
sinewy
single tear
sinister
skipped a beat
soft ache
solace
solitary
spectral
standard
standardized
stark
steeled
stomach
streaming
streamlined
structure
sturdy
surreal
swept away
symphony
synchronized
synthetic
systematic
tangible
tantalizing
tapestry
templated
tenderness
tension
testament
the last thing
throbbed
thundered
tight
tinge
tinged
to the core
together
traced
tracing
transfixed
treacherous
trembled
trepidation
Tuesday
uncanny
unexpected challenge
unravel
unraveling
unreadable
unsettled
unspoken
unwavering
variable
variables
velvet
vibrated
vise-like grip
voice hitched
warmth
wavered
wavering
weight
whimsical
whisper
yearning

## Commonly used adverbs:

angrily
anxiously
barely above a whisper
carefully
cautiously
coldly
completely
coolly
coyly
deliberately
dreamily
eagerly
ever so slightly
fervently
gently
happily
helplessly
hesitantly
hungrily
inexorably
intensely
knowingly
languidly
lazily
lightly
longingly
loosely
needily
nervously
passionately
perfectly
precisely
purposely
quickly
really
reluctantly
sadly
seductively
sharply
shyly
slightly
slowly
slyly
smugly
softly
suddenly
suggestively
sweetly
teasingly
tenderly
tightly
truly
utterly
very
warily
warmly
wickedly
wistfully

## Commonly mentioned character names:

Blackwood
Brady
Chen
Elara
Elena
Emily
Evans
Henderson
Lily
Marcus
Martinez
Nakamura
Patel
Rodriguez
Sarah
Thompson
Lyra

**Female Names (English Bias)**

Aria
Luna
Maya
Zara
Nora
Iris
Jade
Ruby
Sage
Willow
Aurora
Celeste
Evelyn
Grace
Hope
Faith
Jasmine
Rose
Violet
Chloe
Emma
Olivia
Sophia
Isabella

**Male Names (English Bias)**

Ethan
Noah
Liam
Alexander
Alex
Benjamin
Ben
Daniel
Dan
Michael
Mike
David
James
Robert
William
Thomas
Ryan
Nathan
Adrian
Julian
Sebastian
Gabriel
Lucas
Owen
Kai
Phoenix

**Surnames (US Bias)**

Johnson
Williams
Brown
Davis
Miller
Wilson
Moore
Taylor
Anderson
Jackson
White
Harris
Martin
Garcia
Lewis
Walker
Hall
Young
King
Wright
Lopez
Hill
Green
Adams
Baker
Clark
Turner

**Non-English Bias Names**

Akira
Hiroshi
Yuki
Wei
Li
Zhang
Wang
Raj
Priya
Arjun
Giovanni
Marco
Sofia
Pierre
Marie
Antoine
Klaus
Hans
Greta

### Fantasy

**Female**

Seraphina
Evangeline
Isolde
Morgana
Raven
Ember
Rowan
Astrid
Freya
Kira
Nyx
Vex
Thalia
Stella
Nova
Orion
Fae
Faye
Rhea
Vera
Mira

**Male**

Zane
Dante
Kieran
Damien
Lucian
Ashton
Damon
Theron
Maximus
Cassius
Aurelius
Darian
Zephyr
Atlas
Asher

**Surnames**

Nightshade
Ravencrest
Shadowmere
Thornfield
Darkbane
Stormbringer
Ironwood
Goldleaf
Silverstone
Ashford
Lockwood
Greystone
Whitmore
Blackthorne

### Romance

**Female**

Scarlett
Vivian
Anastasia
Gabriella
Samantha

**Male**

Dominic
Nathaniel
Maximilian
Christian
Aiden
Jaxon
Knox
Ryder
Hunter
Cole
Blake
Steele
Cross
Stone
Grey
Gray
Enzo
Luca

**Surnames**

Fox
Wolf
Powers
Strong

## General

**Overused descriptive language:**

her breath caught in her throat
his eyes darkened
her eyes sparkled
a shiver ran down her spine
time seemed to stand still
the world faded away
her heart hammered in her chest
her heart pounded in her chest
his heart hammered in his chest
his heart pounded in his chest
he let out a breath he didn't know he was holding
a flush crept up her neck
a flush crept up her cheeks

**Character interaction clichés:**

what are you doing to me?
i can't stay away from you
you're going to be the death of me
this is madness
this is insane
we shouldn't be doing this
tell me to stop
stop me

**Scene-setting phrases:**

the air was thick with tension
silence stretched between them
the room crackled with electricity
shadows danced across the walls
moonlight filtered through the windows
dawn broke over the horizon

**Emotional beats that repeat:**

a single tear rolled down her cheek
his jaw clenched
her fists clenched
fire ignited in his eyes
fire ignited in her eyes
ice ran through his veins
ice ran through her veins
butterflies erupted in her stomach

**Plot device phrases:**

little did she know
if only she had known
what she didn't realize was
unbeknownst to her

### Fantasy

**World-building clichés:**

ancient magic coursed through her veins
the blade hummed with power
magic crackled in the air
the forest whispered secrets
shadows seemed to writhe and move
the castle loomed in the distance
mist clung to the mountains
stars wheeled overhead

**Magic system repetition:**

power thrummed beneath her skin
energy pulsed through the crystal
the spell wove itself around
magic sang in her blood
fire danced at his fingertips
the ward shimmered and fell
ancient words of power
the veil between worlds grew thin

**Character descriptions:**

eyes like molten gold
eyes like molten silver
eyes like emeralds
hair like spun moonlight
hair like spun starlight
ethereal beauty
otherworldly grace
ancient wisdom in young eyes
pointed ears
lithe and graceful

**Prophecy and destiny language:**

the chosen one
ancient prophecy foretold
destiny called to her
the threads of fate converged
as it was written
the time of reckoning approaches
balance must be restored
dark forces stirred

**Combat and conflict:**

steel sang against steel
his blade found its mark
she moved like liquid shadow
the clash of weapons rang out
battle-hardened warrior
years of training guided her movements
he fought with the fury of

**Setting atmospherics:**

the tavern fell silent
torchlight flickered on stone walls
ancient runes glowed softly
the throne room echoed with footsteps
cobwebs draped the forgotten chamber
ivy crept up the tower walls

**Magic consequences:**

the spell drained her strength
magic always came with a price
power corrupts
the cost was too great
balance in all things

### Thrillerish

**Detective/investigator descriptions:**

world-weary detective
haunted by past cases
three-day stubble
rumpled coat
rumpled suit
cigarette dangled from his lips
eyes that had seen too much
badge felt heavy in his pocket
one case away from retirement

**Crime scene language:**

the body was discovered at dawn
blood pooled on the concrete
chalk outline marked the spot
evidence bagged and tagged
the scene was cordoned off
forensics swept the area
no signs of forced entry
the victim's eyes stared sightlessly

**Atmospheric clichés:**

rain drummed against the windows
neon lights reflected in puddles
the city never sleeps
shadows lurked in every alley
fog rolled in from the harbor
street lamps cast eerie glows
the neighborhood had seen better days
silence hung heavy in the air

**Investigation repetition:**

following a lead
the pieces didn't add up
something didn't sit right
his gut told him
connect the dots
the trail went cold
back to square one
a break in the case

**Villain/criminal language:**

cold, calculating eyes
a smile that didn't reach his eyes
ice water in his veins
methodical and precise
always one step ahead
left no loose ends
a ghost in the system
vanished without a trace

**Dialogue patterns:**

you're in over your head
this goes deeper than you think
you don't know what you're dealing with
walk away while you still can
it's not what it looks like
trust no one
the truth is out there

**Action sequences:**

adrenaline coursed through his veins
heart pounding in his chest
time slowed to a crawl
training kicked in
muscle memory took over
the gun bucked in his hand
diving for cover
the chase was on`;

function getSystemPrompt(tokensToGenerate, contextNotes, documentsContext) {
    let prompt = settings.customSystemPrompt || DEFAULT_SYSTEM_PROMPT;
    
    prompt = prompt.replace('{TOKENS_TO_GENERATE}', tokensToGenerate);
    
    if (contextNotes) {
        prompt = prompt.replace('{CONTEXT_NOTES}', `\n\nContext about the story:\n${contextNotes}`);
    } else {
        prompt = prompt.replace('{CONTEXT_NOTES}', '');
    }
    
    if (documentsContext) {
        prompt = prompt.replace('{DOCUMENTS_CONTEXT}', documentsContext);
    } else {
        prompt = prompt.replace('{DOCUMENTS_CONTEXT}', '');
    }
    
    return prompt;
}

function getUserPrompt(recentText) {
    let prompt = settings.customUserPrompt || DEFAULT_USER_PROMPT;
    prompt = prompt.replace('{RECENT_TEXT}', recentText);
    return prompt;
}

function getGoUserPrompt() {
    return settings.goUserPrompt || DEFAULT_GO_USER_PROMPT;
}

// Preview for Continue button - shows fiction writing prompt
function previewAiRequest() {
    if (!currentDocumentId) {
        showToast('Please select a document first');
        return;
    }

    const currentText = cmEditor.getValue();
    const model = document.getElementById('modelSelect').value;
    const tokensToGenerate = parseInt(document.getElementById('tokensToGenerate').value);
    const temperature = parseFloat(document.getElementById('temperature').value);
    const contextNotes = document.getElementById('contextNotes').value;

    // Get enabled documents for this project (excluding current document), sorted by order
    const enabledDocs = documents
        .filter(d => d.projectId === currentProjectId && d.enabled && d.id !== currentDocumentId)
        .sort((a, b) => a.order - b.order);
    
    let documentsContext = '';
    if (enabledDocs.length > 0) {
        documentsContext = '\n\nAdditional Context:\n' + enabledDocs.map(doc => {
            const docText = new DOMParser().parseFromString(doc.content, 'text/html').body.textContent || '';
            return `--- ${doc.type}: ${doc.title} ---\n${docText}\n`;
        }).join('\n');
    }

    const recentText = currentText.slice(-4000);

    // Use the actual system prompt from settings or default
    const systemPrompt = getSystemPrompt(tokensToGenerate, contextNotes, documentsContext);
    const userPrompt = getUserPrompt(recentText);

    const requestBody = {
        model: model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        temperature: temperature,
        max_tokens: tokensToGenerate
    };

    showRequestPreview(requestBody, enabledDocs);
}

function showRequestPreview(requestBody, enabledDocs) {
    const modal = document.getElementById('requestPreviewModal');
    const apiContent = document.getElementById('requestPreviewContent');
    const docsContent = document.getElementById('documentsPreviewContent');
    const goContent = document.getElementById('goPreviewContent');
    
    // Format API request
    const formattedJson = JSON.stringify(requestBody, null, 2);
    apiContent.textContent = formattedJson;
    
    // Format documents preview
    let docsPreview = '';
    if (enabledDocs.length === 0) {
        docsPreview = 'No enabled documents to preview.';
    } else {
        enabledDocs.forEach(doc => {
            const htmlContent = doc.content || '';
            const docText = convertHtmlToMarkdown(htmlContent);
            
            // CHANGED: Use single line breaks instead of double
            docsPreview += `[${doc.title}:Start]\n${docText}\n[${doc.title}:End]\n\n`;
        });
    }
    
    docsContent.textContent = docsPreview.trim();
    
    // Format Go prompt preview
    let goPreview = '';
    if (enabledDocs.length === 0) {
        goPreview = 'No enabled documents. Please enable at least one document to use the Go button.';
    } else {
        goPreview += '[Instructions:Start]\n\n';
        
        enabledDocs.forEach(doc => {
            const htmlContent = doc.content || '';
            const docText = convertHtmlToMarkdown(htmlContent);
            
            // CHANGED: Use single line breaks instead of double
            goPreview += `--- ${doc.type}: ${doc.title} ---\n${docText}\n\n`;
        });
        
        goPreview += '[Instructions:End]';
    }
    
    goContent.textContent = goPreview.trim();
    
    modal.style.display = 'flex';
}

function convertHtmlToMarkdown(htmlContent) {
    if (!htmlContent || htmlContent.trim() === '' || htmlContent.trim() === '<p><br></p>') {
        return '';
    }
    
    // Check if Turndown is available
    if (window.TurndownService) {
        try {
            const turndownService = new TurndownService({
                headingStyle: 'atx',
                codeBlockStyle: 'fenced',
                hr: '---',
                bulletListMarker: '-'
            });
            
            // Override the paragraph rule to add proper spacing
            turndownService.addRule('paragraph', {
                filter: 'p',
                replacement: function (content, node, options) {
                    // Each paragraph should be separated by blank line (double newline)
                    return '\n\n' + content.trim() + '\n\n';
                }
            });
            
            const markdown = turndownService.turndown(htmlContent);
            
            // Clean up excessive newlines (more than 2 blank lines)
            return markdown
                .replace(/\n{5,}/g, '\n\n\n\n')  // Max 3 blank lines
                .trim();
                
        } catch (e) {
            console.error('Turndown conversion failed:', e);
            return extractPlainText(htmlContent);
        }
    } else {
        return extractPlainText(htmlContent);
    }
}

function extractPlainText(htmlContent) {
    const tempDiv = document.createElement('div');
    
    // Replace paragraphs properly
    const html = htmlContent
        .replace(/<p><br><\/p>/gi, '\n')  // Empty paragraph
        .replace(/<\/p>\s*<p>/gi, '\n\n')  // Between paragraphs: double newline (blank line)
        .replace(/<p>/gi, '')
        .replace(/<\/p>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<div>/gi, '');
    
    tempDiv.innerHTML = html;
    return tempDiv.textContent.trim();
}

function closeRequestPreview() {
    document.getElementById('requestPreviewModal').style.display = 'none';
}

function copyRequestPreview() {
    const activeTab = document.querySelector('.preview-tab-btn.active').dataset.tab;
    const content = activeTab === 'api' 
        ? document.getElementById('requestPreviewContent').textContent
        : document.getElementById('documentsPreviewContent').textContent;
    
    navigator.clipboard.writeText(content).then(() => {
        showToast('Copied to clipboard! 📋');
    }).catch(() => {
        showToast('Failed to copy');
    });
}

function switchPreviewTab(tabName) {
    document.querySelectorAll('.preview-tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.preview-tab-content').forEach(content => content.classList.remove('active'));
    
    event.target.classList.add('active');
    document.getElementById(`preview-${tabName}-tab`).classList.add('active');
}

async function continueStory() {
    if (!apiKey) {
        showToast('Please add an API key in Settings');
        return;
    }

    if (!currentDocumentId) {
        showToast('Please select a document first');
        return;
    }

    const currentText = cmEditor.getValue().trim();

    // Check if we have enabled documents
    const enabledDocs = documents
        .filter(d => d.projectId === currentProjectId && d.enabled && d.id !== currentDocumentId)
        .sort((a, b) => a.order - b.order);

    if (enabledDocs.length === 0) {
        showToast('Please enable at least one document to provide context');
        return;
    }

    // Determine if we're starting from scratch or continuing
    const isStartingFromScratch = currentText.length === 0;

    if (!isStartingFromScratch && currentText.length < 50) {
        showToast('Write at least 50 characters before using AI to continue');
        return;
    }

    const continueBtn = document.getElementById('floatingContinueBtn');
    if (continueBtn) {
        continueBtn.disabled = true;
        continueBtn.innerHTML = '<span class="btn-icon">⏳</span><span class="btn-label">Generating...</span>';
    }

    // Show loading overlay
    showLoadingOverlay();

    try {
        const model = document.getElementById('modelSelect').value;
        const tokensToGenerate = parseInt(document.getElementById('tokensToGenerate').value);
        const temperature = parseFloat(document.getElementById('temperature').value);
        const contextNotes = document.getElementById('contextNotes').value;

        // Build context from enabled documents
        let documentsContext = '\n\nAdditional Context:\n' + enabledDocs.map(doc => {
            const docText = new DOMParser().parseFromString(doc.content, 'text/html').body.textContent || '';
            return `--- ${doc.type}: ${doc.title} ---\n${docText}\n`;
        }).join('\n');

        let systemPrompt, userPrompt;

        if (isStartingFromScratch) {
            // Starting from scratch - use story beginning prompt
            const genre = getCurrentProjectGenre() || 'story';
            systemPrompt = `You are an expert novelist starting a new ${genre}.
Use ALL the context below to begin writing the first scene/chapter in a compelling, immersive style.
Write in third-person limited (or first-person if the style guide says so).
Start directly with action or vivid description – no summaries or "Chapter 1" titles unless instructed.

Context:
${contextNotes ? `Additional Notes:\n${contextNotes}\n` : ''}${documentsContext}`;

            userPrompt = "Begin the story now.";
        } else {
            // Continuing existing text - use continuation prompt
            const recentText = currentText.slice(-4000);
            systemPrompt = getSystemPrompt(tokensToGenerate, contextNotes, documentsContext);
            userPrompt = getUserPrompt(recentText);
        }

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': window.location.origin,
                'X-Title': 'Poe Write'
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: temperature,
                max_tokens: tokensToGenerate
            })
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();
        const aiText = data.choices[0].message.content.trim();

        // Hide loading overlay before streaming starts
        hideLoadingOverlay();

        // Get cursor position (0 if starting from scratch, end if continuing)
        const startIndex = isStartingFromScratch ? 0 : cmEditor.getValue().length;
        
        // Scroll to appropriate position
        const cmContainer = document.querySelector('.CodeMirror-scroll');
        if (cmContainer) {
            if (isStartingFromScratch) {
                cmContainer.scrollTop = 0;
            } else {
                cmContainer.scrollTop = cmContainer.scrollHeight;
            }
        }

        // Stream the text
        streamInsertAtCursor(aiText, startIndex);

    } catch (error) {
        console.error('AI Error:', error);
        showToast('AI generation failed. Check your API key and try again.');
        
        // Hide loading overlay on error
        hideLoadingOverlay();
        
        // Reset button state on error
        if (continueBtn) {
            continueBtn.disabled = false;
            continueBtn.innerHTML = '<span class="btn-icon">✨</span><span class="btn-label">Continue</span>';
        }
    } finally {
        // Don't reset button here - let streamInsertAtCursor handle it
    }
}

async function continueFromCursor() {
    if (!apiKey) {
        showToast('Please add an API key in Settings');
        return;
    }
    if (!currentDocumentId) {
        showToast('Please select a document first');
        return;
    }

    const cursor = cmEditor.getCursor();
    const cursorIndex = cmEditor.indexFromPos(cursor);
    if (cursorIndex < 30) {
        showToast('Place your cursor after some text to continue');
        return;
    }

    showGeneratingState(true);

    const currentText = cmEditor.getValue();
    if (currentText.trim().length < 50) {
        showToast('Write a little more before continuing');
        showGeneratingState(false);
        return;
    }

    const topBtn = document.getElementById('continueBtn');
    const originalTopHTML = topBtn ? topBtn.innerHTML : '';
    if (topBtn) {
        topBtn.disabled = true;
        topBtn.innerHTML = '<span class="toolbar-icon">⏳</span><span class="toolbar-label">Generating...</span>';
    }

    try {
        const model = document.getElementById('modelSelect').value;
        const tokensToGenerate = parseInt(document.getElementById('tokensToGenerate').value);
        const temperature = parseFloat(document.getElementById('temperature').value);
        const contextNotes = document.getElementById('contextNotes').value;

        const enabledDocs = documents
            .filter(d => d.projectId === currentProjectId && d.enabled && d.id !== currentDocumentId)
            .sort((a, b) => a.order - b.order);

        let documentsContext = '';
        if (enabledDocs.length > 0) {
            documentsContext = '\n\nAdditional Context:\n' + enabledDocs.map(doc => {
                const docText = doc.content || '';
                return `--- ${doc.type}: ${doc.title} ---\n${docText}\n`;
            }).join('\n');
        }

        const recentText = currentText.slice(-4000);
        const systemPrompt = getSystemPrompt(tokensToGenerate, contextNotes, documentsContext);
        const userPrompt = getUserPrompt(recentText);

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': window.location.origin,
                'X-Title': 'Poe Write'
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: temperature,
                max_tokens: tokensToGenerate,
                stream: false
            })
        });

        if (!response.ok) throw new Error(`API error: ${response.status}`);
        const data = await response.json();
        const aiText = data.choices[0].message.content.trim();

        hideFloatingContinueButton();
        
        // Stream-type insertion at cursor
        streamInsertAtCursor(aiText, cursorIndex);

    } catch (error) {
        console.error('AI Error:', error);
        showToast('Generation failed. Check API key and internet.');
    } finally {
        if (topBtn) {
            topBtn.disabled = false;
            topBtn.innerHTML = originalTopHTML;
        }
        showGeneratingState(false);
    }
}

// Show floating button when cursor is in a good spot
function updateFloatingContinueButton() {
    // Don't show during streaming
    if (isStreaming) return;

    // Immediately exit and hide buttons if no document is selected
    if (!currentDocumentId) {
        hideFloatingContinueButton();
        return;
    }
    
    // Don't show if Accept/Reject buttons are visible
    const acceptRejectContainer = document.getElementById('acceptRejectContainer');
    if (acceptRejectContainer && acceptRejectContainer.style.display === 'flex') {
        hideFloatingContinueButton();
        return;
    }

    const cursor = cmEditor.getCursor();
    const continueBtn = document.getElementById('floatingContinueBtn');
    const goBtn = document.getElementById('floatingGoBtn');

    const fullText = cmEditor.getValue();
    const cursorIndex = cmEditor.indexFromPos(cursor);
    const textBeforeCursor = fullText.substring(0, cursorIndex);

    // Hide both by default
    continueBtn.style.display = 'none';
    goBtn.style.display = 'none';

    // CASE 1: Blank document → show "Go" button
    if (fullText.trim().length === 0 && hasEnabledContextDocuments()) {
        positionFloatingButton(goBtn);
        goBtn.style.display = 'block';
        goBtn.classList.add('ready');
        return;
    }

    // CASE 2: Some text exists → show normal "Continue" button
    if (textBeforeCursor.trim().length >= 50) {
        positionFloatingButton(continueBtn);
        continueBtn.style.display = 'block';
        continueBtn.classList.add('ready');
    }
}

// Helper: check if any context documents are enabled
function hasEnabledContextDocuments() {
    return documents.some(d => 
        d.projectId === currentProjectId && 
        d.enabled && 
        d.id !== currentDocumentId &&
        ['Synopsis', 'Characters', 'Plot', 'Worldbuilding', 'Writing Style', 'Instructions'].includes(d.type)
    );
}

// Shared positioning logic for CodeMirror
function positionFloatingButton(btn) {
    const cursor = cmEditor.getCursor();
    const coords = cmEditor.cursorCoords(cursor, 'page');
    const editorRect = cmEditor.getWrapperElement().getBoundingClientRect();
    
    let x = coords.left - editorRect.left + 12;
    let y = coords.top - editorRect.top + 30;
    let flipped = false;
   
    // Flip button above the line if it would be off-screen
    const buttonHeight = 50;
    if (y + buttonHeight > editorRect.height) {
        y = coords.top - editorRect.top - buttonHeight - 10;
        flipped = true;
    }

    btn.classList.toggle('flipped', flipped);

    btn.style.position = 'absolute';
    btn.style.left = x + 'px';
    btn.style.top = y + 'px';
}

// Also update startFromScratch function
async function startFromScratch() {
    showGeneratingState(true, true);

    if (!apiKey) {
        showToast('Add your OpenRouter API key in Settings');
        showGeneratingState(false, true);
        return;
    }

    const model = document.getElementById('modelSelect').value;
    const tokens = parseInt(document.getElementById('tokensToGenerate').value);
    const temp = parseFloat(document.getElementById('temperature').value);
    const contextNotes = document.getElementById('contextNotes').value;

    const enabledDocs = documents
        .filter(d => d.projectId === currentProjectId && d.enabled && d.id !== currentDocumentId)
        .sort((a, b) => a.order - b.order);

    let fullContext = enabledDocs.map(doc => {
        const text = doc.content || '';
        return `--- ${doc.type}: ${doc.title} ---\n${text.trim()}\n`;
    }).join('\n');

    if (contextNotes) fullContext += `\n\nAdditional Notes:\n${contextNotes}`;

    const systemPrompt = `You are an expert novelist starting a new ${getCurrentProjectGenre() || 'story'}.
Use ALL the context below to begin writing the first scene/chapter in a compelling, immersive style.
Write in third-person limited (or first-person if the style guide says so).
Start directly with action or vivid description – no summaries or "Chapter 1" titles unless instructed.

Context:
${fullContext}`;

    const userPrompt = "Begin the story now.";

    try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': window.location.origin,
                'X-Title': 'Poe Write'
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: temp,
                max_tokens: tokens
            })
        });

        if (!response.ok) throw new Error('API error');

        const data = await response.json();
        const generatedText = data.choices[0].message.content.trim();

        hideFloatingContinueButton();
        
        // Stream from the very beginning
        streamInsertAtCursor(generatedText, 0);

    } catch (err) {
        console.error(err);
        showToast('Failed to start. Check API key.');
    } finally {
        showGeneratingState(false, true);  
    }
}

function getCurrentProjectGenre() {
    const project = projects.find(p => p.id === currentProjectId);
    return project?.genre || '';
}

function hideFloatingContinueButton() {
    document.getElementById('floatingContinueBtn').style.display = 'none';
    document.getElementById('floatingGoBtn').style.display = 'none';
    document.querySelectorAll('.floating-continue-btn, .floating-go-btn').forEach(b => b.classList.remove('ready'));
}

function showGeneratingState(isGenerating, isGoButton = false) {
    const continueBtn = document.getElementById('floatingContinueBtn');
    const goBtn = document.getElementById('floatingGoBtn');
    const topBtn = document.getElementById('continueBtn');

    if (isGoButton) {
        if (isGenerating) goBtn.classList.add('generating');
        else goBtn.classList.remove('generating');
    } else {
        if (isGenerating) continueBtn.classList.add('generating');
        else continueBtn.classList.remove('generating');
    }

    // Also update top toolbar button
    if (topBtn) {
        const icon = topBtn.querySelector('.toolbar-icon');
        const label = topBtn.querySelector('.toolbar-label');
        if (isGenerating) {
            icon.textContent = '⏳';
            label.textContent = 'Generating...';
            topBtn.disabled = true;
        } else {
            icon.textContent = '✨';
            label.textContent = 'Continue';
            topBtn.disabled = false;
        }
    }
}

// Fast chunk-based streaming effect with auto-scroll
function streamInsertAtCursor(text, startIndex, disablescroll = false) {
    isStreaming = true;
    generatedTextStartIndex = startIndex;
    generatedTextLength = 0;

    if(!disablescroll){
        showStopButton();
    }
    
    const cmContainer = document.querySelector('.CodeMirror-scroll');
    
    if (cmContainer && startIndex === 0) {
        cmContainer.scrollTop = 0;
    }
    
    // Insert in chunks of ~20 characters for fast but visible streaming
    const CHUNK_SIZE = 20;
    let i = 0;

    streamingInterval = setInterval(() => {
        if (!isStreaming || i >= text.length) {
            clearInterval(streamingInterval);
            streamingInterval = null;
            isStreaming = false;
            hideStopButton();
            
            const continueBtn = document.getElementById('continueBtn');
            if (continueBtn) {
                continueBtn.disabled = false;
                continueBtn.innerHTML = '<span class="toolbar-icon">✨</span><span class="toolbar-label">Continue</span>';
            }
            
            showAcceptRejectButtons();
            hasUnsavedChanges = true;
            updateWordCount();
            return;
        }

        // Insert a chunk of characters at once
        const chunk = text.slice(i, i + CHUNK_SIZE);
        const pos = cmEditor.posFromIndex(startIndex + i);
        cmEditor.replaceRange(chunk, pos);
        
        i += chunk.length;
        generatedTextLength = i;
        
        if (!disablescroll) {
            const newPos = cmEditor.posFromIndex(startIndex + i);
            cmEditor.setCursor(newPos);
            
            // Auto-scroll to follow cursor
            const cursorCoords = cmEditor.cursorCoords(true, 'local');
            if (cmContainer) {
                const containerHeight = cmContainer.clientHeight;
                const scrollTop = cmContainer.scrollTop;
                if (cursorCoords.bottom > scrollTop + containerHeight - 50) {
                    cmContainer.scrollTop = cursorCoords.bottom - containerHeight + 100;
                }
            }
        }
        
    }, 16);
}

// ADD these new functions:
function showStopButton() {
    const stopBtn = document.getElementById('stopGenerationBtn');
    if (stopBtn) {
        stopBtn.style.display = 'flex';
        setTimeout(() => stopBtn.classList.add('visible'), 10);
    }
}

function hideStopButton() {
    const stopBtn = document.getElementById('stopGenerationBtn');
    if (stopBtn) {
        stopBtn.classList.remove('visible');
        setTimeout(() => stopBtn.style.display = 'none', 300);
    }
}

function stopGeneration() {
    if (streamingInterval) {
        clearInterval(streamingInterval);
        streamingInterval = null;
    }
    
    isStreaming = false;
    hideStopButton();
    hideFloatingContinueButton();
    
    // Reset button states
    const topBtn = document.getElementById('continueBtn');
    if (topBtn) {
        topBtn.disabled = false;
        topBtn.innerHTML = '<span class="toolbar-icon">✨</span><span class="toolbar-label">Continue</span>';
    }
    
    showGeneratingState(false);
    showGeneratingState(false, true);
    
    // Show Accept/Reject buttons for partial generation
    if (generatedTextLength > 0) {
        showAcceptRejectButtons();
    }
    
    hasUnsavedChanges = true;
    updateWordCount();
    showToast('Generation stopped');
}

function showLoadingOverlay() {
    const overlay = document.getElementById('generationLoadingOverlay');
    if (overlay) {
        overlay.classList.add('visible');
    }
}

function hideLoadingOverlay() {
    const overlay = document.getElementById('generationLoadingOverlay');
    if (overlay) {
        overlay.classList.remove('visible');
    }
}

function showAcceptRejectButtons() {
    const container = document.getElementById('acceptRejectContainer');
    if (container) {
        container.style.display = 'flex';
        setTimeout(() => container.classList.add('visible'), 10);
    }
    
    // Hide floating continue button while Accept/Reject is visible
    hideFloatingContinueButton();
}

function hideAcceptRejectButtons() {
    const container = document.getElementById('acceptRejectContainer');
    if (container) {
        container.classList.remove('visible');
        setTimeout(() => container.style.display = 'none', 300);
    }
}

// UPDATED: Better Accept/Reject functions without setSelection
function acceptGeneratedText() {
    // Reset tracking variables
    generatedTextStartIndex = null;
    generatedTextLength = 0;
    
    hideAcceptRejectButtons();
    showToast('Text accepted! ✨');
    hasUnsavedChanges = true;
    saveDocument(false);
    
    // Multiple checks to ensure button appears
    setTimeout(() => {
        updateFloatingContinueButton();
    }, 50);
    
    setTimeout(() => {
        updateFloatingContinueButton();
    }, 350);
}

function rejectGeneratedText() {
    if (generatedTextStartIndex !== null && generatedTextLength > 0) {
        const startPos = cmEditor.posFromIndex(generatedTextStartIndex);
        const endPos = cmEditor.posFromIndex(generatedTextStartIndex + generatedTextLength);
        cmEditor.replaceRange('', startPos, endPos);
    }
    
    // Reset tracking variables
    generatedTextStartIndex = null;
    generatedTextLength = 0;
    
    hideAcceptRejectButtons();
    showToast('Text rejected');
    
    hasUnsavedChanges = true;
    updateWordCount();
    
    // Multiple checks to ensure button appears
    setTimeout(() => {
        updateFloatingContinueButton();
    }, 50);
    
    setTimeout(() => {
        updateFloatingContinueButton();
    }, 350);
}

function improveText() {
    const selectedText = cmEditor.getSelection();
    if (!selectedText || selectedText.trim().length < 10) {
        showToast('Please select at least 10 characters to improve');
        return;
    }

    // Store selection for later use
    window.pendingImproveText = selectedText;
    
    // Open the modal
    document.getElementById('improveTextModal').style.display = 'flex';
    document.getElementById('improveInstructions').focus();
}

function closeImproveModal() {
    document.getElementById('improveTextModal').style.display = 'none';
    document.getElementById('improveInstructions').value = '';
    window.pendingImproveText = null;
}

async function executeImprove() {
    if (!apiKey) {
        showToast('Please add an API key in Settings');
        closeImproveModal();
        return;
    }

    const selectedText = window.pendingImproveText;
    if (!selectedText) {
        showToast('Selection lost. Please try again.');
        closeImproveModal();
        return;
    }

    const instructions = document.getElementById('improveInstructions').value.trim();
    if (!instructions) {
        showToast('Please provide improvement instructions');
        return;
    }
    
    closeImproveModal();
    showLoadingOverlay();

    try {
        const model = document.getElementById('modelSelect').value;
        const temperature = parseFloat(document.getElementById('temperature').value);

        const systemPrompt = `You are a professional editor. Improve the provided text based on the user's specific instructions while maintaining the original meaning and voice. Return only the improved text without any preamble or explanation.`;

        const userPrompt = `Original text:\n${selectedText}\n\nInstructions: ${instructions}\n\nProvide the improved version:`;

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': window.location.origin,
                'X-Title': 'Poe Write'
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: temperature,
                max_tokens: Math.max(selectedText.length * 2, 1024)
            })
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();
        const improvedText = data.choices[0].message.content.trim();

        hideLoadingOverlay();

        // Replace selected text with improved text
        cmEditor.replaceSelection(improvedText);

        hasUnsavedChanges = true;
        updateWordCount();
        showToast('Text improved! ✨');

    } catch (error) {
        console.error('AI Error:', error);
        hideLoadingOverlay();
        showToast('Text improvement failed. Check your API key.');
    }
}


async function brainstorm() {
    if (!apiKey) {
        showToast('Please add an API key in Settings');
        return;
    }

    showToast('Generating ideas...');

    try {
        const model = document.getElementById('modelSelect').value;
        const temperature = parseFloat(document.getElementById('temperature').value);
        const contextNotes = document.getElementById('contextNotes').value;
        const currentText = cmEditor.getValue().slice(-2000);

        const enabledDocs = documents
            .filter(d => d.projectId === currentProjectId && d.enabled && d.id !== currentDocumentId)
            .sort((a, b) => a.order - b.order);
        
        let documentsContext = '';
        if (enabledDocs.length > 0) {
            documentsContext = '\n\nAdditional Context:\n' + enabledDocs.map(doc => {
                const docText = new DOMParser().parseFromString(doc.content, 'text/html').body.textContent || '';
                return `--- ${doc.type}: ${doc.title} ---\n${docText}\n`;
            }).join('\n');
        }

        const systemPrompt = `You are a creative writing assistant. Generate 5 creative ideas for continuing or enhancing the story.
${contextNotes ? `\n\nContext:\n${contextNotes}` : ''}
${documentsContext}

Format your response as a numbered list.`;

        const userPrompt = currentText 
            ? `Based on this story excerpt:\n\n${currentText}\n\nProvide 5 creative ideas for what could happen next or how to develop the narrative.`
            : 'Provide 5 creative story ideas or writing prompts.';

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': window.location.origin,
                'X-Title': 'Poe Write'
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: temperature
            })
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();
        const ideas = data.choices[0].message.content.trim();

        lastAiResponse = ideas;
        showAiOutput(ideas);

    } catch (error) {
        console.error('AI Error:', error);
        showToast('Brainstorming failed. Check your API key.');
    }
}

// Replace the brainstorm() function with this new goGenerate() function:

async function goGenerate() {
    if (!apiKey) {
        showToast('Please add an API key in Settings');
        return;
    }

    if (!currentProjectId) {
        showToast('Please select a project first');
        return;
    }

    // Get enabled documents (excluding current document)
    const enabledDocs = documents
        .filter(d => d.projectId === currentProjectId && d.enabled && d.id !== currentDocumentId)
        .sort((a, b) => a.order - b.order);

    if (enabledDocs.length === 0) {
        showToast('Please enable at least one document to use as instructions');
        return;
    }

    const goBtn = document.getElementById('floatingGoBtn');
    goBtn.disabled = true;
    goBtn.innerHTML = '<span class="btn-icon">⏳</span><span class="toolbar-label">Generating...</span>';

    showLoadingOverlay();

    // Store the current cursor position (should be 0 if empty)
    const cursor = cmEditor.getCursor();
    const startIndex = cmEditor.indexFromPos(cursor);

    try {
        const model = document.getElementById('modelSelect').value;
        const tokensToGenerate = parseInt(document.getElementById('tokensToGenerate').value);
        const temperature = parseFloat(document.getElementById('temperature').value);

        // Build the complete context from all enabled documents
        let fullInstructions = enabledDocs.map(doc => {
            const docText = doc.content || '';
            return `--- ${doc.type}: ${doc.title} ---\n${docText.trim()}\n`;
        }).join('\n');

        // Simple, direct system prompt for non-fiction writing
        const systemPrompt = `You are a professional writer creating high-quality non-fiction content. Use the following documents as your complete instructions and context. Write in a clear, engaging style appropriate for magazine articles.

${fullInstructions}`;

        const userPrompt = getGoUserPrompt();

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': window.location.origin,
                'X-Title': 'Poe Write'
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: temperature,
                max_tokens: tokensToGenerate
            })
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();
        const generatedText = data.choices[0].message.content.trim();

        hideLoadingOverlay();

        // Use the streaming insertion at cursor position
        streamInsertAtCursor(generatedText, startIndex);

    } catch (error) {
        console.error('AI Error:', error);
        hideLoadingOverlay();
        showToast('Generation failed. Check your API key and try again.');
    } finally {
        goBtn.disabled = false;
        goBtn.innerHTML = '<span class="btn-icon">🚀</span><span class="toolbar-label">Go</span>';
    }
}

function showAiOutput(text) {
    document.getElementById('aiOutputContent').textContent = text;
    document.getElementById('aiOutput').style.display = 'block';
}

function closeAiOutput() {
    document.getElementById('aiOutput').style.display = 'none';
}

function insertAiText() {
    const cursor = cmEditor.getCursor();
    cmEditor.replaceRange('\n\n' + lastAiResponse, cursor);
    hasUnsavedChanges = true;
    updateWordCount();
    closeAiOutput();
    showToast('AI text inserted! 📝');
}

function copyAiText() {
    navigator.clipboard.writeText(lastAiResponse).then(() => {
        showToast('Copied to clipboard! 📋');
    }).catch(() => {
        showToast('Failed to copy');
    });
}

/* ========== EDITOR FORMATTING ========== */

// Conversion functions are no longer needed since we're using pure markdown
function convertMarkdownToRichText() {
    showToast('Already in Markdown mode! Switch to Preview to see rendered HTML.');
}

function convertRichTextToMarkdown() {
    showToast('Already in Markdown mode!');
}

function formatForFiction() {
    if (!currentDocumentId) {
        showToast('Please select a document first');
        return;
    }
    
    const text = cmEditor.getValue();
    
    if (!text || text.trim().length === 0) {
        showToast('No text to format');
        return;
    }
    
    // Get all paragraphs and add indentation
    const paragraphs = text.split('\n\n');
    
    // Format each paragraph with proper spacing
    const formattedText = paragraphs
        .map(para => para.trim())
        .filter(para => para.length > 0)
        .map(para => '    ' + para) // Add 4-space indent
        .join('\n\n');
    
    cmEditor.setValue(formattedText);
    
    hasUnsavedChanges = true;
    showToast('Formatted for fiction! 📖');
}

/* ========== MARKDOWN TOOLBAR FUNCTIONS ========== */

function insertMarkdown(type) {
    const selection = cmEditor.getSelection();
    const cursor = cmEditor.getCursor();
    
    let replacement = '';
    let cursorOffset = 0;
    
    switch(type) {
        case 'bold':
            if (selection) {
                replacement = `**${selection}**`;
                cmEditor.replaceSelection(replacement);
            } else {
                replacement = '**bold text**';
                cmEditor.replaceRange(replacement, cursor);
                // Select "bold text"
                const from = {line: cursor.line, ch: cursor.ch + 2};
                const to = {line: cursor.line, ch: cursor.ch + 11};
                cmEditor.setSelection(from, to);
            }
            break;
            
        case 'italic':
            if (selection) {
                replacement = `*${selection}*`;
                cmEditor.replaceSelection(replacement);
            } else {
                replacement = '*italic text*';
                cmEditor.replaceRange(replacement, cursor);
                const from = {line: cursor.line, ch: cursor.ch + 1};
                const to = {line: cursor.line, ch: cursor.ch + 12};
                cmEditor.setSelection(from, to);
            }
            break;
            
        case 'strikethrough':
            if (selection) {
                replacement = `~~${selection}~~`;
                cmEditor.replaceSelection(replacement);
            } else {
                replacement = '~~strikethrough~~';
                cmEditor.replaceRange(replacement, cursor);
                const from = {line: cursor.line, ch: cursor.ch + 2};
                const to = {line: cursor.line, ch: cursor.ch + 15};
                cmEditor.setSelection(from, to);
            }
            break;
            
        case 'h1':
            cmEditor.replaceRange('# ', {line: cursor.line, ch: 0});
            cmEditor.setCursor({line: cursor.line, ch: 2});
            break;
            
        case 'h2':
            cmEditor.replaceRange('## ', {line: cursor.line, ch: 0});
            cmEditor.setCursor({line: cursor.line, ch: 3});
            break;
            
        case 'h3':
            cmEditor.replaceRange('### ', {line: cursor.line, ch: 0});
            cmEditor.setCursor({line: cursor.line, ch: 4});
            break;
            
        case 'quote':
            cmEditor.replaceRange('> ', {line: cursor.line, ch: 0});
            cmEditor.setCursor({line: cursor.line, ch: 2});
            break;
            
        case 'code':
            if (selection) {
                replacement = `\`${selection}\``;
                cmEditor.replaceSelection(replacement);
            } else {
                replacement = '`code`';
                cmEditor.replaceRange(replacement, cursor);
                const from = {line: cursor.line, ch: cursor.ch + 1};
                const to = {line: cursor.line, ch: cursor.ch + 5};
                cmEditor.setSelection(from, to);
            }
            break;
            
        case 'codeblock':
            replacement = '```\ncode block\n```';
            cmEditor.replaceRange(replacement, cursor);
            const from = {line: cursor.line + 1, ch: 0};
            const to = {line: cursor.line + 1, ch: 10};
            cmEditor.setSelection(from, to);
            break;
            
        case 'ul':
            cmEditor.replaceRange('- ', {line: cursor.line, ch: 0});
            cmEditor.setCursor({line: cursor.line, ch: 2});
            break;
            
        case 'ol':
            cmEditor.replaceRange('1. ', {line: cursor.line, ch: 0});
            cmEditor.setCursor({line: cursor.line, ch: 3});
            break;
            
        case 'link':
            if (selection) {
                replacement = `[${selection}](url)`;
                cmEditor.replaceSelection(replacement);
            } else {
                replacement = '[link text](url)';
                cmEditor.replaceRange(replacement, cursor);
                const from = {line: cursor.line, ch: cursor.ch + 1};
                const to = {line: cursor.line, ch: cursor.ch + 10};
                cmEditor.setSelection(from, to);
            }
            break;
            
        case 'hr':
            const lineContent = cmEditor.getLine(cursor.line);
            const insertPos = lineContent.trim().length === 0 ? cursor : {line: cursor.line + 1, ch: 0};
            cmEditor.replaceRange('\n---\n\n', insertPos);
            cmEditor.setCursor({line: insertPos.line + 3, ch: 0});
            break;
            
        case 'image':
            if (selection) {
                replacement = `![${selection}](url)`;
                cmEditor.replaceSelection(replacement);
            } else {
                replacement = '![alt text](url)';
                cmEditor.replaceRange(replacement, cursor);
                const from = {line: cursor.line, ch: cursor.ch + 2};
                const to = {line: cursor.line, ch: cursor.ch + 10};
                cmEditor.setSelection(from, to);
            }
            break;
            
        case 'checkbox':
            cmEditor.replaceRange('- [ ] ', {line: cursor.line, ch: 0});
            cmEditor.setCursor({line: cursor.line, ch: 6});
            break;
            
        case 'table':
            replacement = '| Header 1 | Header 2 |\n|----------|----------|\n| Cell 1   | Cell 2   |';
            cmEditor.replaceRange(replacement, cursor);
            cmEditor.setCursor({line: cursor.line, ch: 2});
            break;
            
        case 'highlight':
            if (currentEditorMode === 'preview') {
                applyHighlightInPreview();
                return; // applyHighlightInPreview handles focus/save itself
            }
            if (selection) {
                const color = getHighlightColor();
                // Wrap selection in == markers (stored in file)
                replacement = `==${selection}==`;
                cmEditor.replaceSelection(replacement);
                // Refresh to apply visual highlighting
                setTimeout(refreshHighlightMarkers, 50);
            } else {
                showToast('Select text to highlight');
            }
            break;
    }
    
    cmEditor.focus();
    hasUnsavedChanges = true;
}

// ========== RIGHT SIDEBAR ==========

function toggleRightSidebar() {
    const sidebar = document.getElementById('rightSidebar');
    if (!sidebar) return;
    sidebar.classList.toggle('collapsed');
    document.body.classList.toggle('right-sidebar-collapsed');
}

function updateRightSidebar() {
    if (!currentDocumentId) return;
    const sidebar = document.getElementById('rightSidebar');
    if (!sidebar) return;
    
    // Always update data even if sidebar is collapsed - so it's fresh when opened
    const doc = documents.find(d => d.id === currentDocumentId);
    const project = projects.find(p => p.id === currentProjectId);
    const content = cmEditor ? cmEditor.getValue() : '';

    // --- Metadata ---
    const words = content.trim() ? content.trim().split(/\s+/).length : 0;
    const chars = content.length;
    const paragraphs = content.split(/\n\s*\n/).filter(p => p.trim()).length;
    const readTime = Math.max(1, Math.round(words / 200));

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('rsDocType',   doc ? doc.type : '-');
    set('rsWordCount', words.toLocaleString());
    set('rsCharCount', chars.toLocaleString());
    set('rsParagraphs', paragraphs.toLocaleString());
    set('rsReadTime',  readTime + ' min');
    set('rsProject',   project ? project.title : '-');
    set('rsEnabled',   doc ? (doc.enabled ? '✅ Yes' : '❌ No') : '-');

    // Count AI-isms if available
    const aiismMarks = document.querySelectorAll('.cm-aiism');
    set('rsAiisms', aiismMarks.length > 0 ? `⚠️ ${aiismMarks.length}` : '✅ None');

    // --- Table of Contents ---
    const tocContainer = document.getElementById('tableOfContents');
    if (!tocContainer) return;

    const lines = content.split('\n');
    const headers = [];
    lines.forEach(line => {
        const match = line.match(/^(#{1,6})\s+(.+)/);
        if (match) {
            headers.push({ level: match[1].length, text: match[2].trim() });
        }
    });

    if (headers.length === 0) {
        tocContainer.innerHTML = '<span class="empty-message">No headers</span>';
        // Don't return - metadata has already been updated above
    } else {
        tocContainer.innerHTML = headers.map((h, i) => `
            <div class="toc-item level-${h.level}" onclick="jumpToHeader(${i})" title="${h.text}">
                ${h.text}
            </div>
        `).join('');
    }
}

function jumpToHeader(index) {
    // Check if we're in preview mode
    if (currentEditorMode === 'preview') {
        const previewDiv = document.getElementById('preview');
        if (!previewDiv) return;
        
        // Find all headers in the preview
        const headers = previewDiv.querySelectorAll('h1, h2, h3, h4, h5, h6');
        if (headers[index]) {
            // Scroll the header to the top of the preview container
            previewDiv.scrollTop = headers[index].offsetTop - 20; // 20px top padding
        }
        return;
    }
    
    // Markdown editor mode
    if (!cmEditor) return;
    const content = cmEditor.getValue();
    const lines = content.split('\n');
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
        if (/^#{1,6}\s+/.test(lines[i])) {
            if (count === index) {
                // Use 'top' alignment to scroll header to the top of the viewport
                cmEditor.scrollIntoView({ line: i, ch: 0 }, 20);
                
                // Get the scroll info and manually adjust to ensure it's at the top
                const scrollInfo = cmEditor.getScrollInfo();
                const coords = cmEditor.charCoords({ line: i, ch: 0 }, 'local');
                cmEditor.scrollTo(null, coords.top - 20); // 20px top padding
                
                cmEditor.setCursor({ line: i, ch: 0 });
                cmEditor.focus();
                return;
            }
            count++;
        }
    }
}

// Toggle full screen mode
function toggleFullScreen() {
    document.body.classList.toggle('fullscreen-mode');
    const isFullscreen = document.body.classList.contains('fullscreen-mode');
    
    if (isFullscreen) {
        showToast('Full screen mode');
    } else {
        showToast('Normal mode');
    }
    
    setTimeout(() => {
        if (cmEditor) {
            if (isFullscreen) {
                const toolbar = document.querySelector('.markdown-toolbar-sleek');
                const toolbarHeight = toolbar ? toolbar.offsetHeight : 0;
                const available = window.innerHeight - toolbarHeight;
                cmEditor.setSize(null, available);
            } else {
                // Restore normal mode - let CSS take over
                cmEditor.setSize(null, '100%');
            }
            cmEditor.refresh();
        }
    }, 50);
}

/* ========== HTML TO MARKDOWN CONVERTER ========== */

function htmlToMarkdown(html) {
    // Simple HTML to Markdown converter
    let markdown = html;
    
    // Remove <p><br></p> (empty paragraphs from Quill)
    markdown = markdown.replace(/<p><br><\/p>/gi, '\n');
    
    // Headers
    markdown = markdown.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n');
    markdown = markdown.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n');
    markdown = markdown.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n');
    markdown = markdown.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n');
    markdown = markdown.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n\n');
    markdown = markdown.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n\n');
    
    // Bold
    markdown = markdown.replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**');
    markdown = markdown.replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**');
    
    // Italic
    markdown = markdown.replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*');
    markdown = markdown.replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*');
    
    // Underline (markdown doesn't have underline, keep as bold)
    markdown = markdown.replace(/<u[^>]*>(.*?)<\/u>/gi, '**$1**');
    
    // Strikethrough
    markdown = markdown.replace(/<s[^>]*>(.*?)<\/s>/gi, '~~$1~~');
    markdown = markdown.replace(/<strike[^>]*>(.*?)<\/strike>/gi, '~~$1~~');
    markdown = markdown.replace(/<del[^>]*>(.*?)<\/del>/gi, '~~$1~~');
    
    // Code
    markdown = markdown.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');
    
    // Blockquote
    markdown = markdown.replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gi, function(match, content) {
        return content.split('\n').map(line => '> ' + line).join('\n') + '\n\n';
    });
    
    // Lists
    markdown = markdown.replace(/<ul[^>]*>(.*?)<\/ul>/gis, function(match, content) {
        return content.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n') + '\n';
    });
    
    markdown = markdown.replace(/<ol[^>]*>(.*?)<\/ol>/gis, function(match, content) {
        let counter = 1;
        return content.replace(/<li[^>]*>(.*?)<\/li>/gi, function(m, item) {
            return `${counter++}. ${item}\n`;
        }) + '\n';
    });
    
    // Line breaks
    markdown = markdown.replace(/<br\s*\/?>/gi, '\n');
    markdown = markdown.replace(/<hr\s*\/?>/gi, '\n---\n');
    
    // Paragraphs - convert to double line breaks
    markdown = markdown.replace(/<\/p>\s*<p[^>]*>/gi, '\n\n');
    markdown = markdown.replace(/<p[^>]*>/gi, '');
    markdown = markdown.replace(/<\/p>/gi, '\n\n');
    
    // Links
    markdown = markdown.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, '[$2]($1)');
    
    // Images
    markdown = markdown.replace(/<img[^>]*src=["']([^"']*)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi, '![$2]($1)');
    markdown = markdown.replace(/<img[^>]*src=["']([^"']*)["'][^>]*>/gi, '![]($1)');
    
    // Highlight marks → ==text== (must come before generic tag removal)
    markdown = markdown.replace(/<mark[^>]*>(.*?)<\/mark>/gi, '==$1==');
    
    // Remove remaining HTML tags
    markdown = markdown.replace(/<[^>]+>/g, '');
    
    // Decode HTML entities
    markdown = markdown.replace(/&nbsp;/g, ' ');
    markdown = markdown.replace(/&amp;/g, '&');
    markdown = markdown.replace(/&lt;/g, '<');
    markdown = markdown.replace(/&gt;/g, '>');
    markdown = markdown.replace(/&quot;/g, '"');
    markdown = markdown.replace(/&#39;/g, "'");
    
    // Clean up excessive line breaks
    markdown = markdown.replace(/\n{3,}/g, '\n\n');
    markdown = markdown.trim();
    
    return markdown;
}

/* ========== SETTINGS ========== */

// Batch convert all HTML documents to Markdown
function convertAllDocumentsToPlainText() {
    if (!confirm('Convert all documents from HTML to Markdown? This will preserve formatting like bold, italic, headers, etc.')) {
        return;
    }
    
    let converted = 0;
    
    documents.forEach(doc => {
        if (doc.content && doc.content.includes('<') && doc.content.includes('>')) {
            // Convert HTML to Markdown (preserves formatting)
            doc.content = htmlToMarkdown(doc.content);
            converted++;
        }
    });
    
    if (converted > 0) {
        autoSave();
        showToast(`Converted ${converted} document(s) to Markdown! 📝`);
        
        // Reload current document if one is open
        if (currentDocumentId) {
            loadDocumentToEditor();
        }
    } else {
        showToast('No HTML documents found to convert.');
    }
}

/* ========== SETTINGS ========== */

function openSettingsModal() {
    document.getElementById('customSystemPrompt').value = settings.customSystemPrompt || DEFAULT_SYSTEM_PROMPT;
    document.getElementById('customUserPrompt').value = settings.customUserPrompt || DEFAULT_USER_PROMPT;
    document.getElementById('continueUserPromptInput').value = settings.continueUserPrompt || DEFAULT_CONTINUE_USER_PROMPT;
    document.getElementById('goUserPromptInput').value = settings.goUserPrompt || DEFAULT_GO_USER_PROMPT;
    
    // Show current API key (masked)
    const settingsApiKeyField = document.getElementById('settingsApiKey');
    if (apiKey) {
        // Show a masked version as placeholder
        settingsApiKeyField.placeholder = '••••••••' + apiKey.slice(-8);
    } else {
        settingsApiKeyField.placeholder = 'sk-or-...';
    }
    settingsApiKeyField.value = '';
    
    // Populate AI-isms list
    document.getElementById('aiismsList').value = settings.aiismsList || DEFAULT_AIISMS;
    
    // Initialize theme color pickers with current values
    initializeThemeColorPickers();
    
    document.getElementById('settingsModal').style.display = 'flex';
}

function closeSettingsModal() {
    document.getElementById('settingsModal').style.display = 'none';
}

function saveSettings() {
    settings.theme = document.getElementById('themeSelect').value;

    // Save to localStorage for instant load on next visit
    localStorage.setItem('poeTheme', settings.theme);

    settings.fontSize = parseInt(document.getElementById('fontSizeSelect').value);
    settings.fontFamily = document.getElementById('fontFamilySelect').value;
    settings.autoSaveInterval = parseInt(document.getElementById('autoSaveInterval').value);
    
    applyTheme(settings.theme);
    applyFontSettings(settings.fontSize, settings.fontFamily);
    
    autoSave();
    showToast('Settings saved');
}

function saveCustomPrompts() {
    const systemPrompt = document.getElementById('customSystemPrompt').value.trim();
    const userPrompt = document.getElementById('customUserPrompt').value.trim();
    const continuePrompt = document.getElementById('continueUserPromptInput').value.trim();
    const goPrompt = document.getElementById('goUserPromptInput').value.trim();
    
    if (!systemPrompt || !userPrompt) {
        showToast('System and User prompts cannot be empty');
        return;
    }
    
    settings.customSystemPrompt = systemPrompt;
    settings.customUserPrompt = userPrompt;
    settings.continueUserPrompt = continuePrompt || null;
    settings.goUserPrompt = goPrompt || null;
    
    autoSave();
    showToast('Custom prompts saved! ✅');
}

function restoreDefaultPrompts() {
    if (!confirm('Restore default prompts? Your custom prompts will be lost.')) return;
    
    settings.customSystemPrompt = null;
    settings.customUserPrompt = null;
    settings.continueUserPrompt = null;
    settings.goUserPrompt = null;
    
    document.getElementById('customSystemPrompt').value = DEFAULT_SYSTEM_PROMPT;
    document.getElementById('customUserPrompt').value = DEFAULT_USER_PROMPT;
    document.getElementById('continueUserPromptInput').value = DEFAULT_CONTINUE_USER_PROMPT;
    document.getElementById('goUserPromptInput').value = DEFAULT_GO_USER_PROMPT;
    
    autoSave();
    showToast('Default prompts restored! 🔄');
}

function saveAIisms() {
    const aiismsText = document.getElementById('aiismsList').value.trim();
    
    if (!aiismsText) {
        showToast('AI-isms list cannot be empty');
        return;
    }
    
    settings.aiismsList = aiismsText;
    autoSave();
    showToast('AI-isms saved! ✅');
    
    // Refresh highlighting if we're viewing a Chapter document
    const currentDoc = documents.find(d => d.id === currentDocumentId);
    if (currentDoc && currentDoc.type === 'Chapter') {
        refreshAIismHighlights();
    }
}

function restoreDefaultAIisms() {
    if (!confirm('Restore default AI-isms list? Your custom list will be lost.')) return;
    
    settings.aiismsList = null;
    document.getElementById('aiismsList').value = DEFAULT_AIISMS;
    
    autoSave();
    showToast('Default AI-isms restored! 🔄');
}

function applyTheme(themeName) {
    if (themeName === 'default') {
        document.documentElement.removeAttribute('data-theme');
    } else {
        document.documentElement.setAttribute('data-theme', themeName);
    }
    
    // Apply custom theme colors if they exist
    applyCustomThemeColors();
    
    // Apply CodeMirror theme
    if (cmEditor) {
        applyCMTheme(themeName);
    }
}

function applyFontSettings(fontSize, fontFamily) {
    const fontMap = {
        'georgia': "'Georgia', 'Times New Roman', serif",
        'times': "'Times New Roman', Times, serif",
        'palatino': "'Palatino Linotype', 'Book Antiqua', Palatino, serif",
        'garamond': "'Garamond', 'Baskerville', serif",
        'merriweather': "'Merriweather', Georgia, serif",
        'system': "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif",
        'arial': "Arial, Helvetica, sans-serif",
        'helvetica': "'Helvetica Neue', Helvetica, Arial, sans-serif",
        'verdana': "Verdana, Geneva, sans-serif",
        'lato': "'Lato', Arial, sans-serif",
        'mono': "'Courier New', Courier, monospace",
        'consolas': "Consolas, 'Courier New', monospace",
        'fira': "'Fira Code', Consolas, monospace"
    };
    
    const fontFamilyCSS = fontMap[fontFamily] || fontMap['georgia'];
    
    // Apply to CodeMirror
    const cmElement = document.querySelector('.CodeMirror');
    if (cmElement) {
        cmElement.style.fontSize = fontSize + 'px';
        cmElement.style.fontFamily = fontFamilyCSS;
        if (cmEditor) {
            cmEditor.refresh();
        }
    }
    
    // Apply to Preview
    const previewElement = document.querySelector('.markdown-preview');
    if (previewElement) {
        previewElement.style.fontSize = fontSize + 'px';
        previewElement.style.fontFamily = fontFamilyCSS;
    }
}

/* ========== UI FUNCTIONS ========== */

function switchSidebarTab(tabName) {
    document.querySelectorAll('.sidebar-tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.sidebar-tab-content').forEach(content => content.classList.remove('active'));

    event.target.classList.add('active');
    document.getElementById(`sidebar-${tabName}-tab`).classList.add('active');
}

function switchSettingsTab(tabName) {
    document.querySelectorAll('.settings-tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.settings-tab-content').forEach(content => content.classList.remove('active'));

    event.target.classList.add('active');
    document.getElementById(`settings-${tabName}-tab`).classList.add('active');
}

function switchTab(tabName) {
    // Update nav buttons in sidebar
    document.querySelectorAll('.sidebar-nav-btn').forEach(btn => btn.classList.remove('active'));
    const navBtn = document.getElementById(`nav-${tabName}`);
    if (navBtn) navBtn.classList.add('active');

    // Toggle the write-tab (editor) and projects-view
    const writeTab = document.getElementById('write-tab');
    const projectsView = document.getElementById('projects-view');

    if (tabName === 'write') {
        if (writeTab) writeTab.style.display = 'flex';
        if (projectsView) projectsView.style.display = 'none';
    } else {
        if (writeTab) writeTab.style.display = 'none';
        if (projectsView) projectsView.style.display = 'flex';
        updateProjectsList();
    }

    // Hide floating toolbar if not on write tab
    updateFloatingToolbarVisibility();

    // Also hide context menu
    const contextMenu = document.getElementById('contextImproveMenu');
    if (contextMenu) contextMenu.style.display = 'none';
}

function toggleMenu() {
    const menu = document.getElementById('menu');
    const hamburger = document.getElementById('hamburger');
    const overlay = document.getElementById('menuOverlay');
    
    menu.classList.toggle('open');
    hamburger.classList.toggle('open');
    overlay.classList.toggle('open');
}

function closeMenu() {
    document.getElementById('menu').classList.remove('open');
    document.getElementById('hamburger').classList.remove('open');
    document.getElementById('menuOverlay').classList.remove('open');
}

function showToast(message, duration = 3000) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), duration);
}

function toggleExpand() {
    document.body.classList.toggle('expanded-mode');
    
    // Note: toggleExpand and addToolbarTooltips are legacy Quill functions
    // CodeMirror doesn't have a toolbar, so these are no longer used
}

/* ========== PROJECT EDITING ========== */

function openEditProjectModal(projectId) {
    const project = projects.find(p => p.id === projectId);
    if (!project) return;
    
    document.getElementById('editProjectId').value = project.id;
    document.getElementById('editProjectTitle').value = project.title;
    document.getElementById('editProjectGenre').value = project.genre;
    document.getElementById('editProjectDescription').value = project.description || '';
    document.getElementById('editProjectWordCount').value = project.targetWordCount || 0;
    
    document.getElementById('editProjectModal').style.display = 'flex';
    document.getElementById('editProjectTitle').focus();
}

function closeEditProjectModal() {
    document.getElementById('editProjectModal').style.display = 'none';
    document.getElementById('editProjectForm').reset();
}

function updateProject(event) {
    event.preventDefault();
    
    const projectId = parseInt(document.getElementById('editProjectId').value);
    const project = projects.find(p => p.id === projectId);
    
    if (!project) {
        showToast('Project not found');
        return;
    }
    
    project.title = document.getElementById('editProjectTitle').value.trim();
    project.genre = document.getElementById('editProjectGenre').value;
    project.description = document.getElementById('editProjectDescription').value.trim();
    project.targetWordCount = parseInt(document.getElementById('editProjectWordCount').value) || 0;
    project.updated = new Date().toISOString();
    
    autoSave();
    updateProjectsList();
    updateProjectDropdown();
    closeEditProjectModal();
    showToast(`Project "${project.title}" updated! ✅`);
}

/* ========== PROJECT COPYING ========== */

function copyProject(projectId) {
    const project = projects.find(p => p.id === projectId);
    if (!project) return;
    
    if (!confirm(`Create a copy of "${project.title}"?`)) return;
    
    // Create new project with copied data
    const newProject = {
        id: Date.now(),
        title: `${project.title} (Copy)`,
        genre: project.genre,
        description: project.description,
        targetWordCount: project.targetWordCount,
        currentWordCount: 0,
        order: projects.length, // Put at end
        created: new Date().toISOString(),
        updated: new Date().toISOString()
    };
    
    projects.push(newProject);
    
    // Copy all documents from original project
    const projectDocs = documents.filter(d => d.projectId === projectId);
    projectDocs.forEach((doc, index) => {
        const newDoc = {
            id: Date.now() + index, // Ensure unique integer ID
            projectId: newProject.id,
            title: doc.title,
            type: doc.type,
            content: doc.content,
            wordCount: doc.wordCount,
            enabled: doc.enabled,
            order: doc.order,
            created: new Date().toISOString(),
            updated: new Date().toISOString()
        };
        documents.push(newDoc);
    });
    
    autoSave();
    updateProjectsList();
    updateProjectDropdown();
    showToast(`Project copied! Created "${newProject.title}" 📋`);
}

/* ========== FIX BROKEN DOCUMENT IDs ========== */

function fixBrokenDocumentIds() {
    let fixed = 0;
    const seenIds = new Set();
    
    documents.forEach(doc => {
        // Fix decimal IDs
        if (!Number.isInteger(doc.id)) {
            const newId = Date.now() + fixed;
            console.log(`Fixing decimal ID ${doc.id} -> ${newId}`);
            doc.id = newId;
            fixed++;
        }
        
        // Fix duplicate IDs
        if (seenIds.has(doc.id)) {
            const newId = Date.now() + fixed;
            console.log(`Fixing duplicate ID ${doc.id} -> ${newId}`);
            doc.id = newId;
            fixed++;
        }
        
        seenIds.add(doc.id);
    });
    
    if (fixed > 0) {
        autoSave();
        updateDocumentsList();
        showToast(`Fixed ${fixed} broken document ID(s) ✅`);
        console.log(`Fixed ${fixed} document IDs`);
    } else {
        showToast('All document IDs are valid ✓');
    }
}

/* ========== PROJECT DRAG & DROP ========== */

let draggedProject = null;

function handleProjectDragStart(e) {
    draggedProject = e.currentTarget;
    draggedProject.style.opacity = '0.4';
    e.dataTransfer.effectAllowed = 'move';
}

function handleProjectDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    e.dataTransfer.dropEffect = 'move';
    
    const target = e.target.closest('.project-card');
    if (target && target !== draggedProject) {
        const rect = target.getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        
        // Clear all borders first
        document.querySelectorAll('.project-card').forEach(card => {
            card.style.borderTop = '';
            card.style.borderBottom = '';
        });
        
        if (e.clientY < midpoint) {
            target.style.borderTop = '3px solid var(--accent-primary)';
        } else {
            target.style.borderBottom = '3px solid var(--accent-primary)';
        }
    }
    
    return false;
}

function handleProjectDrop(e) {
    if (e.stopPropagation) {
        e.stopPropagation();
    }
    
    const target = e.target.closest('.project-card');
    if (draggedProject && target && draggedProject !== target) {
        const draggedId = parseInt(draggedProject.dataset.projectId);
        const targetId = parseInt(target.dataset.projectId);
        
        const draggedProj = projects.find(p => p.id === draggedId);
        const targetProj = projects.find(p => p.id === targetId);
        
        if (draggedProj && targetProj) {
            // Initialize order if missing
            projects.forEach((p, idx) => {
                if (p.order === undefined) p.order = idx;
            });
            
            // Sort by current order
            projects.sort((a, b) => (a.order || 0) - (b.order || 0));
            
            // Find current positions
            const draggedIndex = projects.findIndex(p => p.id === draggedId);
            const targetIndex = projects.findIndex(p => p.id === targetId);
            
            // Remove dragged project
            const [removed] = projects.splice(draggedIndex, 1);
            
            // Determine insert position
            const rect = target.getBoundingClientRect();
            const midpoint = rect.top + rect.height / 2;
            let insertIndex = targetIndex;
            
            if (draggedIndex < targetIndex) {
                insertIndex = e.clientY < midpoint ? targetIndex - 1 : targetIndex;
            } else {
                insertIndex = e.clientY < midpoint ? targetIndex : targetIndex + 1;
            }
            
            // Insert at new position
            projects.splice(insertIndex, 0, removed);
            
            // Reassign orders
            projects.forEach((p, index) => {
                p.order = index;
            });
            
            autoSave();
            updateProjectsList();
        }
    }
    
    // Clear border indicators
    document.querySelectorAll('.project-card').forEach(card => {
        card.style.borderTop = '';
        card.style.borderBottom = '';
    });
    
    return false;
}

function handleProjectDragEnd(e) {
    if (draggedProject) {
        draggedProject.style.opacity = '1';
    }
    
    // Clear all border indicators
    document.querySelectorAll('.project-card').forEach(card => {
        card.style.borderTop = '';
        card.style.borderBottom = '';
    });
    
    draggedProject = null;
}

// ========== COMPLETE CHAT FUNCTIONS WITH SCROLL FIXES ==========

function loadChatHistory() {
    const container = document.getElementById('chatMessages');
    if (!container) return;

    container.innerHTML = '';
    
    if (chatHistory.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--text-tertiary); padding:20px; font-size:12px;">Start a conversation with Poe...</p>';
        return;
    }

    chatHistory.forEach(msg => {
        appendChatMessage(msg.role, msg.content, false);
    });

    // CHANGE 1: Scroll to bottom after loading all messages
    setTimeout(() => {
        container.scrollTop = container.scrollHeight;
    }, 100);
}

function appendChatMessage(role, content, shouldSave = true) {
    const container = document.getElementById('chatMessages');
    if (!container) return;

    const emptyMsg = container.querySelector('p');
    if (emptyMsg && emptyMsg.textContent.includes('Start a conversation')) {
        emptyMsg.remove();
    }

    const messageDiv = document.createElement('div');
    messageDiv.className = `chat-message ${role}`;

    const header = document.createElement('div');
    header.className = 'chat-message-header';
    
    const poeIcon = `<img src="Poe.png" class="chat-header-icon" alt="Robot">`;
    
    header.innerHTML = role === 'user' 
        ? '👤 You' 
        : `${poeIcon} Poe`;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'chat-message-content';
    contentDiv.textContent = content;

    messageDiv.appendChild(header);
    messageDiv.appendChild(contentDiv);

    if (role === 'assistant') {
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'chat-message-actions';

        const insertBtn = document.createElement('button');
        insertBtn.className = 'chat-action-btn';
        insertBtn.textContent = '📝 Insert';
        insertBtn.onclick = () => insertChatMessage(content);

        const copyBtn = document.createElement('button');
        copyBtn.className = 'chat-action-btn';
        copyBtn.textContent = '📋 Copy';
        copyBtn.onclick = () => copyChatMessage(content);

        actionsDiv.appendChild(insertBtn);
        actionsDiv.appendChild(copyBtn);
        messageDiv.appendChild(actionsDiv);
    }

    container.appendChild(messageDiv);
    
    // CHANGE 2: Smooth scroll to bottom to show the new message
    setTimeout(() => {
        container.scrollTop = container.scrollHeight;
    }, 50);

    if (shouldSave) {
        chatHistory.push({ role, content, timestamp: new Date().toISOString() });
        autoSave();
    }
}

async function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const sendBtn = document.querySelector('.chat-send-btn');
    
    if (!input || !sendBtn) return;

    const message = input.value.trim();
    if (!message) {
        showToast('Please enter a message');
        return;
    }

    if (!apiKey) {
        showToast('Please add an API key in Settings');
        return;
    }

    input.disabled = true;
    sendBtn.disabled = true;
    const originalBtnText = sendBtn.innerHTML;
    sendBtn.innerHTML = '<span>Sending...</span><span class="send-icon">⏳</span>';

    appendChatMessage('user', message);
    input.value = '';

    const container = document.getElementById('chatMessages');
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'chat-loading';
    loadingDiv.innerHTML = `
        <span>AI is thinking</span>
        <div class="chat-loading-dots">
            <div class="chat-loading-dot"></div>
            <div class="chat-loading-dot"></div>
            <div class="chat-loading-dot"></div>
        </div>
    `;
    container.appendChild(loadingDiv);
    
    // CHANGE 3: Smooth scroll to show loading indicator
    setTimeout(() => {
        container.scrollTop = container.scrollHeight;
    }, 50);

    try {
        const model = document.getElementById('modelSelect').value;
        const temperature = parseFloat(document.getElementById('temperature').value);

        let contextText = '';
        
        if (currentDocumentId) {
            const currentDoc = documents.find(d => d.id === currentDocumentId);
            if (currentDoc) {
                const docText = cmEditor.getValue();
                if (docText.trim().length > 0) {
                    contextText += `\n\nCurrent document "${currentDoc.title}":\n${docText.slice(-2000)}`;
                }
            }
        }

        if (currentProjectId) {
            const enabledDocs = documents
                .filter(d => d.projectId === currentProjectId && d.enabled && d.id !== currentDocumentId)
                .sort((a, b) => a.order - b.order);
            
            if (enabledDocs.length > 0) {
                contextText += '\n\nContext documents:\n';
                enabledDocs.forEach(doc => {
                    const docText = new DOMParser().parseFromString(doc.content, 'text/html').body.textContent || '';
                    contextText += `\n--- ${doc.type}: ${doc.title} ---\n${docText.slice(0, 1000)}\n`;
                });
            }
        }

        const systemPrompt = `You are Poe, a helpful AI writing assistant. You help writers with their creative projects.${contextText ? '\n\nContext about the current project:' + contextText : ''}`;

        const messages = [{ role: 'system', content: systemPrompt }];
        
        const recentHistory = chatHistory.slice(-10);
        recentHistory.forEach(msg => {
            messages.push({ role: msg.role, content: msg.content });
        });

        messages.push({ role: 'user', content: message });

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': window.location.origin,
                'X-Title': 'Poe Write'
            },
            body: JSON.stringify({
                model: model,
                messages: messages,
                temperature: temperature,
                max_tokens: 2048
            })
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();
        const aiResponse = data.choices[0].message.content.trim();

        loadingDiv.remove();
        appendChatMessage('assistant', aiResponse);

    } catch (error) {
        console.error('Chat error:', error);
        loadingDiv.remove();
        showToast('Failed to send message. Check your API key.');
    } finally {
        input.disabled = false;
        sendBtn.disabled = false;
        sendBtn.innerHTML = originalBtnText;
        input.focus();
    }
}

function insertChatMessage(content) {
    if (!currentDocumentId) {
        showToast('Please select a document first');
        return;
    }

    const cursor = cmEditor.getCursor();
    cmEditor.replaceRange('\n\n' + content, cursor);
    hasUnsavedChanges = true;
    updateWordCount();
    showToast('Text inserted! 📝');
}

function copyChatMessage(content) {
    navigator.clipboard.writeText(content).then(() => {
        showToast('Copied to clipboard! 📋');
    }).catch(() => {
        showToast('Failed to copy');
    });
}

function clearChatHistory() {
    if (!confirm('Clear all chat history?')) return;

    chatHistory = [];
    autoSave();
    loadChatHistory();
    showToast('Chat history cleared');
}

// Add these functions to app.js for editing document names

function openEditDocumentModal(docId) {
    const doc = documents.find(d => d.id === docId);
    if (!doc) return;
    
    document.getElementById('editDocumentId').value = doc.id;
    document.getElementById('editDocumentTitle').value = doc.title;
    document.getElementById('editDocumentType').value = doc.type;
    
    document.getElementById('editDocumentModal').style.display = 'flex';
    document.getElementById('editDocumentTitle').focus();
    document.getElementById('editDocumentTitle').select();
}

function closeEditDocumentModal() {
    document.getElementById('editDocumentModal').style.display = 'none';
    document.getElementById('editDocumentForm').reset();
}

function updateDocument(event) {
    event.preventDefault();
    
    const docId = parseInt(document.getElementById('editDocumentId').value);
    const doc = documents.find(d => d.id === docId);
    
    if (!doc) {
        showToast('Document not found');
        return;
    }
    
    const newTitle = document.getElementById('editDocumentTitle').value.trim();
    const newType = document.getElementById('editDocumentType').value;
    
    if (!newTitle) {
        showToast('Document title cannot be empty');
        return;
    }
    
    doc.title = newTitle;
    doc.type = newType;
    doc.updated = new Date().toISOString();
    
    autoSave();
    updateDocumentsList();
    
    // Update document info header if this is the current document
    if (currentDocumentId === docId) {
        document.getElementById('documentTitle').textContent = newTitle;
        document.getElementById('documentType').textContent = newType;
    }
    
    closeEditDocumentModal();
    showToast(`Document updated! ✅`);
}

function openAboutModal() {
    document.getElementById('aboutModal').style.display = 'flex';
}

function closeAboutModal() {
    document.getElementById('aboutModal').style.display = 'none';
}

/* ========== EXTERNAL EDITOR (Grammarly Compatible) ========== */

function openExternalEditor() {
    if (!currentDocumentId) {
        showToast('Please open a document first');
        return;
    }
    
    // Get current document content
    const content = cmEditor.getValue();
    
    // Populate the external editor textarea
    document.getElementById('externalEditorTextarea').value = content;
    
    // Show the modal
    document.getElementById('externalEditorModal').style.display = 'flex';
    
    // Focus the textarea
    setTimeout(() => {
        document.getElementById('externalEditorTextarea').focus();
    }, 100);
}

function closeExternalEditor() {
    document.getElementById('externalEditorModal').style.display = 'none';
}

function applyExternalEditorChanges() {
    if (!currentDocumentId) {
        showToast('No document is currently open');
        closeExternalEditor();
        return;
    }
    
    // Get the edited content
    const newContent = document.getElementById('externalEditorTextarea').value;
    
    // Update the CodeMirror editor
    cmEditor.setValue(newContent);
    
    // Mark as having unsaved changes
    hasUnsavedChanges = true;
    
    // Save the document
    saveDocument(false);
    
    // Close the modal
    closeExternalEditor();
    
    showToast('Changes applied! 📝');
}

/* ========== EXPORT TO MARKDOWN ========== */

function exportProjectToMarkdown() {
    // 1. Validation
    if (!currentProjectId) {
        showToast('Please select a project to export.');
        return;
    }
    
    if (!window.TurndownService) {
        showToast('Export library missing. Check internet connection.');
        return;
    }

    const project = projects.find(p => p.id === currentProjectId);
    if (!project) return;

    // 2. Get Enabled Documents & Sort
    const enabledDocs = documents
        .filter(d => d.projectId === currentProjectId && d.enabled)
        .sort((a, b) => (a.order || 0) - (b.order || 0));

    if (enabledDocs.length === 0) {
        showToast('No enabled documents to export.');
        return;
    }

    // 3. Initialize Converter
    const turndownService = new TurndownService({
        headingStyle: 'atx',      // Use # for headings
        codeBlockStyle: 'fenced', // Use ``` for code
        hr: '---'                 // Use --- for horizontal rules
    });

    // 4. Build the Content
    let fullText = `# ${project.title}\n`;
    if (project.description) {
        fullText += `*${project.description}*\n`;
    }
    fullText += `\n---\n\n`;

    enabledDocs.forEach(doc => {
        // Add Chapter Title
        fullText += `# ${doc.title}\n\n`;
        
        // Convert HTML Content to Markdown
        // We wrap in a try-catch just in case specific HTML breaks the parser
        try {
            const content = doc.content || '';
            // Convert to MD
            const markdown = turndownService.turndown(content);
            fullText += markdown;
        } catch (e) {
            console.error(`Error converting doc ${doc.id}`, e);
            fullText += `[Error converting content for: ${doc.title}]`;
        }

        // Add spacing between chapters
        fullText += `\n\n\n***\n\n\n`; 
    });

    // 5. Trigger Download
    const blob = new Blob([fullText], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    
    // Clean filename
    const safeTitle = project.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    
    a.href = url;
    a.download = `${safeTitle}_full_draft.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('Project exported as Markdown! 📚');
    closeMenu(); // Close the sidebar menu if open
}

// Add these functions after the toggleDocument() function (around line 580)

function toggleAllDocuments() {
    if (!currentProjectId) {
        showToast('Please select a project first');
        return;
    }
    
    const masterToggle = document.getElementById('masterDocumentToggle');
    const newState = masterToggle.checked;
    
    // Get all documents in current project
    const projectDocs = documents.filter(d => d.projectId === currentProjectId);
    
    if (projectDocs.length === 0) {
        showToast('No documents to toggle');
        return;
    }
    
    // Update all documents
    projectDocs.forEach(doc => {
        doc.enabled = newState;
    });
    
    autoSave();
    updateDocumentsList();
    
    const action = newState ? 'enabled' : 'disabled';
    showToast(`All documents ${action} ✨`);
}

// Modify the existing toggleDocument function to update master toggle
function toggleDocument(id) {
    const doc = documents.find(d => d.id === id);
    if (!doc) return;

    doc.enabled = !doc.enabled;
    autoSave();
    updateDocumentsList();
    updateMasterToggleState(); // Add this line
}

// Add this new function to sync the master toggle state
function updateMasterToggleState() {
    if (!currentProjectId) return;
    
    const masterToggle = document.getElementById('masterDocumentToggle');
    if (!masterToggle) return;
    
    const projectDocs = documents.filter(d => d.projectId === currentProjectId);
    
    if (projectDocs.length === 0) {
        masterToggle.checked = false;
        masterToggle.disabled = true;
        return;
    }
    
    masterToggle.disabled = false;
    
    // Check if all documents are enabled
    const allEnabled = projectDocs.every(d => d.enabled);
    const someEnabled = projectDocs.some(d => d.enabled);
    
    masterToggle.checked = allEnabled;
    
    // Optional: Make it indeterminate if only some are enabled
    masterToggle.indeterminate = someEnabled && !allEnabled;
}

/* ========== SEARCH & REPLACE LOGIC ========== */

function toggleSearchReplace() {
    const bar = document.getElementById('searchReplaceBar');
    const isVisible = bar.style.display !== 'none';
    
    if (isVisible) {
        // Closing search - clear all highlights
        clearSearchHighlights();
        bar.style.display = 'none';
    } else {
        // Opening search
        bar.style.display = 'flex';
        document.getElementById('findInput').focus();
    }
}

// Global Keyboard Shortcut (Ctrl+F)
document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        toggleSearchReplace();
    }
    // Escape exits fullscreen
    if (e.key === 'Escape' && document.body.classList.contains('fullscreen-mode')) {
        toggleFullScreen();
    }
});

function updateSearchCount() {
    const query = document.getElementById('findInput').value;
    const countDisplay = document.getElementById('searchCount');
    
    // Clear previous markers
    clearSearchHighlights();
    
    if (!query) {
        countDisplay.textContent = '';
        return;
    }
    
    const text = cmEditor.getValue();
    const matches = [];
    let index = text.indexOf(query);
    
    // Find all matches and highlight them
    while (index !== -1) {
        matches.push(index);
        
        // Add highlight marker
        const from = cmEditor.posFromIndex(index);
        const to = cmEditor.posFromIndex(index + query.length);
        const marker = cmEditor.markText(from, to, {
            className: 'search-highlight'
        });
        searchMarkers.push(marker);
        
        index = text.indexOf(query, index + 1);
    }
    
    if (matches.length === 0) {
        countDisplay.textContent = '0 matches';
        countDisplay.style.color = '#999';
    } else {
        // Find which match we're currently on
        let currentMatch = 1;
        for (let i = 0; i < matches.length; i++) {
            if (matches[i] === lastSearchIndex) {
                currentMatch = i + 1;
                break;
            }
        }
        countDisplay.textContent = `${currentMatch} of ${matches.length}`;
        countDisplay.style.color = '#667eea';
    }
}

function clearSearchHighlights() {
    // Remove all search markers
    searchMarkers.forEach(marker => marker.clear());
    searchMarkers = [];
}

function findNext() {
    const query = document.getElementById('findInput').value;
    if (!query) return;

    const text = cmEditor.getValue();
    let index = text.indexOf(query, lastSearchIndex + 1);
    
    if (index === -1) index = text.indexOf(query); // Wrap around to start

    if (index !== -1) {
        const from = cmEditor.posFromIndex(index);
        const to = cmEditor.posFromIndex(index + query.length);
        cmEditor.setSelection(from, to);
        cmEditor.scrollIntoView({from, to});
        lastSearchIndex = index;
        updateSearchCount();
    } else {
        showToast("No matches found");
    }
}

function findPrev() {
    const query = document.getElementById('findInput').value;
    if (!query) return;

    const text = cmEditor.getValue();
    const searchArea = text.substring(0, lastSearchIndex);
    let index = searchArea.lastIndexOf(query);

    if (index === -1) index = text.lastIndexOf(query); // Wrap around to end

    if (index !== -1) {
        const from = cmEditor.posFromIndex(index);
        const to = cmEditor.posFromIndex(index + query.length);
        cmEditor.setSelection(from, to);
        cmEditor.scrollIntoView({from, to});
        lastSearchIndex = index;
        updateSearchCount();
    }
}

function replaceCurrent() {
    const findText = document.getElementById('findInput').value;
    const replaceText = document.getElementById('replaceInput').value;
    const selection = cmEditor.getSelection();

    if (selection && selection.length > 0) {
        cmEditor.replaceSelection(replaceText);
        updateSearchCount();
        findNext(); // Move to next automatically
    }
}

function replaceAll() {
    const findText = document.getElementById('findInput').value;
    const replaceText = document.getElementById('replaceInput').value;
    if (!findText) return;

    let text = cmEditor.getValue();
    const newText = text.split(findText).join(replaceText);
    const occurrences = (text.length - newText.length) / (findText.length - replaceText.length || 1);
    
    cmEditor.setValue(newText);
    lastSearchIndex = 0;
    updateSearchCount();
    
    showToast(`Replaced ${Math.floor(occurrences)} occurrences`);
}

// REPLACE with your Google Apps Script Web App URL
const CLOUD_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzqeZfVvvhm4eE3lz0niD6wIOhKQsn74pt90GNDY9ML90kY4Kc3fQzlKRkAOJpYiH9k/exec';

/**
 * MANUAL SAVE TO CLOUD
 */
async function saveToCloud() {
    // Note: Poe Write uses 'apiKey' for OpenRouter, 
    // we will use it as the encryption key for sync as well.
    if (!apiKey) {
        return showToast("❌ Please set your API Key in settings first to use sync.");
    }

    showToast("☁️ Saving to Google Drive...");
    const indicator = document.getElementById('syncIndicator');
    if (indicator) indicator.textContent = "Uploading...";

    // 1. Package Poe Write Data
    const dataToSync = {
        projects,
        documents,
        settings,
        lastBackup: new Date().toISOString()
    };

    try {
        // 2. Encrypt
        const encrypted = CryptoJS.AES.encrypt(JSON.stringify(dataToSync), apiKey).toString();

        // 3. Send to Google
        await fetch(CLOUD_SCRIPT_URL, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: encrypted })
        });

        const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (indicator) indicator.textContent = `✅ Last synced: ${now}`;
        showToast("✅ Backup Successful!");

    } catch (error) {
        console.error("Cloud Save Error:", error);
        showToast("❌ Backup failed.");
        if (indicator) indicator.textContent = "❌ Sync error";
    }
}

/**
 * MANUAL LOAD FROM CLOUD
 */
async function loadFromCloud() {
    if (!apiKey) return showToast("❌ Set your API Key first!");
    
    if (!confirm("Overwrite all local projects and documents with the cloud backup?")) return;

    showToast("🔄 Fetching from Drive...");
    const indicator = document.getElementById('syncIndicator');

    try {
        const response = await fetch(CLOUD_SCRIPT_URL);
        const encryptedData = await response.text();

        if (encryptedData === "FILE_NOT_FOUND") {
            return showToast("❓ No backup found on Drive.");
        }

        // 1. Decrypt & Verify
        const bytes = CryptoJS.AES.decrypt(encryptedData, apiKey);
        let decryptedString;
        
        try {
            decryptedString = bytes.toString(CryptoJS.enc.Utf8);
            if (!decryptedString) throw new Error("Invalid Key");
        } catch (e) {
            if (indicator) indicator.textContent = "❌ Wrong Key";
            return showToast("❌ Encryption Error: Is your API Key correct?");
        }

        // 2. Update App State
        const data = JSON.parse(decryptedString);
        projects = data.projects || [];
        documents = data.documents || [];
        settings = data.settings || settings;

        // 3. Save to local IndexedDB
        // Poe Write uses its own internal saveDB function
        await saveDB(); 
        
        showToast("✅ Restore Complete!");

        // 4. Reload to refresh the editor and file list
        setTimeout(() => {
            location.reload();
        }, 1200);

    } catch (error) {
        console.error("Cloud Load Error:", error);
        showToast("❌ Restore failed.");
    }
}

/* ========== FLOATING AI TOOLBAR ========== */

let isDraggingToolbar = false;
let toolbarOffset = { x: 0, y: 0 };

// Make toolbar draggable with boundary checking
document.addEventListener('DOMContentLoaded', function() {
    const toolbar = document.getElementById('floatingAiToolbar');
    const toggleBtn = toolbar?.querySelector('.toolbar-toggle-btn');
    
    if (!toggleBtn) return;
    
    toggleBtn.addEventListener('mousedown', function(e) {
        if (e.button !== 0) return; // Only left click
        
        isDraggingToolbar = true;
        toolbar.classList.add('dragging');
        
        const rect = toolbar.getBoundingClientRect();
        toolbarOffset.x = e.clientX - rect.left;
        toolbarOffset.y = e.clientY - rect.top;
        
        e.preventDefault();
    });
    
    document.addEventListener('mousemove', function(e) {
        if (!isDraggingToolbar) return;
        
        // Calculate desired position
        let x = e.clientX - toolbarOffset.x;
        let y = e.clientY - toolbarOffset.y;
        
        // Get toolbar dimensions
        const rect = toolbar.getBoundingClientRect();
        const toolbarWidth = rect.width;
        const toolbarHeight = rect.height;
        
        // Get viewport dimensions
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        // Constrain to viewport boundaries with padding
        const padding = 10;
        x = Math.max(padding, Math.min(x, viewportWidth - toolbarWidth - padding));
        y = Math.max(padding, Math.min(y, viewportHeight - toolbarHeight - padding));
        
        toolbar.style.left = x + 'px';
        toolbar.style.top = y + 'px';
        toolbar.style.right = 'auto';
        toolbar.style.bottom = 'auto';
    });
    
    document.addEventListener('mouseup', function() {
        if (isDraggingToolbar) {
            isDraggingToolbar = false;
            toolbar.classList.remove('dragging');
            
            // Final boundary check after drop
            ensureToolbarVisible();
        }
    });
    
    // Check boundaries when toolbar expands/collapses
    toolbar.addEventListener('transitionend', function() {
        ensureToolbarVisible();
    });
    
    // Check boundaries on window resize
    window.addEventListener('resize', function() {
        ensureToolbarVisible();
    });
});

// Function to ensure toolbar stays within viewport
function ensureToolbarVisible() {
    const toolbar = document.getElementById('floatingAiToolbar');
    if (!toolbar) return;
    
    const rect = toolbar.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const padding = 10;
    
    let needsAdjustment = false;
    let newLeft = rect.left;
    let newTop = rect.top;
    
    // Check right boundary
    if (rect.right > viewportWidth - padding) {
        newLeft = viewportWidth - rect.width - padding;
        needsAdjustment = true;
    }
    
    // Check left boundary
    if (rect.left < padding) {
        newLeft = padding;
        needsAdjustment = true;
    }
    
    // Check bottom boundary
    if (rect.bottom > viewportHeight - padding) {
        newTop = viewportHeight - rect.height - padding;
        needsAdjustment = true;
    }
    
    // Check top boundary
    if (rect.top < padding) {
        newTop = padding;
        needsAdjustment = true;
    }
    
    // Apply adjustments if needed
    if (needsAdjustment) {
        toolbar.classList.add('boundary-hit');
        setTimeout(() => toolbar.classList.remove('boundary-hit'), 500);
        toolbar.style.left = newLeft + 'px';
        toolbar.style.top = newTop + 'px';
        toolbar.style.right = 'auto';
        toolbar.style.bottom = 'auto';
    }
}

// Also update toggleAiToolbar to check boundaries after toggle
function toggleAiToolbar() {
    const toolbar = document.getElementById('floatingAiToolbar');
    const wasCollapsed = toolbar.classList.contains('collapsed');
    
    toolbar.classList.toggle('collapsed');
    
    // If expanding, check if there's space below
    if (wasCollapsed) {
        setTimeout(() => {
            const rect = toolbar.getBoundingClientRect();
            const viewportHeight = window.innerHeight;
            const spaceBelow = viewportHeight - rect.top;
            const toolbarHeight = rect.height;
            
            // If not enough space below, move it up
            if (spaceBelow < toolbarHeight + 20) {
                const newTop = Math.max(10, viewportHeight - toolbarHeight - 20);
                toolbar.style.top = newTop + 'px';
                toolbar.style.bottom = 'auto';
            }
        }, 50);
    }

    // Check boundaries after animation completes
    setTimeout(() => {
        ensureToolbarVisible();
    }, 350); // Match the CSS transition duration
}
    
    document.addEventListener('mouseup', function() {
        if (isDraggingToolbar) {
            isDraggingToolbar = false;
            const toolbar = document.getElementById('floatingAiToolbar');
            if (toolbar) {
                toolbar.classList.remove('dragging');
            }
        }
    });



/* ========== CONTEXT IMPROVE MENU ========== */

// Show context menu when text is selected
if (cmEditor) {
    cmEditor.on('cursorActivity', function() {
        const menu = document.getElementById('contextImproveMenu');
        const selection = cmEditor.getSelection();
        
        if (selection && selection.length > 10) {
            // Text is selected - show menu
            const cursor = cmEditor.getCursor('end');
            const coords = cmEditor.cursorCoords(cursor, 'page');
            const editorContainer = document.querySelector('.editor-container-new');
            const rect = editorContainer.getBoundingClientRect();
            
            // Position menu above or below selection
            const x = coords.left;
            const y = coords.top - 50; // Above selection
            
            menu.style.left = x + 'px';
            menu.style.top = y + 'px';
            menu.style.display = 'block';
            menu.style.transform = 'translateX(-50%)'; // Center horizontally
        } else {
            // No selection - hide menu
            menu.style.display = 'none';
        }
    });
}

// Hide context menu when clicking outside
document.addEventListener('click', function(e) {
    const menu = document.getElementById('contextImproveMenu');
    if (!menu.contains(e.target) && !e.target.closest('.CodeMirror')) {
        menu.style.display = 'none';
    }
});

/* ========== TAB-SPECIFIC TOOLBAR VISIBILITY (ROBUST VERSION) ========== */

function initializeFloatingToolbarVisibility() {
    const toolbar = document.getElementById('floatingAiToolbar');
    const writeTab = document.getElementById('write-tab');
    
    if (!toolbar || !writeTab) return;
    
    // Initial check
    updateFloatingToolbarVisibility();
    
    // Watch for tab changes using MutationObserver
    const observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
            if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                updateFloatingToolbarVisibility();
            }
        });
    });
    
    // Observe the write tab for class changes
    observer.observe(writeTab, {
        attributes: true,
        attributeFilter: ['class']
    });
}

function updateFloatingToolbarVisibility() {
    const toolbar = document.getElementById('floatingAiToolbar');
    const writeTab = document.getElementById('write-tab');
    
    if (!toolbar || !writeTab) return;
    
    // Show toolbar only when write tab is visible
    const isWriteVisible = writeTab.style.display !== 'none';
    toolbar.style.display = isWriteVisible ? 'flex' : 'none';
}

/* ========== HIGHLIGHT MARKER FUNCTIONS ========== */

/* ========== PREVIEW MODE HIGHLIGHT FUNCTIONS ========== */

// Apply highlight to selected text in preview mode
function applyHighlightInPreview() {
    const previewDiv = document.getElementById('preview');
    if (!previewDiv) return;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        showToast('Select text to highlight');
        return;
    }

    const range = sel.getRangeAt(0);

    // Ensure the selection is inside the preview div
    if (!previewDiv.contains(range.commonAncestorContainer)) {
        showToast('Select text inside the preview to highlight');
        return;
    }

    const color = getHighlightColor();

    // Create a <mark> element with the chosen color
    const mark = document.createElement('mark');
    mark.style.backgroundColor = color;

    try {
        // surroundContents works perfectly when selection doesn't cross element boundaries
        range.surroundContents(mark);
    } catch (e) {
        // If the selection crosses element boundaries, extract + wrap manually
        const fragment = range.extractContents();
        mark.appendChild(fragment);
        range.insertNode(mark);
    }

    // Collapse selection to avoid confusion
    sel.removeAllRanges();

    // Sync the updated preview HTML back to CodeMirror
    syncPreviewToCodeMirror();
    showToast('Highlighted! 🖍️');
    hasUnsavedChanges = true;
}

// Remove highlight from the <mark> element at the current cursor position in preview
function removeHighlightInPreview() {
    const previewDiv = document.getElementById('preview');
    if (!previewDiv) return;

    const sel = window.getSelection();
    let targetMark = null;

    if (sel && sel.rangeCount > 0) {
        // Walk up from the anchor node to find a <mark> ancestor
        let node = sel.getRangeAt(0).commonAncestorContainer;
        if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
        while (node && node !== previewDiv) {
            if (node.tagName === 'MARK') { targetMark = node; break; }
            node = node.parentNode;
        }
    }

    if (!targetMark) {
        showToast('Click inside a highlight to remove it');
        return;
    }

    // Unwrap: replace the <mark> with its children
    const parent = targetMark.parentNode;
    while (targetMark.firstChild) {
        parent.insertBefore(targetMark.firstChild, targetMark);
    }
    parent.removeChild(targetMark);

    // Sync back to CodeMirror
    syncPreviewToCodeMirror();
    showToast('Highlight removed');
    hasUnsavedChanges = true;
}

// Update all <mark> colors in preview when color picker changes
function updatePreviewHighlightColors(color) {
    const previewDiv = document.getElementById('preview');
    if (!previewDiv) return;
    previewDiv.querySelectorAll('mark').forEach(mark => {
        mark.style.backgroundColor = color;
    });
    // Sync so the markdown stores the new color on next edit
    syncPreviewToCodeMirror();
}

// Push current preview innerHTML into CodeMirror as markdown (shared sync helper)
function syncPreviewToCodeMirror() {
    const previewDiv = document.getElementById('preview');
    if (!previewDiv) return;
    const md = htmlToMarkdown(previewDiv.innerHTML);
    _previewUpdating = true;
    const scrollInfo = cmEditor.getScrollInfo();
    cmEditor.setValue(md);
    cmEditor.scrollTo(scrollInfo.left, scrollInfo.top);
    hasUnsavedChanges = true;
    updateWordCount();
    resetAutoSaveTimer();
    _previewUpdating = false;
}

let highlightMarkers = []; // Store all highlight markers

// Refresh all highlight markers in markdown mode
function refreshHighlightMarkers() {
    if (!cmEditor) return;
    
    // Clear existing markers
    highlightMarkers.forEach(marker => marker.clear());
    highlightMarkers = [];
    
    const content = cmEditor.getValue();
    const highlightRegex = /==([^=]+)==/g;
    let match;
    
    const color = settings.highlightColor || '#fff59d';
    
    while ((match = highlightRegex.exec(content)) !== null) {
        const fullStartPos = cmEditor.posFromIndex(match.index);
        const fullEndPos = cmEditor.posFromIndex(match.index + match[0].length);
        
        // Position of just the text content (without ==)
        const textStartPos = cmEditor.posFromIndex(match.index + 2);
        const textEndPos = cmEditor.posFromIndex(match.index + match[0].length - 2);
        
        // Hide the opening ==
        const openMarker = cmEditor.markText(fullStartPos, textStartPos, {
            css: `display: none;`,
            inclusiveLeft: false,
            inclusiveRight: false
        });
        highlightMarkers.push(openMarker);
        
        // Highlight the actual text content
        const textMarker = cmEditor.markText(textStartPos, textEndPos, {
            css: `background-color: ${color}; padding: 2px 0;`,
            inclusiveLeft: false,
            inclusiveRight: false
        });
        highlightMarkers.push(textMarker);
        
        // Hide the closing ==
        const closeMarker = cmEditor.markText(textEndPos, fullEndPos, {
            css: `display: none;`,
            inclusiveLeft: false,
            inclusiveRight: false
        });
        highlightMarkers.push(closeMarker);
    }
}

// Remove highlight from selected text
function removeHighlight() {
    if (!cmEditor) return;

    // Preview mode: find and unwrap the <mark> containing the cursor/selection
    if (currentEditorMode === 'preview') {
        removeHighlightInPreview();
        return;
    }
    
    const selection = cmEditor.getSelection();
    if (!selection) {
        showToast('Select highlighted text to remove');
        return;
    }
    
    const from = cmEditor.getCursor('start');
    const to = cmEditor.getCursor('end');
    
    // Get the range including potential == markers
    const fromIndex = cmEditor.indexFromPos(from);
    const toIndex = cmEditor.indexFromPos(to);
    const content = cmEditor.getValue();
    
    // Check if there are == markers before and after selection
    let startIndex = fromIndex;
    let endIndex = toIndex;
    
    // Look for == before selection
    if (content.substring(fromIndex - 2, fromIndex) === '==') {
        startIndex = fromIndex - 2;
    }
    
    // Look for == after selection
    if (content.substring(toIndex, toIndex + 2) === '==') {
        endIndex = toIndex + 2;
    }
    
    // If we found markers, remove them
    if (startIndex !== fromIndex || endIndex !== toIndex) {
        const newFrom = cmEditor.posFromIndex(startIndex);
        const newTo = cmEditor.posFromIndex(endIndex);
        const text = content.substring(startIndex + 2, endIndex - 2); // Text without markers
        cmEditor.replaceRange(text, newFrom, newTo);
        setTimeout(refreshHighlightMarkers, 50);
        showToast('Highlight removed');
    } else {
        showToast('No highlight found');
    }
}

// Array to store AI-ism markers
let aiismMarkers = [];

// Shared parser: reads settings and returns a clean array of AI-ism strings
function getParsedAIisms() {
    const aiismsText = settings.aiismsList || DEFAULT_AIISMS;
    const aiisms = [];

    aiismsText.split('\n').forEach(line => {
        line = line.trim();
        if (line.length === 0) return;
        if (line.startsWith('#')) return;
        if (/^\*\*[^*]+\*\*$/.test(line)) return;
        if (/^__[^_]+__$/.test(line)) return;
        line = line.replace(/^[-–—]\s*/, '');
        if (line.includes(',')) {
            line.split(',').map(item => item.trim()).forEach(item => {
                if (item.length > 0) {
                    item = item.replace(/^[""](.+)[""]$/, '$1').replace(/^"(.+)"$/, '$1');
                    aiisms.push(item);
                }
            });
        } else {
            line = line.replace(/^[""](.+)[""]$/, '$1').replace(/^"(.+)"$/, '$1');
            line = line.replace(/\s*\([^)]+\)\s*$/, '');
            if (line.length > 0) aiisms.push(line);
        }
    });

    return aiisms;
}

// Apply AI-ism squiggles to the rendered preview div by walking text nodes
function applyPreviewAIismHighlights() {
    const previewDiv = document.getElementById('preview');
    if (!previewDiv) return;

    const currentDoc = documents.find(d => d.id === currentDocumentId);
    if (!currentDoc || currentDoc.type !== 'Chapter') return;

    const aiisms = getParsedAIisms();
    if (aiisms.length === 0) return;

    // Sort longest first to avoid partial matches on shorter overlapping terms
    const sorted = [...aiisms].sort((a, b) => b.length - a.length);
    const pattern = sorted.map(a => `\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).join('|');
    const regex = new RegExp(pattern, 'gi');

    function walkAndMark(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent;
            if (!regex.test(text)) { regex.lastIndex = 0; return; }
            regex.lastIndex = 0;

            const frag = document.createDocumentFragment();
            let lastIndex = 0;
            let match;

            while ((match = regex.exec(text)) !== null) {
                if (match.index > lastIndex) {
                    frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
                }
                const span = document.createElement('span');
                span.className = 'preview-aiism';
                span.title = `AI-ism: "${match[0]}"`;
                span.textContent = match[0];
                frag.appendChild(span);
                lastIndex = match.index + match[0].length;
            }
            if (lastIndex < text.length) {
                frag.appendChild(document.createTextNode(text.slice(lastIndex)));
            }

            node.parentNode.replaceChild(frag, node);
            return;
        }

        if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.classList && node.classList.contains('preview-aiism')) return;
            if (['SCRIPT', 'STYLE'].includes(node.tagName)) return;
        }

        // Snapshot childNodes because we mutate in-place
        Array.from(node.childNodes).forEach(child => walkAndMark(child));
    }

    walkAndMark(previewDiv);
}

// Refresh AI-ism highlights in the editor
function refreshAIismHighlights() {
    if (!cmEditor) return;
    
    aiismMarkers.forEach(marker => marker.clear());
    aiismMarkers = [];
    
    const currentDoc = documents.find(d => d.id === currentDocumentId);
    if (!currentDoc || currentDoc.type !== 'Chapter') return;
    
    const aiisms = getParsedAIisms();
    if (aiisms.length === 0) return;
    
    const content = cmEditor.getValue();
    
    aiisms.forEach(aiism => {
        const escapedAiism = aiism.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escapedAiism}\\b`, 'gi');
        let match;
        
        while ((match = regex.exec(content)) !== null) {
            const startPos = cmEditor.posFromIndex(match.index);
            const endPos = cmEditor.posFromIndex(match.index + match[0].length);
            
            const marker = cmEditor.markText(startPos, endPos, {
                css: `text-decoration: underline wavy #16a34a; text-decoration-skip-ink: none;`,
                title: `AI-ism detected: "${match[0]}"`,
                inclusiveLeft: false,
                inclusiveRight: false
            });
            aiismMarkers.push(marker);
        }
    });
}

// Update the insertMarkdown function to use the selected color
function getHighlightColor() {
    const colorPicker = document.getElementById('highlightColorPicker');
    return colorPicker ? colorPicker.value : (settings.highlightColor || '#fff59d');
}

/* ========== THEME CUSTOMIZATION FUNCTIONS ========== */

// Initialize theme color pickers with current values
function initializeThemeColorPickers() {
    const root = getComputedStyle(document.documentElement);
    const currentTheme = settings.theme || 'default';
    const customColors = settings.customThemeColors[currentTheme] || {};
    
    // Map of color variables to input IDs
    const colorMap = {
        '--bg-primary': 'customBgPrimary',
        '--bg-secondary': 'customBgSecondary',
        '--toolbar-bg': 'customToolbarBg',
        '--text-primary': 'customTextPrimary',
        '--text-secondary': 'customTextSecondary',
        '--accent-primary': 'customAccentPrimary',
        '--border-color': 'customBorderColor'
    };
    
    // Set color pickers to current values (custom or default)
    for (const [cssVar, inputId] of Object.entries(colorMap)) {
        const input = document.getElementById(inputId);
        if (input) {
            // Use custom color if exists, otherwise use computed value
            const color = customColors[cssVar] || root.getPropertyValue(cssVar).trim();
            input.value = rgbToHex(color);
            
            // Remove old event listeners
            const newInput = input.cloneNode(true);
            input.parentNode.replaceChild(newInput, input);
            
            // Add event listener for updates only when color is selected (not during dragging)
            newInput.addEventListener('change', function(e) {
                updateThemeColor(cssVar, e.target.value);
            });
        }
    }
}

// Update a single theme color
function updateThemeColor(cssVar, color) {
    const currentTheme = settings.theme || 'default';
    
    // Initialize customThemeColors for this theme if needed
    if (!settings.customThemeColors[currentTheme]) {
        settings.customThemeColors[currentTheme] = {};
    }
    
    // Store the custom color
    settings.customThemeColors[currentTheme][cssVar] = color;
    
    // Apply immediately
    document.documentElement.style.setProperty(cssVar, color);
    
    // Debounced save - only save after user stops changing colors
    clearTimeout(window.colorSaveTimer);
    window.colorSaveTimer = setTimeout(() => {
        autoSave();
        showToast('Color updated');
    }, 500);
}

// Apply custom theme colors (called when theme loads)
function applyCustomThemeColors() {
    const currentTheme = settings.theme || 'default';
    const customColors = settings.customThemeColors[currentTheme];
    
    if (customColors) {
        for (const [cssVar, color] of Object.entries(customColors)) {
            document.documentElement.style.setProperty(cssVar, color);
        }
    }
}

// Reset theme colors to default
function resetThemeColors() {
    if (!confirm('Reset all colors to theme defaults?')) return;
    
    const currentTheme = settings.theme || 'default';
    
    // Remove custom colors for this theme
    delete settings.customThemeColors[currentTheme];
    
    // Clear inline styles to restore CSS defaults
    const colorVars = [
        '--bg-primary', '--bg-secondary', '--toolbar-bg', '--text-primary', 
        '--text-secondary', '--accent-primary', '--border-color'
    ];
    
    for (const cssVar of colorVars) {
        document.documentElement.style.removeProperty(cssVar);
    }
    
    // Reinitialize color pickers with default values
    initializeThemeColorPickers();
    
    // Save settings
    autoSave();
    showToast('Theme colors reset! 🔄');
}

// Convert RGB/RGBA to HEX
function rgbToHex(rgb) {
    // If already hex, return it
    if (rgb.startsWith('#')) return rgb;
    
    // Extract RGB values
    const match = rgb.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return '#000000';
    
    const r = parseInt(match[1]);
    const g = parseInt(match[2]);
    const b = parseInt(match[3]);
    
    return '#' + [r, g, b].map(x => {
        const hex = x.toString(16);
        return hex.length === 1 ? '0' + hex : hex;
    }).join('');
}