# 🦊 Ghostfox Zero

**A sandboxed browser agent with zero blast radius — powered by the Ghostfox engine.**

Ghostfox Zero takes a natural-language goal and pursues it with a **true agentic loop**: the reasoning model (Vultr Serverless Inference) sees the live page through Ghostfox's semantic accessibility layer, decides one action at a time, executes it inside a disposable Ghostfox engine container, verifies every step with a vision model, and requires **human approval** before any action that commits data.

**Live demo:** [https://zero.autokeren.com](https://zero.autokeren.com)

Headless Chrome agents eat Cloudflare 403s on ~20% of the web. Ghostfox Zero runs **Ghostfox** — a fingerprint-coherent Firefox engine with C++-level anti-detect and a Rust MCP runtime — so the agent goes where other agents get blocked.

> Entry for the **Vultr: Agent Rush Hackathon** — Challenge 1: *Blast Radius Zero*.

---

## How it works

```
User goal
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│  CONTROL LAYER (Vultr VM — Node.js/Express)                 │
│                                                             │
│   ┌────────────── AGENTIC LOOP ──────────────┐              │
│   │  1. READ   page_a11y (semantic refs)     │              │
│   │  2. THINK  LLM decides ONE next action   │ ← Vultr     │
│   │  3. ACT    click/type/press via MCP      │   Serverless │
│   │  4. LOOK   screenshot → vision verify    │   Inference  │
│   │  5. GATE   human approval on final acts   │              │
│   └───────────────────────────────────────────┘              │
│                                                             │
│   MCP over stdio (docker run -i)                            │
└──────────────┬──────────────────────────────────────────────┘
               │ plain-text MCP commands only (no secrets cross)
               ▼
┌─────────────────────────────────────────────────────────────┐
│  SANDBOX — official Ghostfox container (one per task)       │
│                                                             │
│  ghcr.io/autokeren/ghostfox                                 │
│  Firefox 152 → Camoufox anti-detect → Ghostfox engine (C++) │
│  Ghostfox runtime (Rust: sessions, identities, MCP server)   │
│                                                             │
│  · memory capped   · CPU capped    · hard timeout           │
│  · cap-drop ALL    · no-new-privileges · pids limit        │
│  · container destroyed (--rm) after every task              │
│  · only the artifact dir is mounted; nothing else crosses   │
└─────────────────────────────────────────────────────────────┘
```

## Containment model (Blast Radius Zero)

| Control | Implementation |
|---|---|
| **Process isolation** | Every task runs in its own disposable Ghostfox container (`docker run -i --rm`). Execution never touches the host or the control-layer runtime. No host mounts except the read-out artifact dir. |
| **Secret hygiene** | The Vultr Inference API key lives only in the control layer. The sandbox receives plain-text MCP commands over stdio — credentials never cross the boundary. |
| **Resource limits** | `--memory 1g --cpus 1.0 --pids-limit 400` per container plus a hard wall-clock timeout that SIGKILLs the engine. |
| **Lifecycle discipline** | Containers are created per task and destroyed immediately after; the artifact dir is wiped. Zero residue. |

## Vultr services used

- **Vultr Cloud Compute (VM)** — hosts the control layer (Node.js/Express) and the Docker sandbox runtime. Vultr is the central system of control and orchestration.
- **Vultr Serverless Inference** (`https://api.vultrinference.com/v1`) — powers **all** agent reasoning: action decisions (chat) and screenshot verification (vision) via the OpenAI-compatible API. No other LLM provider is used.

## Why the Ghostfox engine (and not headless Chromium)

| | Ghostfox Zero | Typical entries |
|---|---|---|
| Browser engine | Ghostfox (Firefox fork, C++-level fingerprint coherence) | headless Chromium |
| Anti-bot walls (Cloudflare etc.) | passes — engine-level spoofing | frequently blocked |
| Agent I/O | semantic a11y tree with stable refs, vision tiers, network capture | raw DOM/CSS selectors |
| Runtime | Rust MCP runtime (19+ tools) | JS glue |

The sandbox image is pulled straight from **`ghcr.io/autokeren/ghostfox`** — the same artifact real Ghostfox users self-host.

## Quick start (on a Vultr VM)

```bash
# 1. Provision a Vultr Cloud Compute instance (Ubuntu 24.04, 1 vCPU, 2 GB RAM)

# 2. Install Docker
curl -fsSL https://get.docker.com | sh

# 3. Clone and configure
git clone <this repo>
cd ghostfox-zero
cp .env.example .env
# set VULTR_INFERENCE_API_KEY=... (Vultr Console → Serverless Inference)

# 4. Pull the Ghostfox engine image (the sandbox)
docker pull ghcr.io/autokeren/ghostfox:latest

# 5. Start the control layer
npm install --prefix server
node server/index.js

# 6. Open the web UI
# https://zero.autokeren.com
```

## Usage

1. Type a goal, e.g. *"Open https://httpbin.org/forms/post and fill the custname field with Ghostfox Zero, then show me before submitting."*
2. Watch the agentic loop: the engine spawns in a fresh container, opens the page, reads it semantically, and acts one step at a time — each decision made by the LLM on Vultr Serverless Inference, each step verified by the vision model.
3. Before any **final action** (submit, purchase, send), the run pauses — review the screenshot and press **Approve** or **Reject**.
4. When the run finishes, the container is destroyed. Zero residue, zero blast radius.

## Project layout

```
ghostfox-zero/
├── README.md               ← you are here
├── docker-compose.yml      ← control layer stack
├── .env.example            ← configuration template
├── server/
│   ├── index.js            ← Express app + SSE events + approval API
│   ├── mcp-client.js       ← MCP stdio client (JSON-RPC over docker -i)
│   ├── inference.js        ← Vultr Serverless Inference client (chat + vision)
│   ├── orchestrator.js    ← the agentic loop (read → think → act → verify → gate)
│   └── sandbox.js          ← disposable Ghostfox container lifecycle manager
├── web/                    ← control UI: live log, screenshots, approval gate
└── docs/
    └── architecture.md     ← deeper design notes
```

## License

MIT
