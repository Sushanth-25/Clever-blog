# Google Forms AI Assistant (Chrome Extension - Manifest V3)

A real-time AI assistant Chrome Extension built with **Manifest V3** that detects and parses Google Forms questions, queries an LLM API (Google Gemini or OpenAI) using strict prompt engineering, and renders exact, clean answers directly inside a sleek, draggable floating overlay with complete **Shadow DOM isolation**.

---

## 📁 Project Architecture & File Structure

```
clever-borg/
├── manifest.json       # Manifest V3 configuration, permissions & content script matchers
├── background.js      # Service worker for secure LLM API queries and key storage
├── content.js         # Content script: Shadow DOM UI, DOM scraper, MutationObserver
├── popup.html         # Settings popup UI for API key & provider configuration
├── popup.js           # Popup controller for storage management and connection testing
├── icons/             # Extension action & store icons
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md          # Documentation & usage guide
```

---

## 🚀 Key Features

1. **Manifest V3 Compliant**: Uses modern background service workers, `chrome.storage.local`, and granular permissions.
2. **Shadow DOM Isolation**: The floating UI lives inside an isolated Shadow Root (`attachShadow({ mode: 'open' })`), completely immune to Google Forms CSS conflicts and ensuring zero style leakage.
3. **Draggable & Minimizable Glassmorphism UI**:
   - Modern dark mode aesthetic with backdrop blur (`rgba(15, 20, 28, 0.94)`).
   - Draggable across the screen with mouse coordinates clamped to the viewport.
   - Minimizable to a floating compact pill (`⚡ Form AI`) that never blocks form inputs.
   - Remains visible in fullscreen mode (`position: fixed; z-index: 2147483647;`).
4. **Intelligent DOM Scraper**:
   - Accurately parses Radio buttons (Multiple Choice), Checkboxes (Multiple Answers), Dropdowns, and Short Answer / Paragraph fields.
   - Resilient multi-tier selector fallbacks (`role="listitem"`, `.Qr7Oae`, `.M7eMe`, etc.).
5. **Real-time `MutationObserver`**:
   - Automatically tracks page transitions, section changes ("Next" / "Back" buttons), and dynamic form rendering with debouncing.
6. **Strict System Prompt & Response Cleansing**:
   - Enforces test-taking assistant rules returning **only** the exact matching option text without markdown bolding, quotes, or filler explanations.
7. **In-Form Visual Highlighting**:
   - Displays the clean answer in the floating window.
   - One-click copy to clipboard.
   - "Highlight & Select in Form" button scrolls directly to the question and marks the correct option with a glowing green ring!

---

## 🛠️ Step-by-Step Installation Instructions

### Step 1: Open Chrome Extensions
1. Launch **Google Chrome**.
2. Navigate to `chrome://extensions/` in the address bar.
3. Toggle on **Developer mode** in the top right corner.

### Step 2: Load the Unpacked Extension
1. Click the **Load unpacked** button in the top left corner.
2. Select the directory containing these files:
   ```
   c:\Users\susha\Documents\antigravity\clever-borg
   ```
3. The **Google Forms AI Assistant** card will appear with its purple/cyan badge.

### Step 3: Pin the Extension & Enter API Key
1. Click the Chrome toolbar **puzzle icon** (Extensions) and pin **Google Forms AI Assistant**.
2. Click the extension icon to open the Settings popup.
3. Choose your provider:
   - **Google Gemini** *(Recommended - Free API key available at [Google AI Studio](https://aistudio.google.com/app/apikey))*.
   - **OpenAI** *(Optional - Available at [OpenAI Platform](https://platform.openai.com/api-keys))*.
4. Paste your API key into the field.
5. Click **"Save Key"**, then click **"⚡ Test Key"** to verify the connection.

---

## 🧪 Testing on Google Forms

1. Open any active Google Form (e.g., `https://docs.google.com/forms/d/e/.../viewform`).
2. Notice the sleek floating **Form Assist AI** widget in the bottom-right corner.
3. **Navigating Questions**:
   - Click on any question in the Google Form, or use the `◀` and `▶` arrows in the overlay.
4. **Getting Answers**:
   - Click **"✨ Get Answer"**.
   - The widget will display a thinking spinner and return the exact option.
   - Click **"✓ Highlight & Select in Form"** to automatically highlight and pick the answer!
5. **Moving / Minimizing**:
   - Drag the header bar to reposition the widget anywhere on your screen.
   - Click `—` to collapse it into a floating bubble when you want more screen space.
