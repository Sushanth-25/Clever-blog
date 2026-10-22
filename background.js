/**
 * Google Forms AI Assistant - Service Worker (Background Script)
 * Manifest V3 compliant service worker handling secure LLM API communication.
 */

// Strict system instruction as specified in requirements
const SYSTEM_INSTRUCTION = 
  "You are a precise test-taking assistant. Look at the provided question and options, and return ONLY the exact text of the correct option. Do NOT include conversational filler, introductory text, markdown bolding, or explanations.";

// Ordered Gemini 3+ tiers from lowest to highest
const MODEL_TIERS = [
  { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite (Lowest Tier - 500 RPD)", rpd: 500 },
  { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite (500 RPD)", rpd: 500 },
  { id: "gemini-3-flash", name: "Gemini 3 Flash (20 RPD)", rpd: 20 },
  { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash (20 RPD)", rpd: 20 },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash (Highest Tier - 20 RPD)", rpd: 20 }
];

// Listen for messages from content scripts and settings popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "GET_ANSWER") {
    handleGetAnswer(message.data)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: error.message || "Unknown error occurred" }));
    return true; // Keep message channel open for asynchronous response
  }

  if (message.action === "TEST_CONNECTION") {
    handleTestConnection(message.data)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: error.message || "Connection failed" }));
    return true;
  }

  if (message.action === "CHECK_KEY_STATUS") {
    chrome.storage.local.get(["apiKey", "provider", "model", "sessionRequests", "autoRollover"], (result) => {
      sendResponse({
        hasKey: Boolean(result.apiKey && result.apiKey.trim().length > 0),
        provider: result.provider || "gemini",
        model: result.model || "gemini-3.5-flash-lite",
        sessionRequests: result.sessionRequests || 0,
        autoRollover: result.autoRollover !== false
      });
    });
    return true;
  }

  if (message.action === "RESET_SESSION_COUNT") {
    chrome.storage.local.set({ sessionRequests: 0, modelRequests: {} }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.action === "SET_MODEL") {
    chrome.storage.local.set({ model: message.model }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

/**
 * Handles question solving by calling the configured LLM API.
 * Tracks session count and seamlessly cascades across tiers (lowest to highest)
 * when daily quotas (e.g. 20 RPD) are reached.
 */
async function handleGetAnswer(data) {
  const { questionText, options, questionType } = data || {};

  if (!questionText || questionText.trim().length === 0) {
    throw new Error("No question text was provided.");
  }

  // Retrieve stored API credentials and configuration
  const config = await chrome.storage.local.get([
    "apiKey", 
    "provider", 
    "model", 
    "autoRollover", 
    "sessionRequests", 
    "modelRequests"
  ]);

  const apiKey = config.apiKey ? config.apiKey.trim() : null;
  const provider = config.provider || "gemini";
  let model = config.model || (provider === "gemini" ? "gemini-3.5-flash-lite" : "gpt-4o-mini");
  const autoRollover = config.autoRollover !== false; // Default true
  let sessionRequests = (config.sessionRequests || 0) + 1;
  let modelRequests = config.modelRequests || {};
  modelRequests[model] = (modelRequests[model] || 0) + 1;

  if (!apiKey) {
    throw new Error("API Key is missing. Click the extension icon in the toolbar to enter and save your API key.");
  }

  // Construct structured prompt for the LLM
  let userPrompt = `Question: ${questionText.trim()}\n\n`;
  if (options && Array.isArray(options) && options.length > 0) {
    userPrompt += "Options:\n";
    options.forEach((opt, idx) => {
      userPrompt += `${idx + 1}. ${opt}\n`;
    });
    userPrompt += "\nIdentify the single correct option from the list above and output ONLY its exact text.";
  } else {
    userPrompt += "Provide a direct, concise answer to this question without any explanation or filler words.";
  }

  let rawAnswer = "";
  let modelUsed = model;
  let tierSwitched = false;

  if (provider === "openai") {
    rawAnswer = await callOpenAI(apiKey, model, userPrompt);
  } else {
    // Default: Gemini API with Lowest-to-Highest Cascade
    const res = await callGeminiWithCascade(apiKey, model, userPrompt, autoRollover);
    rawAnswer = res.text;
    modelUsed = res.modelUsed;
    tierSwitched = res.tierSwitched;
  }

  // Save session count and current model state
  await chrome.storage.local.set({ 
    sessionRequests, 
    modelRequests, 
    model: modelUsed 
  });

  // Post-process the LLM answer
  const cleanAnswer = cleanExtractedAnswer(rawAnswer, options);
  const matchedIndex = findBestOptionMatch(cleanAnswer, options);

  return {
    success: true,
    answer: cleanAnswer,
    rawAnswer: rawAnswer,
    matchedIndex: matchedIndex,
    modelUsed: modelUsed,
    sessionRequests: sessionRequests,
    tierSwitched: tierSwitched
  };
}

/**
 * Executes a Gemini request cascading from lowest tier to highest tier
 * if the lower tier hits its daily limit or rate limit.
 */
async function callGeminiWithCascade(apiKey, startModel, userPrompt, autoRollover) {
  let startIndex = MODEL_TIERS.findIndex(t => t.id === startModel);
  if (startIndex === -1) startIndex = 0; // Default to lowest tier

  let tierSwitched = false;

  for (let i = startIndex; i < MODEL_TIERS.length; i++) {
    const tier = MODEL_TIERS[i];
    try {
      const text = await executeGeminiCall(apiKey, tier.id, userPrompt);
      return {
        text: text,
        modelUsed: tier.id,
        tierSwitched: tierSwitched
      };
    } catch (err) {
      const errMsg = (err.message || "").toLowerCase();
      const isQuotaOrLimit = 
        errMsg.includes("429") || 
        errMsg.includes("quota") || 
        errMsg.includes("resource_exhausted") || 
        errMsg.includes("rate limit") ||
        errMsg.includes("404") ||
        errMsg.includes("not found");

      if (isQuotaOrLimit && autoRollover && i < MODEL_TIERS.length - 1) {
        const nextTier = MODEL_TIERS[i + 1];
        console.warn(`[Auto-Rollover] Model "${tier.id}" reached limit/unavailable. Auto-switching to higher tier "${nextTier.id}"...`);
        tierSwitched = true;
        continue; // Try next tier
      }

      throw err;
    }
  }

  throw new Error("All active Gemini model tiers exhausted. Please wait for quotas to reset.");
}

/**
 * Direct execution of a single Gemini API call with instant low-latency config.
 */
async function executeGeminiCall(apiKey, targetModel, userPrompt, disableThinking = true) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;

  const generationConfig = {
    temperature: 0.1,
    maxOutputTokens: 250
  };

  // Lite models do not support thinking features (causes 'invalid argument').
  // Only apply thinkingBudget: 0 to full reasoning models (Gemini 3.x non-lite).
  const isLite = targetModel.toLowerCase().includes("lite");
  if (disableThinking && !isLite && targetModel.includes("3.")) {
    generationConfig.thinkingConfig = {
      thinkingBudget: 0
    };
  }

  const requestBody = {
    systemInstruction: {
      parts: [
        { text: SYSTEM_INSTRUCTION }
      ]
    },
    contents: [
      {
        role: "user",
        parts: [
          { text: userPrompt }
        ]
      }
    ],
    generationConfig: generationConfig
  };

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });
  } catch (err) {
    throw new Error(`Network error connecting to Gemini API (${targetModel}): ${err.message}`);
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const message = errorData.error?.message || `Gemini API returned HTTP ${response.status} (${response.statusText})`;

    // If an invalid argument occurs and thinkingConfig was included, retry immediately without it
    if (response.status === 400 && generationConfig.thinkingConfig) {
      console.warn(`[Gemini API] Model "${targetModel}" rejected thinkingConfig. Retrying without thinkingConfig...`);
      return executeGeminiCall(apiKey, targetModel, userPrompt, false);
    }

    if (response.status === 400 && message.includes("API_KEY_INVALID")) {
      throw new Error("Invalid Gemini API Key. Please verify your key in the extension popup.");
    }

    throw new Error(message);
  }

  const result = await response.json();
  const candidate = result.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error(`Model ${targetModel} returned an empty response.`);
  }

  return text.trim();
}

/**
 * Queries the OpenAI Chat Completions REST API.
 */
async function callOpenAI(apiKey, model, userPrompt) {
  const targetModel = model || "gpt-4o-mini";
  const endpoint = "https://api.openai.com/v1/chat/completions";

  const requestBody = {
    model: targetModel,
    messages: [
      { role: "system", content: SYSTEM_INSTRUCTION },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.1,
    max_tokens: 300
  };

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });
  } catch (err) {
    throw new Error(`Network error connecting to OpenAI API: ${err.message}`);
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const message = errorData.error?.message || `OpenAI API returned HTTP ${response.status} (${response.statusText})`;
    if (response.status === 401) {
      throw new Error("Invalid OpenAI API Key. Please verify your key in the extension popup.");
    }
    throw new Error(message);
  }

  const result = await response.json();
  const text = result.choices?.[0]?.message?.content;

  if (!text) {
    throw new Error("OpenAI returned an empty response.");
  }

  return text.trim();
}

/**
 * Validates connection with a lightweight test ping.
 */
async function handleTestConnection(data) {
  const apiKey = data?.apiKey?.trim();
  const provider = data?.provider || "gemini";
  const model = data?.model;

  if (!apiKey) {
    throw new Error("Please enter an API key to test.");
  }

  const testPrompt = "Test query: reply with the single word 'Connected'.";

  if (provider === "openai") {
    await callOpenAI(apiKey, model || "gpt-4o-mini", testPrompt);
    return { success: true, message: "Connection successful! OpenAI API is ready." };
  } else {
    const testModel = model || "gemini-3.5-flash-lite";
    const res = await callGeminiWithCascade(apiKey, testModel, testPrompt, true);
    const activeModel = res.modelUsed || testModel;

    return { 
      success: true, 
      message: `Connection successful! Connected to Gemini (${activeModel}).`,
      activeModel: activeModel
    };
  }
}

/**
 * Strips markdown wrappers, quotes, and prefixes from the raw LLM output.
 */
function cleanExtractedAnswer(rawText, options) {
  if (!rawText) return "";

  let cleaned = rawText.trim();

  // Remove markdown bolding, backticks, quotes
  cleaned = cleaned.replace(/^[*_"`]+|[*_"`]+$/g, "").trim();

  // Remove common prefixes like "Answer: ", "Correct Option: ", "Option A: ", "1. "
  cleaned = cleaned.replace(/^(?:Answer|Correct Answer|Correct Option|Option|Result)\s*[:\-]\s*/i, "");
  cleaned = cleaned.replace(/^(?:[A-E]|[0-9]{1,2})[\.\)\-]\s*/i, "");

  // Remove enclosing quotes again if they were inside prefix
  cleaned = cleaned.replace(/^["']|["']$/g, "").trim();

  // If options are provided, check if the raw output was formatted like "A) OptionText"
  if (options && Array.isArray(options) && options.length > 0) {
    // Check if cleaned string directly matches one of the options
    for (const opt of options) {
      if (opt.trim().toLowerCase() === cleaned.toLowerCase()) {
        return opt.trim();
      }
    }
    
    // Check if the cleaned answer contains the option text or vice-versa
    for (const opt of options) {
      const optClean = opt.trim().toLowerCase();
      const ansClean = cleaned.toLowerCase();
      if (ansClean === optClean || ansClean.endsWith(optClean) || optClean.endsWith(ansClean)) {
        return opt.trim();
      }
    }
  }

  return cleaned;
}

/**
 * Finds the index of the option that best matches the LLM answer.
 * @param {string} answer 
 * @param {string[]} options 
 * @returns {number} matching index or -1
 */
function findBestOptionMatch(answer, options) {
  if (!answer || !options || !Array.isArray(options) || options.length === 0) {
    return -1;
  }

  const cleanAns = answer.trim().toLowerCase();

  // 1. Exact match (case insensitive)
  const exactIndex = options.findIndex(opt => opt.trim().toLowerCase() === cleanAns);
  if (exactIndex !== -1) return exactIndex;

  // 2. Starts with / Ends with / Includes match
  const partialIndex = options.findIndex(opt => {
    const cleanOpt = opt.trim().toLowerCase();
    return cleanOpt.length > 0 && (cleanAns.includes(cleanOpt) || cleanOpt.includes(cleanAns));
  });

  return partialIndex;
}
