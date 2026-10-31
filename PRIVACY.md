# Privacy and data transmission

Updated October 26, 2026.

Google Forms AI Assistant reads text from Google Forms pages to provide answers through a provider you select: Google Gemini or OpenAI.

## What is sent

When you click **Get Answer**, enable **Auto-solve on click**, or start **Answer & fill all**, the extension sends the question title, detected description, and text options to the selected provider. Batch requests cover uncached questions in the current section. Connection testing sends a short test prompt.

Your provider API key is sent only to the selected provider to authenticate these requests. Gemini requests go to `generativelanguage.googleapis.com`; OpenAI requests go to `api.openai.com`. The extension does not operate an application server or send this content to the extension developer. Provider handling and retention are governed by the provider's policies and your account settings.

Form questions may themselves contain personal or confidential information. Use the extension only with content you are authorized to send to the selected provider. The extension does not deliberately collect submitted form responses, email addresses, account passwords, browsing history, or telemetry. It does not submit forms automatically.

## Local storage

API keys, provider/model settings, and successful-answer counters are stored in the browser's extension-local storage. The extension does not implement additional encryption for API keys. Answers are cached in the form tab's memory. The floating panel position is saved in that page's session storage. Chrome and Firefox have separate extension storage; settings are not automatically transferred between them.

The popup lets you change credentials and configuration and reset answer counters. Closing a form tab releases its in-memory answer cache. You can manage or clear extension storage through your browser's extension developer tools.

## Firefox declarations

The manifest declares required data transmission for website content (`websiteContent`) and authentication information (`authenticationInfo`) because cloud answering sends form text and the provider API key. Firefox 140 or later displays its built-in data-consent information during installation. There is no optional analytics collection.

For questions about this extension, contact the repository maintainers at [Sushanth-25/Clever-blog](https://github.com/Sushanth-25/Clever-blog).
