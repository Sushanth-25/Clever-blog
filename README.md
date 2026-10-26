# Google Forms AI Assistant

A Chrome extension (Manifest V3) that reads Google Forms questions and requests suggested answers from Google Gemini or OpenAI. Answers appear in a draggable overlay on the form page.

## Installation

1. Clone this repository, or download and extract it from GitHub. Access to the repository is required if it is private:
   ```sh
   git clone git@github.com:Sushanth-25/Clever-blog.git
   cd Clever-blog
   ```
2. Open `chrome://extensions/` in Google Chrome and enable **Developer mode**.
3. Click **Load unpacked** and select the repository folder containing `manifest.json`. No build step or package installation is required.
4. Pin **Google Forms AI Assistant** using Chrome's Extensions menu, then click its icon to open settings.
5. Choose a provider and model, enter a key for that provider, and click **Save Key**. Keys can be created in [Google AI Studio](https://aistudio.google.com/app/apikey) or [OpenAI Platform](https://platform.openai.com/api-keys).
6. Click **Test Key** to make a real API request with the settings shown in the popup. Testing checks exactly the chosen model, never falls back, and never changes saved settings. Click **Save Key** after changing settings.
7. Open or reload a Google Form at `https://docs.google.com/forms/...`.

Model access, billing, and quotas depend on the provider and account. The shared Gemini allowlist in `models.js` contains only models that returned generated text with the supplied review key on October 22, 2026. No key is included in the source. Use **Test Key** to check current access with your own key. If upgrading from an older version, open settings and save a model from the updated list.

## Usage

- Click a form question or use the overlay's **◀ / ▶** buttons to choose a detected question.
- Click **Get Answer** to request a suggestion. **Auto-solve on click** is off by default; when enabled, changing the active question by clicking, focusing, or using the arrows requests an answer.
- Use **Copy** to copy the answer. When an option is matched, **Highlight & Select in Form** clicks that option. Review the suggestion before selecting it; AI answers and option matching can be incorrect.
- Click **Answer & fill all** to request and apply answers sequentially for every detected question in the **current section**, including text fields. Cached answers are reused. Progress shows filled and skipped questions, with reasons for skipped answers. This can replace existing responses in that section.
- Click **Stop** to end a batch. An API request already sent may finish and be cached, but its answer will not be applied after Stop. A failed request or a change to the question list stops the batch. Unmatched options and unavailable controls are skipped.
- The extension does not click **Next** or **Submit**. Move to the next section yourself and run **Answer & fill all** again. Single-question **Get Answer**, copying, and manual option selection remain available.
- Drag the header to move the overlay, click **—** to minimize it, or click the minimized header to expand it. Closing with **✕** hides it until the page is reloaded.
- Use **Rescan** if the displayed questions do not match the current form section.

## Verified Gemini models

These model IDs returned HTTP 200 with generated text during the live check:

| Model ID | Included |
| --- | --- |
| `gemini-3.5-flash-lite` | Yes, default |
| `gemini-3-flash-preview` | Yes |
| `gemini-3.5-flash` | Yes |
| `gemini-3.6-flash` | Yes |

The old `gemini-3-flash` ID returned 404. The tested 2.5 models returned 404 because they were unavailable to this key. Pro models returned 429 with zero free-tier quota. `gemini-3.1-flash-lite`, its preview, and `gemini-3.8-flash` returned 503 during testing and are excluded because generation could not be verified. A 503 indicates temporary unavailability, not proof that the key lacks permission. Model listing alone is not treated as proof of working generation. Moving `latest` aliases are omitted in favor of explicit model IDs.

Availability can change between requests, including for models that passed. See [Google's model catalog](https://ai.google.dev/gemini-api/docs/models) and [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).

## Behavior and limitations

- The scraper detects radio buttons, checkboxes, dropdown options, and text fields using Google Forms DOM selectors. Changes to Google's markup can break detection. Images and other non-text question content are not sent to the model. Multi-row radio grids are skipped rather than flattened into a single question; other grid types are not supported.
- Checkbox answers use a JSON array of exact option texts. Selecting an answer checks every matched option and clears other checked options. Repeated selection preserves that state. Invalid or ambiguous checkbox answers show an error rather than choosing a partial match.
- Single-choice matching requires a unique, case-insensitive exact option label after limited formatting cleanup. Exact labels are preserved before cleanup, including numbers such as `1.5`. Unmatched answers can be copied but cannot be selected automatically.
- Answers are cached per question element, title, description, type, and options. Form changes refresh the overlay even when the number of questions stays the same. Responses arriving after navigation are cached for their original question.
- Optional Gemini fallback tries later entries in the shared allowlist on HTTP 404, 429, 503, or a request timeout. It does not change your saved model. A selected model near the end of the list has fewer fallback candidates. Connection testing always checks only the selected model.
- **Successful answers** counts completed, parsed answer responses across tabs. It persists until manually reset and excludes connection tests and failed requests. It is not a provider usage meter or quota: failed requests and retries may still consume provider resources. The extension makes no fixed daily-quota claims.
- The overlay uses Shadow DOM for style isolation and moves inside the fullscreen element when fullscreen changes. Text answers can be copied manually or entered by **Answer & fill all**. Forms are never submitted automatically.

## Data and permissions

The API key and settings are stored in `chrome.storage.local`; the extension does not implement encryption for the key. Each answer request sends the selected question's title, description (when detected), and text options to the chosen provider. Enabling auto-solve sends requests as the active question changes. **Answer & fill all** sends sequential requests for uncached questions in the current section and applies the results. There is no application server in this repository.

The manifest declares `storage` and `activeTab` permissions, plus host access to Google Forms and the Gemini and OpenAI API domains. The content script runs on matching `docs.google.com/forms/*` pages. Only use the extension with form content you are authorized to share with the selected provider.

## Files

```text
Clever-blog/
├── manifest.json   # Extension configuration and permissions
├── background.js   # API requests, fallback, answer matching, and counters
├── models.js       # Shared provider model allowlist
├── content.js      # Form scraping, overlay, answer cache, and option selection
├── popup.html      # Settings interface
├── popup.js        # Settings persistence and connection testing
├── icons/          # Extension icons (16, 32, 48, and 128 pixels)
├── tests/          # Worker regressions and headless Chrome UI checks
└── README.md
```

## Development checks

No package installation or build step is needed. With a current Node.js release (22+ recommended), run:

```sh
node --check background.js
node --check content.js
node --check popup.js
node --check models.js
node --test tests/*.test.cjs
```

After changes, reload the extension in `chrome://extensions/` and reload the form tab. Check the popup, service worker, and form-page consoles when troubleshooting. Syntax checks alone do not validate Chrome integration, Google Forms selectors, or live API access.

Worker tests use mocked API/storage boundaries and require no API key. Browser tests run the real content script against a local fixture using an isolated headless Chrome profile. They use the standard macOS Chrome path or `google-chrome` on other systems; set `CHROME_PATH` for a different executable. Browser tests are skipped when Chrome is absent. The fixtures do not validate live Google Forms markup or authenticated OpenAI access.
