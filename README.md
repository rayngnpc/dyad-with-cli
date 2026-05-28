<div align="center">

# Dyad with CLI

**A community fork of [Dyad](https://dyad.sh) that adds native support for locally-run AI CLI agents.**

[![License](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](./LICENSE)
[![Upstream](https://img.shields.io/badge/upstream-dyad--sh%2Fdyad%20v1.1.0-green.svg)](https://github.com/dyad-sh/dyad)
[![Node](https://img.shields.io/badge/node-24%2B-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-linux%20%7C%20macOS%20%7C%20windows-lightgrey.svg)]()

</div>

---

Dyad is an open-source AI app builder. This fork keeps everything the upstream project does and adds **three CLI-based AI agents** as first-class providers — letting you build with locally-run agents alongside the standard API-key flows.

> Community fork, not an official Dyad release.
> For the upstream project, see **[dyad.sh](https://dyad.sh)**.

## ✨ Highlights

- **Three CLI providers** — Gemini CLI, OpenCode, and Letta available right in the model picker
- **Native tool rendering** — file writes, edits, reads, shell commands, todos render as Dyad's native cards (no more raw JSON dumps)
- **Image attachments** — Annotator screenshots flow through to vision-capable CLI models
- **Sub-provider grouping** — OpenCode's many models organised by sub-provider in the picker
- **MCP Server Bridge** _(experimental)_ — opt-in HTTP server exposing Dyad's preview context to external MCP clients
- **All upstream features preserved** — bring-your-own API keys, Ollama/LM Studio, Git versioning, Supabase integration, cross-platform builds

## ⚠️ Gemini CLI deprecation notice

**Gemini CLI support is scheduled for removal after 15 June 2026.** Google is deprecating the underlying Gemini CLI tool; this fork will drop the integration in a future release. **OpenCode and Letta will continue to be supported.**

## 📦 What's new in this fork (vs upstream)

| Feature                                             | Upstream Dyad | This fork           |
| --------------------------------------------------- | ------------- | ------------------- |
| Cloud LLMs via API key (Claude, GPT, Gemini API, …) | ✅            | ✅                  |
| Local inference (Ollama, LM Studio)                 | ✅            | ✅                  |
| **Gemini CLI** _(free-tier, OAuth)_                 | ❌            | ✅                  |
| **OpenCode** _(local AI agent)_                     | ❌            | ✅                  |
| **Letta** _(stateful agents)_                       | ❌            | ✅                  |
| Native UI for CLI tool calls                        | —             | ✅                  |
| Image attachments through to CLI                    | —             | ✅                  |
| MCP Server Bridge                                   | ❌            | ✅ _(experimental)_ |

## 🚀 Quick Start

**Requirements:** Node.js 24+, Git

```bash
git clone https://github.com/rayngnpc/dyad-with-cli.git
cd dyad-with-cli
./setup.sh
npm start
```

The setup script installs dependencies, sets up the database, and rebuilds native modules.

<details>
<summary>Manual setup (if <code>./setup.sh</code> can't run)</summary>

```bash
npm install --legacy-peer-deps
npm rebuild better-sqlite3
mkdir -p userData
npm run db:push
npm start
```

</details>

## 🛠 Setting up the CLI providers

Each CLI provider needs to be installed and authenticated separately. After authenticating, restart Dyad — the provider's models will appear under **Local Models**.

<details>
<summary><b>Gemini CLI</b></summary>

```bash
npm install -g @google/gemini-cli
gemini   # opens browser for Google OAuth
```

</details>

<details>
<summary><b>OpenCode</b></summary>

```bash
npm install -g opencode-ai
opencode auth login
```

</details>

<details>
<summary><b>Letta</b></summary>

```bash
pip install letta   # or: pipx install letta
letta login         # opens browser for Letta Cloud OAuth
```

</details>

## 📦 Building installers

```bash
npm run make
```

| Platform | Output                                             |
| -------- | -------------------------------------------------- |
| Linux    | `out/make/deb/x64/*.deb`, `out/make/rpm/x64/*.rpm` |
| Windows  | `out/make/squirrel.windows/x64/*.exe`              |
| macOS    | `out/make/zip/darwin/x64/*.zip`                    |

Cross-platform builds require the target OS.

## 🔐 Security notes

- CLI providers spawn their respective binaries as subprocesses — Dyad never extracts or handles OAuth tokens. Credentials live where each CLI normally stores them (`~/.gemini/`, `~/.local/share/opencode/`, etc.).
- The MCP Server Bridge binds to `127.0.0.1` only and uses a cryptographic random auth token. It's opt-in and disabled by default.
- See [SECURITY.md](./SECURITY.md) for our security policy.

## 🤝 Contributing

Issues and pull requests are welcome. Before contributing, please read [CONTRIBUTING.md](./CONTRIBUTING.md). If you're reporting a CLI-provider bug, include the CLI version (`gemini --version`, `opencode --version`, `letta --version`) and your OS.

For the upstream Dyad project itself, see [dyad-sh/dyad](https://github.com/dyad-sh/dyad).

## 📜 License

- Code outside `src/pro`: **Apache 2.0**
- Code inside `src/pro`: **Functional Source License 1.1** (inherited from upstream)

See [LICENSE](./LICENSE) for full text.

## 🙏 Credits

Built on **[Dyad](https://github.com/dyad-sh/dyad)** by the Dyad team. This fork would not exist without their work — please support the upstream project.

The CLI integrations build on:

- [Gemini CLI](https://github.com/google-gemini/gemini-cli) by Google
- [OpenCode](https://opencode.ai)
- [Letta](https://docs.letta.com) (formerly MemGPT)
