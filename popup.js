const PROVIDER_HINTS = {
  gemini: 'Get a free Gemini API key at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer">Google AI Studio ↗</a>',
  openai: 'Get an OpenAI API key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">OpenAI Platform ↗</a>'
};

document.addEventListener("DOMContentLoaded", async () => {
  const providerSelect = document.getElementById("providerSelect");
  const modelSelect = document.getElementById("modelSelect");
  const autoRolloverCheck = document.getElementById("autoRolloverCheck");
  const apiKeyInput = document.getElementById("apiKeyInput");
  const toggleVisibilityBtn = document.getElementById("toggleVisibilityBtn");
  const saveBtn = document.getElementById("saveBtn");
  const testBtn = document.getElementById("testBtn");
  const alertBanner = document.getElementById("alertBanner");
  const statusBadge = document.getElementById("statusBadge");
  const statusText = document.getElementById("statusText");
  const keyHint = document.getElementById("keyHint");
  const reqCounter = document.getElementById("reqCounter");
  const resetSessionBtn = document.getElementById("resetSessionBtn");

  let isKeyVisible = false;

  // Populate model dropdown according to selected provider
  function updateModelDropdown(provider, selectedModel) {
    modelSelect.innerHTML = "";
    const models = MODELS_BY_PROVIDER[provider] || MODELS_BY_PROVIDER.gemini;
    models.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.value;
      opt.textContent = m.label;
      if (selectedModel && selectedModel === m.value) {
        opt.selected = true;
      }
      modelSelect.appendChild(opt);
    });

    keyHint.innerHTML = PROVIDER_HINTS[provider] || PROVIDER_HINTS.gemini;
  }

  // Update Status Chip in header
  function updateStatusBadge(hasKey) {
    if (hasKey) {
      statusBadge.className = "status-chip status-active";
      statusText.textContent = "Ready";
    } else {
      statusBadge.className = "status-chip status-missing";
      statusText.textContent = "No Key";
    }
  }

  // Show Alert
  function showAlert(message, type = "success") {
    alertBanner.textContent = message;
    alertBanner.className = `alert-banner ${type}`;
    setTimeout(() => {
      alertBanner.className = "alert-banner";
      alertBanner.textContent = "";
    }, 4500);
  }

  // Load existing credentials and configuration from chrome.storage.local
  chrome.storage.local.get(["apiKey", "provider", "model", "autoRollover", "sessionRequests"], (result) => {
    const currentProvider = result.provider || "gemini";
    providerSelect.value = currentProvider;

    const currentModel = result.model || MODELS_BY_PROVIDER[currentProvider][0].value;
    updateModelDropdown(currentProvider, currentModel);

    if (autoRolloverCheck) {
      autoRolloverCheck.checked = result.autoRollover !== false;
    }

    if (reqCounter) {
      const count = result.sessionRequests || 0;
      reqCounter.textContent = `${count}`;
    }

    if (result.apiKey) {
      apiKeyInput.value = result.apiKey;
      updateStatusBadge(true);
    } else {
      updateStatusBadge(false);
    }
  });

  // Reset Session Counter
  if (resetSessionBtn) {
    resetSessionBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: "RESET_SESSION_COUNT" }, (response) => {
        if (chrome.runtime.lastError) {
          showAlert(chrome.runtime.lastError.message, "error");
          return;
        }
        if (!response?.success) {
          showAlert(response?.error || "Could not reset the counter.", "error");
          return;
        }
        if (reqCounter) reqCounter.textContent = "0";
        showAlert("Session request counter reset to 0.", "success");
      });
    });
  }

  // Handle provider switch
  providerSelect.addEventListener("change", (e) => {
    const newProvider = e.target.value;
    updateModelDropdown(newProvider);
  });

  // Toggle API key visibility (masked vs clear text)
  toggleVisibilityBtn.addEventListener("click", () => {
    isKeyVisible = !isKeyVisible;
    apiKeyInput.type = isKeyVisible ? "text" : "password";
    toggleVisibilityBtn.textContent = isKeyVisible ? "🔒" : "👁️";
  });

  // Save Key & Settings
  saveBtn.addEventListener("click", () => {
    const apiKey = apiKeyInput.value.trim();
    const provider = providerSelect.value;
    const model = modelSelect.value;
    const autoRollover = autoRolloverCheck ? autoRolloverCheck.checked : true;

    if (!apiKey) {
      showAlert("Please enter a valid API key.", "error");
      apiKeyInput.focus();
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";

    chrome.storage.local.set({ apiKey, provider, model, autoRollover }, () => {
      saveBtn.disabled = false;
      if (chrome.runtime.lastError) {
        saveBtn.textContent = "Save Key";
        showAlert(chrome.runtime.lastError.message, "error");
        return;
      }
      saveBtn.innerHTML = "<span>✓ Saved!</span>";
      updateStatusBadge(true);
      showAlert(`Saved! Active Model: ${model}.`, "success");

      setTimeout(() => {
        saveBtn.innerHTML = "<span>💾 Save Key</span>";
      }, 2000);
    });
  });

  // Test Connection
  testBtn.addEventListener("click", () => {
    const apiKey = apiKeyInput.value.trim();
    const provider = providerSelect.value;
    const model = modelSelect.value;

    if (!apiKey) {
      showAlert("Please enter an API key to test.", "error");
      return;
    }

    testBtn.disabled = true;
    testBtn.textContent = "Testing...";

    chrome.runtime.sendMessage(
      {
        action: "TEST_CONNECTION",
        data: { apiKey, provider, model }
      },
      (response) => {
        testBtn.disabled = false;
        testBtn.textContent = "⚡ Test Key";

        if (chrome.runtime.lastError) {
          showAlert(`Error: ${chrome.runtime.lastError.message}`, "error");
          return;
        }

        if (response && response.success) {
          showAlert(response.message || "Connection verified successfully!", "success");
          
          // Testing never changes persisted provider, model, or key.
        } else {
          showAlert(response?.error || "Test failed. Please check your API key.", "error");
        }
      }
    );
  });
});
