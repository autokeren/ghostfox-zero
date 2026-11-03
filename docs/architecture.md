# Architecture notes

## The containment contract

Ghostfox Zero enforces four controls, mapped 1:1 to the "Blast Radius Zero" brief:

1. **Process isolation** — every task is a fresh `docker run --rm` container. The container gets no host mounts (except a scratch dir for screenshots flowing out), `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 256`.
2. **Secret hygiene** — the Vultr Inference API key lives only in the control layer's env. The sandbox receives a plain-text JSON step list on stdin. Credentials never cross the boundary. The runner additionally enforces an allow-list of actions and blocks non-http(s) navigation.
3. **Resource limits** — `--memory 512m --cpus 0.5` per container plus a wall-clock kill in the control layer (`SANDBOX_TIMEOUT_MS`).
4. **Lifecycle discipline** — containers are created per task chunk and destroyed immediately. Screenshot scratch dir is deleted. Nothing survives a run.

## Why chunks?

The planner output is split at "final actions" (form submits, anything that commits data). Each boundary triggers the **human approval gate**: the run pauses, the latest verified screenshot is shown in the UI, and a human presses Approve/Reject. This is the "human approval before final actions" required by Pattern B.

## Verification loop

After each chunk executes, the control layer sends the latest screenshot to the **vision model on Vultr Serverless Inference** together with the goal and the executed step description. The model answers `{"pass": bool, "reason": "..."}`. A failed verification aborts the run (with the failure screenshot preserved) instead of letting the fox flail.

## Model choice

Both the planning (chat) and verification (vision) models are configurable via env (`INFERENCE_CHAT_MODEL`, `INFERENCE_VISION_MODEL`) against `https://api.vultrinference.com/v1` — check the live model list at `https://api.vultrinference.com/v1/models`.

## Scaling notes (out of scope for the hackathon build)

- The in-memory single-run assumption is intentional for the 5-day build. A production version would swap the event bus for Redis streams and run the sandbox pool on Vultr Kubernetes Engine.
