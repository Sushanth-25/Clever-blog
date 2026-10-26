/** Shared background logic for Chrome's worker and Firefox's event page. */
const extensionApi = typeof browser === 'undefined' ? chrome : browser;

const SYSTEM_INSTRUCTION =
  'Answer the supplied question accurately. Follow the requested response format exactly. Do not add explanations or markdown.';

// Serialize counter updates across tabs. No network requests run inside this queue.
let counterUpdates = Promise.resolve();
function updateCounters(model) {
  const pending = counterUpdates.then(async () => {
    if (!model) {
      await extensionApi.storage.local.set({ sessionRequests: 0, modelRequests: {} });
      return 0;
    }
    const config = await extensionApi.storage.local.get(['sessionRequests', 'modelRequests']);
    const sessionRequests = (config.sessionRequests || 0) + 1;
    const modelRequests = config.modelRequests || {};
    modelRequests[model] = (modelRequests[model] || 0) + 1;
    await extensionApi.storage.local.set({ sessionRequests, modelRequests });
    return sessionRequests;
  });
  counterUpdates = pending.catch(() => {}); // One storage failure must not poison the queue.
  return pending;
}

extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let task;
  switch (message.action) {
    case 'GET_ANSWER':
      task = handleGetAnswer(message.data);
      break;
    case 'TEST_CONNECTION':
      task = handleTestConnection(message.data);
      break;
    case 'RESET_SESSION_COUNT':
      task = updateCounters().then(() => ({ success: true }));
      break;
    case 'CHECK_KEY_STATUS':
      task = extensionApi.storage.local.get(['apiKey', 'provider', 'model', 'sessionRequests', 'autoRollover'])
        .then(config => ({
          hasKey: Boolean(config.apiKey?.trim()),
          provider: config.provider || 'gemini',
          model: config.model || MODELS_BY_PROVIDER[config.provider || 'gemini'][0].value,
          sessionRequests: config.sessionRequests || 0,
          autoRollover: config.autoRollover !== false
        }));
      break;
    default:
      return false;
  }
  task.then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
  return true;
});

function selectedModel(provider, model) {
  const models = MODELS_BY_PROVIDER[provider];
  if (!models) throw new Error('Choose a supported provider in extension settings.');
  const selected = model || models[0].value;
  if (!models.some(entry => entry.value === selected)) {
    throw new Error('The selected model is no longer supported. Open extension settings and save an available model.');
  }
  return selected;
}

async function handleGetAnswer(data) {
  const { questionText, options = [], questionType } = data || {};
  if (!questionText?.trim()) throw new Error('No question text was provided.');
  const config = await extensionApi.storage.local.get(['apiKey', 'provider', 'model', 'autoRollover']);
  const apiKey = config.apiKey?.trim();
  if (!apiKey) throw new Error('API key is missing. Open extension settings and save your API key.');
  const provider = config.provider || 'gemini';
  const model = selectedModel(provider, config.model);
  const multiple = questionType === 'checkbox';
  let userPrompt = `Question: ${questionText.trim()}\n\n`;
  if (options.length) {
    userPrompt += `Options (JSON): ${JSON.stringify(options)}\n\n`;
    userPrompt += multiple
      ? 'Select ALL correct options. Return ONLY a JSON array of their exact option texts, such as ["first option", "second option"].'
      : 'Return ONLY the exact text of the single correct option.';
  } else {
    userPrompt += 'Return a direct, concise answer without explanation.';
  }
  const result = provider === 'gemini'
    ? await callGeminiWithCascade(apiKey, model, userPrompt, config.autoRollover !== false)
    : { text: await callOpenAI(apiKey, model, userPrompt), modelUsed: model, tierSwitched: false };
  const parsed = parseAnswer(result.text, options, multiple);
  const sessionRequests = await updateCounters(result.modelUsed);
  // Fallback is per request; never overwrite settings saved while a request was running.
  return { success: true, ...parsed, rawAnswer: result.text, modelUsed: result.modelUsed, sessionRequests, tierSwitched: result.tierSwitched };
}

async function callGeminiWithCascade(apiKey, startModel, userPrompt, autoRollover) {
  const models = MODELS_BY_PROVIDER.gemini.map(model => model.value);
  const startIndex = models.indexOf(startModel);
  if (startIndex < 0) throw new Error('Choose an available Gemini model in extension settings.');
  const candidates = autoRollover ? models.slice(startIndex) : [startModel];
  for (const model of candidates) {
    try {
      return { text: await executeGeminiCall(apiKey, model, userPrompt), modelUsed: model, tierSwitched: model !== startModel };
    } catch (error) {
      const unavailable = [404, 429, 503].includes(error.status) || error.name === 'TimeoutError';
      if (!unavailable || model === candidates.at(-1)) throw error;
    }
  }
}

async function executeGeminiCall(apiKey, model, userPrompt) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
    }),
    signal: AbortSignal.timeout(25000)
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error?.message || `Gemini returned HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  const candidate = result.candidates?.[0];
  if (candidate?.finishReason !== 'STOP') {
    throw new Error(`Gemini did not finish an answer (${candidate?.finishReason || result.promptFeedback?.blockReason || 'no candidate'}).`);
  }
  const text = candidate.content?.parts?.filter(part => !part.thought).map(part => part.text || '').join('').trim();
  if (!text) throw new Error(`Gemini model ${model} returned an empty answer.`);
  return text;
}

async function callOpenAI(apiKey, model, userPrompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: SYSTEM_INSTRUCTION }, { role: 'user', content: userPrompt }],
      temperature: 0.1,
      max_tokens: 1024
    }),
    signal: AbortSignal.timeout(25000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `OpenAI returned HTTP ${response.status}.`);
  const choice = result.choices?.[0];
  if (choice?.finish_reason !== 'stop') throw new Error('OpenAI did not finish an answer.');
  const text = choice.message?.content?.trim();
  if (!text) throw new Error('OpenAI returned an empty answer.');
  return text;
}

async function handleTestConnection(data) {
  const apiKey = data?.apiKey?.trim();
  if (!apiKey) throw new Error('Please enter an API key to test.');
  const provider = data.provider || 'gemini';
  const model = selectedModel(provider, data.model);
  const prompt = 'Reply with only the word Connected.';
  // Verify exactly the displayed settings. Testing has no storage side effects.
  if (provider === 'gemini') await executeGeminiCall(apiKey, model, prompt);
  else await callOpenAI(apiKey, model, prompt);
  return { success: true, message: `Connection successful: ${model}.`, activeModel: model };
}

function findBestOptionMatch(answer, options) {
  const normalized = answer.trim().toLowerCase();
  const matches = options.map((option, index) => option.trim().toLowerCase() === normalized ? index : -1)
    .filter(index => index >= 0);
  return matches.length === 1 ? matches[0] : -1;
}

function cleanExtractedAnswer(rawText, options = []) {
  const original = rawText.trim();
  // Preserve exact option labels before removing formatting or numbering.
  const exactIndex = findBestOptionMatch(original, options);
  if (exactIndex >= 0) return options[exactIndex];
  const cleaned = original
    .replace(/^(?:Answer|Correct Answer|Correct Option|Result)\s*:\s*/i, '')
    .replace(/^(?:[A-E]|[0-9]{1,2})[.)]\s+/i, '')
    .replace(/^(?:\*\*|__|["'`])([\s\S]*?)(?:\*\*|__|["'`])$/, '$1').trim();
  const index = findBestOptionMatch(cleaned, options);
  return index >= 0 ? options[index] : (options.length ? cleaned : original);
}

function parseAnswer(rawText, options, multiple) {
  if (!multiple || !options.length) {
    const answer = cleanExtractedAnswer(rawText, options);
    const matchedIndex = findBestOptionMatch(answer, options);
    return { answer, matchedIndex, matchedIndices: matchedIndex < 0 ? [] : [matchedIndex] };
  }
  let answers;
  try { answers = JSON.parse(rawText.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, '$1')); }
  catch { throw new Error('The model did not return a valid JSON array for this checkbox question. Try again.'); }
  if (!Array.isArray(answers) || !answers.length || answers.some(answer => typeof answer !== 'string')) {
    throw new Error('Expected a non-empty array of checkbox option texts.');
  }
  const indices = answers.map(answer => findBestOptionMatch(answer, options));
  if (indices.some(index => index < 0)) throw new Error('A checkbox answer did not uniquely match an option. No options were selected.');
  const matchedIndices = [...new Set(indices)].sort((a, b) => a - b);
  return { answer: matchedIndices.map(index => options[index]).join('\n'), matchedIndex: matchedIndices[0], matchedIndices };
}
