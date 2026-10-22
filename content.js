/**
 * Google Forms AI Assistant - Content Script
 * 
 * Features:
 * - Isolated Shadow DOM container to prevent CSS bleeding with Google Forms.
 * - Draggable, floating glassmorphic UI with minimize/expand states.
 * - Robust DOM scraper supporting multiple choice (radio), checkboxes, dropdowns, and text fields.
 * - Dynamic MutationObserver to detect section changes, pagination, and dynamic form updates.
 * - Visual highlighting of correct options directly inside the Google Form DOM.
 * - Fast keyboard/click navigation across multi-question forms.
 */

(function () {
  // Prevent duplicate injection
  if (window.__GFORM_AI_ASSISTANT_INJECTED__) return;
  window.__GFORM_AI_ASSISTANT_INJECTED__ = true;

  // Global state for content script
  const state = {
    questions: [],
    activeIndex: 0,
    isLoading: false,
    autoSolveOnFocus: false,
    isMinimized: false,
    loadingKey: null,
    answersCache: new Map()
  };

  const questionIds = new WeakMap();
  let nextQuestionId = 0;
  function questionKey(question) {
    if (!questionIds.has(question.container)) questionIds.set(question.container, ++nextQuestionId);
    return JSON.stringify([questionIds.get(question.container), question.title, question.subtitle, question.type, question.options]);
  }

  let shadowRoot = null;
  let hostElement = null;
  let observer = null;
  let debounceTimer = null;

  // --- INITIALIZATION ---

  function init() {
    createShadowHost();
    renderUI();
    setupMutationObserver();
    setupGlobalEventListeners();

    // Initial scrape after short delay to let Google Forms hydrate
    setTimeout(() => {
      scrapeQuestions();
      updateUI();
    }, 600);
  }

  /**
   * Creates a host DOM element and attaches open Shadow DOM.
   */
  function createShadowHost() {
    // Check if host already exists
    let existingHost = document.getElementById("gform-ai-overlay-host");
    if (existingHost) {
      existingHost.remove();
    }

    hostElement = document.createElement("div");
    hostElement.id = "gform-ai-overlay-host";
    
    const parent = document.fullscreenElement || document.documentElement;
    parent.appendChild(hostElement);
    shadowRoot = hostElement.attachShadow({ mode: "open" });
  }

  // --- STYLES FOR SHADOW DOM ---

  const styles = `
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    :host {
      all: initial;
      position: fixed;
      z-index: 2147483647;
      pointer-events: none;
    }

    /* Floating container */
    .overlay-panel {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 360px;
      max-width: calc(100vw - 16px);
      background: rgba(15, 20, 28, 0.94);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 14px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.05);
      color: #f1f5f9;
      pointer-events: auto;
      user-select: none;
      transition: width 0.2s ease, transform 0.15s ease, opacity 0.15s ease;
      display: flex;
      flex-direction: column;
      max-height: 85vh;
      overflow: hidden;
    }

    /* Minimized Floating Bubble */
    .overlay-panel.minimized {
      width: auto;
      min-width: 170px;
      border-radius: 9999px;
      cursor: pointer;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(139, 92, 246, 0.4);
    }

    .overlay-panel.minimized .panel-body,
    .overlay-panel.minimized .panel-footer,
    .overlay-panel.minimized .question-nav {
      display: none !important;
    }

    .overlay-panel.minimized .header-controls button.btn-minimize,
    .overlay-panel.minimized .header-controls button.btn-close {
      display: none !important;
    }

    .overlay-panel.minimized .panel-header {
      padding: 8px 14px;
      border-bottom: none;
    }

    /* Header & Drag Handle */
    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: rgba(255, 255, 255, 0.03);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      cursor: grab;
    }

    .panel-header:active {
      cursor: grabbing;
    }

    .header-branding {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .branding-icon {
      width: 22px;
      height: 22px;
      background: linear-gradient(135deg, #8b5cf6, #38bdf8);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      color: #fff;
      font-weight: bold;
    }

    .header-title {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: -0.2px;
      color: #fff;
    }

    .header-controls {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .control-btn {
      background: transparent;
      border: none;
      color: #94a3b8;
      cursor: pointer;
      width: 24px;
      height: 24px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      transition: background 0.15s ease, color 0.15s ease;
    }

    .control-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }

    /* Navigation Bar */
    .question-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 14px;
      background: rgba(0, 0, 0, 0.2);
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      font-size: 11px;
      color: #94a3b8;
    }

    .nav-arrows {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .nav-btn {
      background: #1e293b;
      border: 1px solid #334155;
      color: #cbd5e1;
      border-radius: 4px;
      padding: 3px 8px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
    }

    .nav-btn:hover:not(:disabled) {
      background: #334155;
      color: #fff;
    }

    .nav-btn:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }

    .nav-counter {
      font-weight: 600;
      color: #e2e8f0;
    }

    .rescan-btn {
      background: transparent;
      border: none;
      color: #38bdf8;
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 3px;
    }

    .rescan-btn:hover {
      text-decoration: underline;
    }

    /* Panel Body */
    .panel-body {
      padding: 14px;
      overflow-y: auto;
      max-height: 420px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      user-select: text;
    }

    /* Custom thin scrollbar */
    .panel-body::-webkit-scrollbar {
      width: 5px;
    }
    .panel-body::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.15);
      border-radius: 4px;
    }

    /* Question Display Card */
    .question-card {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 8px;
      padding: 10px 12px;
    }

    .question-title {
      font-size: 12.5px;
      font-weight: 600;
      line-height: 1.45;
      color: #f8fafc;
      margin-bottom: 8px;
    }

    .question-options-preview {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .option-item {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      font-size: 11.5px;
      color: #94a3b8;
      line-height: 1.35;
      padding: 3px 6px;
      border-radius: 4px;
      background: transparent;
      transition: background 0.15s ease, color 0.15s ease;
    }

    .option-bullet {
      color: #64748b;
      font-weight: bold;
      flex-shrink: 0;
    }

    .option-item.highlighted {
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.4);
      color: #34d399;
      font-weight: 600;
    }

    /* Primary Action Button */
    .action-btn {
      width: 100%;
      background: linear-gradient(135deg, #8b5cf6, #6366f1);
      color: #fff;
      border: none;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      box-shadow: 0 4px 14px rgba(124, 58, 237, 0.35);
      transition: transform 0.05s ease, opacity 0.15s ease, box-shadow 0.15s ease;
      user-select: none;
    }

    .action-btn:hover:not(:disabled) {
      opacity: 0.95;
      box-shadow: 0 6px 18px rgba(124, 58, 237, 0.45);
    }

    .action-btn:active:not(:disabled) {
      transform: scale(0.98);
    }

    .action-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    /* Answer Result Box */
    .answer-container {
      background: rgba(16, 185, 129, 0.08);
      border: 1px solid rgba(16, 185, 129, 0.25);
      border-radius: 8px;
      padding: 12px;
      animation: fadeIn 0.25s ease;
    }

    .answer-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;
    }

    .answer-badge {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      color: #34d399;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .answer-badge::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #10b981;
    }

    .copy-btn {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #e2e8f0;
      border-radius: 4px;
      padding: 2px 7px;
      font-size: 10.5px;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .copy-btn:hover {
      background: rgba(255, 255, 255, 0.16);
      color: #fff;
    }

    .answer-content {
      font-size: 13.5px;
      font-weight: 600;
      color: #ffffff;
      line-height: 1.4;
      word-break: break-word;
    }

    .form-sync-btn {
      margin-top: 8px;
      background: rgba(16, 185, 129, 0.2);
      border: 1px solid rgba(16, 185, 129, 0.4);
      color: #6ee7b7;
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      transition: background 0.15s ease;
    }

    .form-sync-btn:hover {
      background: rgba(16, 185, 129, 0.3);
    }

    /* Loading Spinner */
    .loading-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 16px;
      gap: 8px;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.06);
    }

    .spinner {
      width: 24px;
      height: 24px;
      border: 2.5px solid rgba(139, 92, 246, 0.2);
      border-top-color: #8b5cf6;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    .loading-text {
      font-size: 11.5px;
      color: #94a3b8;
      font-weight: 500;
    }

    /* Error Banner */
    .error-container {
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.3);
      border-radius: 8px;
      padding: 10px 12px;
      color: #fca5a5;
      font-size: 11.5px;
      line-height: 1.4;
    }

    .error-title {
      font-weight: 700;
      margin-bottom: 2px;
      display: flex;
      align-items: center;
      gap: 4px;
      color: #ef4444;
    }

    /* Panel Footer & Auto-solve Toggle */
    .panel-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 14px;
      background: rgba(0, 0, 0, 0.2);
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      font-size: 11px;
      color: #94a3b8;
    }

    .toggle-label {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      user-select: none;
    }

    .toggle-checkbox {
      accent-color: #8b5cf6;
      cursor: pointer;
    }

    /* Animations */
    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;

  // --- RENDER UI INTO SHADOW DOM ---

  function renderUI() {
    shadowRoot.innerHTML = `
      <style>${styles}</style>
      <div id="overlayPanel" class="overlay-panel">
        <!-- Header -->
        <div id="dragHeader" class="panel-header">
          <div class="header-branding">
            <div class="branding-icon">⚡</div>
            <span class="header-title">Form Assist AI</span>
          </div>
          <div class="header-controls">
            <button id="minimizeBtn" class="control-btn btn-minimize" title="Minimize">—</button>
            <button id="closeBtn" class="control-btn btn-close" title="Close">✕</button>
          </div>
        </div>

        <!-- Navigation Bar -->
        <div class="question-nav">
          <div class="nav-arrows">
            <button id="prevBtn" class="nav-btn" title="Previous Question">◀</button>
            <span id="navCounter" class="nav-counter">Question 0 of 0</span>
            <button id="nextBtn" class="nav-btn" title="Next Question">▶</button>
          </div>
          <button id="rescanBtn" class="rescan-btn" title="Rescan page for questions">↻ Rescan</button>
        </div>

        <!-- Body -->
        <div class="panel-body">
          <!-- Question Box -->
          <div class="question-card">
            <div id="questionTitle" class="question-title">Detecting form questions...</div>
            <div id="optionsList" class="question-options-preview"></div>
          </div>

          <!-- Get Answer Button -->
          <button id="getAnswerBtn" class="action-btn">
            <span>✨ Get Answer</span>
          </button>

          <!-- Dynamic Output Container (Answer / Spinner / Error) -->
          <div id="resultContainer"></div>
        </div>

        <!-- Footer -->
        <div class="panel-footer">
          <label class="toggle-label">
            <input type="checkbox" id="autoSolveCheck" class="toggle-checkbox">
            <span>Auto-solve on click</span>
          </label>
          <span id="statusIndicator" style="font-size: 10px; color: #64748b;">Ready</span>
        </div>
      </div>
    `;

    setupUIEvents();
    restorePanelPosition();
  }

  // --- UI EVENT LISTENERS ---

  function setupUIEvents() {
    const overlayPanel = shadowRoot.getElementById("overlayPanel");
    const dragHeader = shadowRoot.getElementById("dragHeader");
    const minimizeBtn = shadowRoot.getElementById("minimizeBtn");
    const closeBtn = shadowRoot.getElementById("closeBtn");
    const prevBtn = shadowRoot.getElementById("prevBtn");
    const nextBtn = shadowRoot.getElementById("nextBtn");
    const rescanBtn = shadowRoot.getElementById("rescanBtn");
    const getAnswerBtn = shadowRoot.getElementById("getAnswerBtn");
    const autoSolveCheck = shadowRoot.getElementById("autoSolveCheck");

    // Draggable behavior
    makeDraggable(dragHeader, overlayPanel);

    // Minimize toggle
    minimizeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMinimize();
    });

    // Expand on clicking minimized pill
    overlayPanel.addEventListener("click", () => {
      if (state.isMinimized) {
        toggleMinimize();
      }
    });

    // Close / Hide
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      overlayPanel.style.display = "none";
    });

    // Navigation buttons
    prevBtn.addEventListener("click", () => {
      if (state.activeIndex > 0) {
        state.activeIndex--;
        updateUI();
        scrollToCurrentQuestion();
        if (state.autoSolveOnFocus) {
          triggerGetAnswer();
        }
      }
    });

    nextBtn.addEventListener("click", () => {
      if (state.activeIndex < state.questions.length - 1) {
        state.activeIndex++;
        updateUI();
        scrollToCurrentQuestion();
        if (state.autoSolveOnFocus) {
          triggerGetAnswer();
        }
      }
    });

    // Manual Rescan
    rescanBtn.addEventListener("click", () => {
      scrapeQuestions();
      updateUI();
    });

    // Get Answer
    getAnswerBtn.addEventListener("click", () => {
      triggerGetAnswer();
    });

    // Auto-solve toggle
    autoSolveCheck.addEventListener("change", (e) => {
      state.autoSolveOnFocus = e.target.checked;
    });
  }

  function toggleMinimize() {
    const overlayPanel = shadowRoot.getElementById("overlayPanel");
    const minimizeBtn = shadowRoot.getElementById("minimizeBtn");
    state.isMinimized = !state.isMinimized;

    if (state.isMinimized) {
      overlayPanel.classList.add("minimized");
      minimizeBtn.textContent = "+";
    } else {
      overlayPanel.classList.remove("minimized");
      minimizeBtn.textContent = "—";
    }
  }

  // --- DRAGGABLE IMPLEMENTATION ---

  function makeDraggable(handle, panel) {
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    handle.addEventListener("mousedown", (e) => {
      // Don't drag if clicking buttons
      if (e.target.tagName === "BUTTON") return;

      isDragging = true;
      const rect = panel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      initialLeft = rect.left;
      initialTop = rect.top;

      // Switch from right/bottom to top/left positioning
      panel.style.bottom = "auto";
      panel.style.right = "auto";
      panel.style.left = `${initialLeft}px`;
      panel.style.top = `${initialTop}px`;

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      e.preventDefault();
    });

    function onMouseMove(e) {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let newLeft = initialLeft + dx;
      let newTop = initialTop + dy;

      // Clamping within viewport
      const panelWidth = panel.offsetWidth;
      const panelHeight = panel.offsetHeight;
      const maxLeft = window.innerWidth - panelWidth - 8;
      const maxTop = window.innerHeight - panelHeight - 8;

      newLeft = Math.max(8, Math.min(newLeft, maxLeft));
      newTop = Math.max(8, Math.min(newTop, maxTop));

      panel.style.left = `${newLeft}px`;
      panel.style.top = `${newTop}px`;
    }

    function onMouseUp() {
      if (!isDragging) return;
      isDragging = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);

      // Save position to sessionStorage
      try {
        sessionStorage.setItem("gform_ai_panel_pos", JSON.stringify({
          left: panel.style.left,
          top: panel.style.top
        }));
      } catch (_) {}
    }
  }

  function restorePanelPosition() {
    try {
      const saved = sessionStorage.getItem("gform_ai_panel_pos");
      if (saved) {
        const { left, top } = JSON.parse(saved);
        const panel = shadowRoot.getElementById("overlayPanel");
        if (panel && left && top) {
          panel.style.bottom = "auto";
          panel.style.right = "auto";
          panel.style.left = left;
          panel.style.top = top;
        }
      }
    } catch (_) {}
  }

  // --- ROBUST GOOGLE FORMS DOM SCRAPER ---

  /**
   * Scrapes all visible questions from Google Forms.
   * Handles modern and classic layouts, radio buttons, checkboxes, dropdowns, and text fields.
   */
  function scrapeQuestions() {
    const previousQuestion = state.questions[state.activeIndex];
    const previousKey = previousQuestion ? questionKey(previousQuestion) : null;
    const scraped = [];

    // Find all question blocks in the form
    // Primary selectors for Google Forms question containers
    let questionNodes = document.querySelectorAll('div[role="listitem"]');
    
    // Fallback selectors if role="listitem" isn't present
    if (!questionNodes || questionNodes.length === 0) {
      questionNodes = document.querySelectorAll('.Qr7Oae, .freebirdFormviewerViewNumberedItemContainer, .geS5n');
    }

    questionNodes.forEach((node, index) => {
      // 1. Extract Question Title
      let titleElem = node.querySelector('div[role="heading"], [aria-level="3"], .M7eMe, .freebirdFormviewerComponentsQuestionBaseTitle');
      if (!titleElem) {
        // Fallback: look for any element with class containing Title or heading
        titleElem = node.querySelector('.M7eMe') || node.querySelector('span[dir="auto"]');
      }

      if (!titleElem) return; // Skip non-question blocks (e.g. section headers or banners)

      // Clean up title text (strip trailing asterisks for required questions)
      let titleText = titleElem.innerText || titleElem.textContent || "";
      titleText = titleText.replace(/\s*\*+\s*$/, "").trim();

      // If question description/subtitle exists, append it for context
      const subtitleElem = node.querySelector('.Y6eNid, .hoUMrd');
      let subtitleText = "";
      if (subtitleElem && subtitleElem.innerText) {
        subtitleText = subtitleElem.innerText.trim();
      }

      // 2. Identify Question Type and Extract Options
      const options = [];
      const optionElements = [];
      let questionType = "text";

      // A. Check for Radio Buttons (Multiple Choice)
      // A grid contains multiple answers per block; do not flatten it into one question.
      if (node.querySelectorAll('div[role="radiogroup"]').length > 1) return;
      const radioNodes = node.querySelectorAll('div[role="radio"]');
      if (radioNodes && radioNodes.length > 0) {
        questionType = "radio";
        radioNodes.forEach((radio) => {
          let optText = radio.getAttribute("data-value") || radio.getAttribute("aria-label");
          if (!optText) {
            const labelSpan = radio.querySelector('.aDTYNe, .ulDsOb, span[dir="auto"]');
            optText = labelSpan ? labelSpan.innerText : radio.innerText;
          }
          if (optText && optText.trim()) {
            options.push(optText.trim());
            optionElements.push(radio);
          }
        });
      }

      // B. Check for Checkboxes (Multiple Answers)
      if (options.length === 0) {
        const checkboxNodes = node.querySelectorAll('div[role="checkbox"]');
        if (checkboxNodes && checkboxNodes.length > 0) {
          questionType = "checkbox";
          checkboxNodes.forEach((chk) => {
            let optText = chk.getAttribute("data-answer-value") || chk.getAttribute("aria-label");
            if (!optText) {
              const labelSpan = chk.querySelector('.aDTYNe, span[dir="auto"]');
              optText = labelSpan ? labelSpan.innerText : chk.innerText;
            }
            if (optText && optText.trim()) {
              options.push(optText.trim());
              optionElements.push(chk);
            }
          });
        }
      }

      // C. Check for Dropdowns
      if (options.length === 0) {
        const listbox = node.querySelector('div[role="listbox"]');
        if (listbox) {
          questionType = "dropdown";
          // Dropdown options might be in div[role="option"]
          const optNodes = node.querySelectorAll('div[role="option"]');
          optNodes.forEach((opt) => {
            const txt = opt.getAttribute("data-value") || opt.innerText;
            if (txt && txt.trim() && txt.trim() !== "Choose") {
              options.push(txt.trim());
              optionElements.push(opt);
            }
          });
        }
      }

      // D. Check for Short Answer or Paragraph
      if (options.length === 0) {
        const textInput = node.querySelector('input[type="text"], textarea, div[role="textbox"]');
        if (textInput) {
          questionType = textInput.tagName.toLowerCase() === "textarea" ? "paragraph" : "short_answer";
          optionElements.push(textInput);
        }
      }

      if (titleText.length > 0 && (options.length > 0 || optionElements.length > 0)) {
        scraped.push({
          index: index + 1,
          container: node,
          title: titleText,
          subtitle: subtitleText,
          type: questionType,
          options: options,
          optionElements: optionElements
        });
      }
    });

    state.questions = scraped;
    const retainedIndex = scraped.findIndex(question => questionKey(question) === previousKey);
    if (retainedIndex >= 0) state.activeIndex = retainedIndex;

    // Adjust active index if out of range
    if (state.activeIndex >= state.questions.length) {
      state.activeIndex = Math.max(0, state.questions.length - 1);
    }

    return scraped;
  }

  // --- UI UPDATER ---

  function updateUI() {
    if (!shadowRoot) return;

    const navCounter = shadowRoot.getElementById("navCounter");
    const prevBtn = shadowRoot.getElementById("prevBtn");
    const nextBtn = shadowRoot.getElementById("nextBtn");
    const questionTitle = shadowRoot.getElementById("questionTitle");
    const optionsList = shadowRoot.getElementById("optionsList");
    const getAnswerBtn = shadowRoot.getElementById("getAnswerBtn");
    const resultContainer = shadowRoot.getElementById("resultContainer");

    const total = state.questions.length;

    if (total === 0) {
      navCounter.textContent = "No questions found";
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      questionTitle.textContent = "No questions detected on this page.";
      optionsList.innerHTML = `<div style="font-size: 11px; color: #64748b;">Navigate to a Google Form question section or click "Rescan".</div>`;
      getAnswerBtn.disabled = true;
      resultContainer.innerHTML = "";
      return;
    }

    const current = state.questions[state.activeIndex];
    navCounter.textContent = `Question ${state.activeIndex + 1} of ${total}`;
    prevBtn.disabled = state.activeIndex === 0;
    nextBtn.disabled = state.activeIndex === total - 1;
    getAnswerBtn.disabled = state.isLoading;

    // Set Question text
    questionTitle.textContent = `${state.activeIndex + 1}. ${current.title}`;

    // Render Options Preview
    if (current.options && current.options.length > 0) {
      const cached = state.answersCache.get(questionKey(current));
      optionsList.innerHTML = current.options.map((opt, i) => {
        const bullet = current.type === "radio" ? "○" : (current.type === "checkbox" ? "□" : "•");
        const isMatch = cached && cached.matchedIndices.includes(i);
        return `
          <div class="option-item ${isMatch ? 'highlighted' : ''}">
            <span class="option-bullet">${bullet}</span>
            <span>${escapeHtml(opt)}</span>
          </div>
        `;
      }).join("");
    } else if (current.type === "short_answer" || current.type === "paragraph") {
      optionsList.innerHTML = `<div style="font-size: 11px; color: #94a3b8; font-style: italic;">📝 Open-ended response field</div>`;
    } else {
      optionsList.innerHTML = "";
    }

    // Check if we have a cached answer for this question
    const cachedAnswer = state.answersCache.get(questionKey(current));
    if (state.isLoading && state.loadingKey === questionKey(current)) {
      resultContainer.innerHTML = '<div class="loading-state"><div class="spinner"></div><div class="loading-text">Consulting LLM...</div></div>';
    } else if (cachedAnswer) {
      renderAnswerSuccess(cachedAnswer, current);
    } else {
      resultContainer.innerHTML = "";
    }
  }

  // --- TRIGGER GET ANSWER VIA BACKGROUND SERVICE WORKER ---

  async function triggerGetAnswer() {
    if (!state.questions.length || state.isLoading) return;
    const current = state.questions[state.activeIndex];
    const key = questionKey(current);
    state.isLoading = true;
    state.loadingKey = key;
    updateUI();
    let error = null;
    try {
      const response = await sendRuntimeMessage({
        action: "GET_ANSWER",
        data: {
          questionText: current.title + (current.subtitle ? '\nDetails: ' + current.subtitle : ''),
          options: current.options,
          questionType: current.type
        }
      });
      if (!response?.success) throw new Error(response?.error || 'Failed to retrieve an answer.');
      state.answersCache.set(key, response);
    } catch (err) {
      error = err.message || 'An unexpected error occurred.';
    } finally {
      state.isLoading = false;
      state.loadingKey = null;
      updateUI();
      const active = state.questions[state.activeIndex];
      if (active && questionKey(active) === key) {
        if (error) renderError(error);
      } else if (active && state.autoSolveOnFocus) {
        triggerGetAnswer();
      }
    }
  }

  function renderAnswerSuccess(result, question) {
    const { answer, matchedIndices, modelUsed, sessionRequests, tierSwitched } = result;
    const resultContainer = shadowRoot.getElementById("resultContainer");
    const key = questionKey(question);
    resultContainer.innerHTML = `
      <div class="answer-container">
        ${tierSwitched ? '<div class="hint-text">Used another available model.</div>' : ''}
        <div class="answer-header">
          <div class="answer-badge">Suggested Answer</div>
          <button id="copyAnswerBtn" class="copy-btn">📋 Copy</button>
        </div>
        <div class="answer-content">${escapeHtml(answer)}</div>
        ${matchedIndices.length ? '<button id="selectOptionBtn" class="form-sync-btn">✓ Highlight & Select in Form</button>' : ''}
        <div style="font-size: 10px; color: #94a3b8; margin-top: 8px;">
          Model: <strong>${escapeHtml(modelUsed)}</strong> · Successful answers: ${sessionRequests}
        </div>
      </div>
    `;
    const statusIndicator = shadowRoot.getElementById("statusIndicator");
    statusIndicator.textContent = modelUsed + ' (#' + sessionRequests + ')';
    const copyBtn = shadowRoot.getElementById("copyAnswerBtn");
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(answer);
        copyBtn.textContent = '✓ Copied!';
      } catch (err) {
        renderError('Could not copy the answer: ' + err.message);
      }
    });
    const selectBtn = shadowRoot.getElementById("selectOptionBtn");
    if (selectBtn && matchedIndices.length) {
      selectBtn.addEventListener("click", () => {
        const active = state.questions[state.activeIndex];
        if (!active || questionKey(active) !== key || !active.container.isConnected) {
          renderError('The form changed. Rescan and request a new answer.');
          return;
        }
        if (active.type === 'checkbox') {
          active.optionElements.forEach((element, index) => {
            const wanted = matchedIndices.includes(index);
            if ((element.getAttribute('aria-checked') === 'true') !== wanted) element.click();
            if (wanted) highlightFormElement(element);
          });
        } else {
          const target = active.optionElements[matchedIndices[0]];
          if (!target?.isConnected) {
            renderError('The option is no longer available. Rescan the form.');
            return;
          }
          if (active.type === 'dropdown') active.container.querySelector('[role="listbox"]').click();
          target.click();
          highlightFormElement(target);
        }
        selectBtn.textContent = '✓ Selected in Form';
      });
    }
  }

  /**
   * Renders error state.
   */
  function renderError(errorMessage) {
    const resultContainer = shadowRoot.getElementById("resultContainer");
    resultContainer.innerHTML = `
      <div class="error-container">
        <div class="error-title">⚠️ Error</div>
        <div>${escapeHtml(errorMessage)}</div>
      </div>
    `;
  }

  // --- VISUAL HIGHLIGHTING IN GOOGLE FORMS DOM ---

  /**
   * Highlights the target element inside Google Forms with an animated glowing pulse.
   */
  function highlightFormElement(element) {
    if (!element) return;

    // Scroll question into view smoothly
    element.scrollIntoView({ behavior: "smooth", block: "center" });

    // Apply temporary glowing highlight
    const originalTransition = element.style.transition;
    const originalBoxShadow = element.style.boxShadow;
    const originalBorderRadius = element.style.borderRadius;

    element.style.transition = "all 0.3s ease";
    element.style.boxShadow = "0 0 0 3px #10b981, 0 4px 12px rgba(16, 185, 129, 0.4)";
    element.style.borderRadius = "8px";

    setTimeout(() => {
      element.style.boxShadow = originalBoxShadow;
      element.style.transition = originalTransition;
      element.style.borderRadius = originalBorderRadius;
    }, 3000);
  }

  function scrollToCurrentQuestion() {
    const current = state.questions[state.activeIndex];
    if (current && current.container) {
      current.container.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  // --- MUTATION OBSERVER & GLOBAL EVENTS ---

  /**
   * Observes form page transitions, section changes, and dynamic questions.
   */
  function setupMutationObserver() {
    observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const previousQuestions = JSON.stringify(state.questions.map(questionKey));
        scrapeQuestions();
        if (JSON.stringify(state.questions.map(questionKey)) !== previousQuestions) {
          updateUI();
        }
      }, 350);
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  /**
   * Synchronizes active question when user clicks or focuses inside Google Forms.
   */
  function setupGlobalEventListeners() {
    // When user clicks anywhere inside the Google Form
    document.addEventListener("click", (e) => {
      // Ignore clicks inside our own shadow host
      if (hostElement && hostElement.contains(e.target)) return;

      // Find if clicked element belongs to a question
      const questionIndex = state.questions.findIndex(q => q.container && q.container.contains(e.target));
      if (questionIndex !== -1 && questionIndex !== state.activeIndex) {
        state.activeIndex = questionIndex;
        updateUI();
        if (state.autoSolveOnFocus) {
          triggerGetAnswer();
        }
      }
    }, true);

    // Focus events for form inputs
    document.addEventListener("focusin", (e) => {
      if (hostElement && hostElement.contains(e.target)) return;

      const questionIndex = state.questions.findIndex(q => q.container && q.container.contains(e.target));
      if (questionIndex !== -1 && questionIndex !== state.activeIndex) {
        state.activeIndex = questionIndex;
        updateUI();
        if (state.autoSolveOnFocus) {
          triggerGetAnswer();
        }
      }
    }, true);

    // Fullscreen support: ensure our host remains attached and visible
    document.addEventListener("fullscreenchange", () => {
      const parent = document.fullscreenElement || document.documentElement;
      if (hostElement.parentElement !== parent) parent.appendChild(hostElement);
    });
  }

  // --- UTILITIES ---

  function sendRuntimeMessage(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve(response);
      });
    });
  }

  function escapeHtml(text) {
    if (!text) return "";
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Initialize script
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
