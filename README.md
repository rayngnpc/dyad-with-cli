# Dyad — Local AI Agents Fork

**A community fork of [Dyad](https://dyad.sh/) that adds native support for Gemini CLI, OpenCode, and Letta as first-class AI providers.**

The original Dyad supports cloud models (Claude, GPT, Gemini API) and basic local inference via Ollama/LM Studio. This fork adds three CLI-based agents that run entirely on your machine — no API key required for Gemini.

> Community fork. For the official Dyad project, visit [dyad.sh](https://dyad.sh/).

---

## What's Different in This Fork

| Feature | Original Dyad | This Fork |
|---|---|---|
| Gemini CLI (free tier) | ✗ | ✓ Native integration |
| OpenCode agent | ✗ | ✓ Native integration |
| Letta (stateful agents) | ✗ | ✓ Native integration |
| Gemini model selection | Auto only | 8 models including Gemini 3.x |
| Tool display | Native for API models | Native for CLI models too |
| Full response completion | API models only | Fixed for all Gemini CLI models |

**Tool display** means file writes, reads, edits, and shell commands from CLI agents render as Dyad's native UI components — collapsible file cards, diffs, command outputs — identical to how built-in API models behave.

---

## Providers

### Gemini CLI
Uses Google's official [Gemini CLI](https://github.com/google-gemini/gemini-cli). Runs Gemini models locally via your Google account — **free tier available, no API key needed**.

**Available models:**
- Auto (Gemini 3) — recommended
- Auto (Gemini 2.5)
- Gemini 3.1 Pro Preview
- Gemini 3 Flash Preview
- Gemini 3.1 Flash Lite Preview
- Gemini 2.5 Pro
- Gemini 2.5 Flash
- Gemini 2.5 Flash Lite

### OpenCode
Uses [OpenCode](https://opencode.ai) — an open-source AI coding agent. Supports multiple model providers (Anthropic, OpenAI, etc.) with full tool execution.

### Letta
Uses [Letta](https://docs.letta.com) — stateful agents with persistent memory across sessions (formerly MemGPT). Best for long-running, context-heavy coding tasks.

---

## Quick Start

**Requirements:** Node.js 20+, Git

```bash
git clone https://github.com/rayngnpc/dyad-with-opencode.git
cd dyad-with-opencode
./setup.sh
npm start
```

The setup script handles `npm install`, database setup, and native module rebuilding.

### Manual Setup

```bash
git clone https://github.com/rayngnpc/dyad-with-opencode.git
cd dyad-with-opencode
npm install
npm rebuild better-sqlite3
mkdir -p userData
npm run db:push
npm start
```

---

## CLI Setup

Each provider requires its CLI to be installed and authenticated before models appear in Dyad.

### Gemini CLI

```bash
# Install
npm install -g @google/gemini-cli

# Authenticate (opens browser for Google OAuth)
gemini
```

After first-time auth, restart Dyad — Gemini models will appear under **Local models**.

### OpenCode

```bash
# Install
npm install -g opencode-ai

# Authenticate
opencode auth login
```

Restart Dyad after auth.

### Letta

```bash
# Install
pip install letta
# or: pipx install letta

# Authenticate (opens browser for Letta Cloud OAuth)
letta login
```

Restart Dyad after auth.

---

## Building Installers

```bash
npm run make
```

Outputs:
- Linux: `out/make/deb/x64/*.deb`, `out/make/rpm/x64/*.rpm`
- Windows: `out/make/squirrel.windows/x64/*.exe`
- macOS: `out/make/zip/darwin/x64/*.zip`

> Cross-platform builds require the target OS.

---

## Safety Note

This fork invokes the `gemini` binary as a subprocess — the same as running it in a terminal. It never extracts or handles OAuth tokens. See [Gemini CLI ToS](https://github.com/google-gemini/gemini-cli/blob/main/docs/tos-privacy.md).

---

## Original Dyad Features

Everything from the original Dyad is preserved:

- Local, private, no lock-in
- Bring your own API keys (Claude, GPT, Gemini API, OpenRouter)
- Ollama and LM Studio support
- Git versioning for every change
- Supabase integration
- Cross-platform (Mac, Windows, Linux)

---

## Community

- Issues: [github.com/rayngnpc/dyad-with-opencode/issues](https://github.com/rayngnpc/dyad-with-opencode/issues)
- Original Dyad community: [r/dyadbuilders](https://www.reddit.com/r/dyadbuilders/)

## License

- Code outside `src/pro`: Apache 2.0
- Code inside `src/pro`: Functional Source License 1.1

See [LICENSE](./LICENSE) for details.
