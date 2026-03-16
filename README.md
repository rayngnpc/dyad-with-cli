# Dyad with OpenCode & Letta

> **Fork of [Dyad](https://github.com/dyad-sh/dyad)** — extended to support [OpenCode CLI](https://github.com/opencode-ai/opencode) and [Letta](https://github.com/letta-ai/letta) as local AI providers.

Dyad is a local, open-source AI app builder. It's fast, private, and fully under your control — like Lovable, v0, or Bolt, but running right on your machine.

[![Image](https://github.com/user-attachments/assets/f6c83dfc-6ffd-4d32-93dd-4b9c46d17790)](https://dyad.sh/)

More info about upstream Dyad at: [https://dyad.sh/](https://dyad.sh/)

## What This Fork Adds

- **OpenCode CLI integration** — Use any model supported by [OpenCode](https://github.com/opencode-ai/opencode) as a local code agent inside Dyad. Session persistence across chats is supported.
- **Letta agent integration** — Connect to a local [Letta](https://github.com/letta-ai/letta) server for long-term memory AI agents.
- **Gemini CLI provider** — Included but **intentionally disabled**. Google actively bans accounts using automated OAuth-spawned Gemini CLI sessions. The code is present for reference but the provider is not selectable in the UI.

### Status

- OpenCode streaming, session persistence, and model selection: **working**
- Letta streaming, model list, and session handling: **working**
- OpenCode native tool output rendering (rich `<dyad-*>` tags instead of raw markdown): **in progress**

## Quick Start (Linux)

```bash
git clone https://github.com/rayngnpc/dyad-with-opencode.git
cd dyad-with-opencode
./setup.sh   # installs deps, rebuilds native modules, sets up DB
npm start
```

### Prerequisites

- **Node.js 20+**
- **OpenCode CLI** — install from [opencode-ai/opencode](https://github.com/opencode-ai/opencode) and ensure `opencode` is on your `PATH`
- **Letta** (optional) — run a local Letta server if you want memory-augmented agents

## Features (Upstream)

- Fast, private and no lock-in.
- Bring your own keys: Use your own AI API keys — no vendor lock-in.
- Cross-platform: Easy to run on Mac, Windows, or Linux.

## Community

Join the Dyad community on **Reddit**: [r/dyadbuilders](https://www.reddit.com/r/dyadbuilders/) — share your projects and get help!

## Contributing

**Dyad** is open-source (see License info below).

If you're interested in contributing to dyad, please read the upstream [contributing](./CONTRIBUTING.md) doc.

## License

- All the code in this repo outside of `src/pro` is open-source and licensed under Apache 2.0 - see [LICENSE](./LICENSE).
- All the code in this repo within `src/pro` is fair-source and licensed under [Functional Source License 1.1 Apache 2.0](https://fsl.software/) - see [LICENSE](./src/pro/LICENSE).
