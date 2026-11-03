# 🦊 Ghostfox Zero

**A sandboxed browser agent with zero blast radius.**

Ghostfox Zero takes a natural-language goal, plans the browser steps with an LLM, dispatches them to an isolated Docker container running Playwright, verifies every step with a vision model, and requires human approval before any final action — every action stays contained. An agent that only chats is a demo; **an agent that executes safely is a product.**

> Entry for the **Vultr: Agent Rush Hackathon** — Challenge 1: *Blast Radius Zero* (Pattern B: Sandboxed browser use).

---

## How it works

```
User goal
   │
   ▼
┌──────────────────────────────────────────────────────┐
│  CONTROL LAYER (Vultr VM — Node.js/Express)          │
│                                                      │
│  1. PLAN      → LLM turns the goal into steps       │
│  2. DISPATCH  → steps are sent to the sandbox       │
│  3. VERIFY    → vision model checks the screenshot   │
│  4. APPROVE   → human gate before final actions     │
│                                                      │
│  LLM + vision = Vultr Serverless Inference           │
└──────────────┬───────────────────────────────────────┘
               │ plain-text steps only (no secrets ever enter)
               ▼
┌──────────────────────────────────────────────────────┐
│  SANDBOX (Docker container — one per task)           │
│                                                      │
│  Playwright + headless Chromium                      │
│  · memory capped  · CPU capped  · hard timeout      │
│  · container destroyed (--rm) after every task       │
│  · zero access to host runtime or credentials        │
└──────────────┬───────────────────────────────────────┘
               │ screenshots only
               ▼
      verified results + artifacts
```

## Containment model (Blast Radius Zero)

| Control | Implementation |
|---|---|
| **Process isolation** | Every task runs in its own Docker container (`--rm`). Execution never touches the host or app runtime. No host volumes are mounted into the sandbox. |
| **Secret hygiene** | API keys live only in the control layer. The sandbox receives plain-text browser steps over a local socket — credentials never cross the boundary. |
| **Resource limits** | `--memory 512m --cpus 0.5` per container, plus a hard wall-clock timeout enforced by the orchestrator. |
| **Lifecycle discipline** | Containers are created per task and destroyed immediately after (`docker run --rm`). No state survives a task. |

## Vultr services used

- **Vultr Cloud Compute (VM)** — hosts the control layer (Node.js/Express) and the Docker sandbox runtime. Vultr is the central system of control and orchestration, not static hosting.
- **Vultr Serverless Inference** (`https://api.vultrinference.com/v1`) — powers **all** agent LLM calls: step planning (chat model) and screenshot verification (vision model). OpenAI-compatible API.

The sandbox image is built on the VM with plain Docker (`docker build`), keeping the whole stack on Vultr infrastructure.

## Quick start (on a Vultr VM)

```bash
# 1. Provision a Vultr Cloud Compute instance (Ubuntu 22.04+, ≥1 vCPU, 2 GB RAM)

# 2. Install Docker
curl -fsSL https://get.docker.com | sh

# 3. Clone and configure
git clone <this repo>
cd ghostfox-zero
cp .env.example .env
# set VULTR_INFERENCE_API_KEY=... (from Vultr Console → Serverless Inference)

# 4. Build the sandbox image (hardened Playwright runner)
docker build -t ghostfox-sandbox ./sandbox

# 5. Start the control layer
npm install --prefix server
node server/index.js

# 6. Open the web UI
# http://<your-vultr-ip>:3000
```

## Usage

1. Type a goal, e.g. *"Go to example.com, fill the contact form with the given details, show me before you submit."*
2. Ghostfox Zero plans the steps, executes them inside the sandbox, and verifies each one with a vision model.
3. Before any **final action** (form submit, click that commits data), the run pauses — you review the screenshot and press **Approve** or **Reject**.
4. When the run finishes the container is destroyed. Zero residue, zero blast radius.

## Project layout

```
ghostfox-zero/
├── README.md            ← you are here
├── docker-compose.yml   ← full stack (control layer)
├── .env.example         ← configuration template
├── server/
│   ├── index.js         ← Express app + static web UI (control layer)
│   ├── inference.js     ← Vultr Serverless Inference client (chat + vision)
│   ├── orchestrator.js  ← plan → dispatch → verify → approve loop
│   └── sandbox.js       ← per-task Docker container lifecycle manager
├── sandbox/
│   ├── Dockerfile       ← hardened Playwright + Chromium image
│   └── runner.js        ← executes step lists, saves screenshots, exits
├── web/
│   ├── index.html       ← control UI: goal input, live log, approve gate
│   └── app.js           ← polling client + step timeline rendering
└── docs/
    └── architecture.md  ← deeper design notes
```

## License

MIT
