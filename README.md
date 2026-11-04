# n8n agent assertions

Four read-only n8n workflows that watch AI agents in production and tell you when one starts failing quietly. Import them, point them at your agents, and they alert through the error workflow you already use.

| Workflow | Catches | How |
|---|---|---|
| **ARR - Credential liveness** | A credential that has died: an expired key, a rotated token, a revoked app | Once an hour, one cheap read-only call with each credential. A 401 or 403 means it's dead |
| **ARR - Success rate** | A workflow failing more often than it should | Once an hour, each workflow's failure rate over a rolling window, against its own threshold |
| **ARR - Cost and iteration ceiling** | Runaway agent loops and retry storms | Every 15 minutes, each recent run's duration, node runs and tokens against ceilings, including runs still going past their time limit |
| **ARR - Golden case** | An agent whose answer changed shape after a model, prompt, provider or n8n change | One fixed input, with the answer checked against the expected keys and types. Run it by hand after any change; it also runs daily |

## How the alerts work

Each workflow ends in a **Check** node. When a check fails, Check stops the run with an error that says what failed, for example:

```
ARR - Credential liveness failed, 1 of 2 credentials. Probe 2 credential rejected (HTTP 401)
```

n8n then runs the workflow's **Error Workflow**. Set that (Workflow settings > Error Workflow) to the one your other workflows already use, and the alert lands wherever your alerts already go: Slack, email, a ticket. Two n8n rules to know:
- error workflows run only for active workflows, not for manual test runs;
- the error workflow itself must be active.

## Install

1. Download the four files in [`workflows/`](workflows).
2. In n8n: **Workflows > Import from File**, one at a time.
3. Follow the sticky note in each workflow: which credential to pick, the thresholds to set, and the error workflow.
4. Click **Run now** once to see it pass, then **Activate**.

What each one needs:
- **Success rate** and **Cost and iteration ceiling:** an n8n API credential for the same instance. A key with `execution:read` and `execution:list` is enough.
- **Credential liveness:** each credential you want watched, plus a read-only URL it can call.
- **Golden case:** the agent's URL and an input that is safe to send.

## Read-only by design

None of them writes to your systems.
- **Success rate** and **Cost and iteration ceiling** read your execution history through the n8n API.
- **Credential liveness** makes GET requests with your credentials.
- **Golden case** sends one test input to your agent. Point it at a test record or the agent's test path, never at an input that changes real data.

## Setting the thresholds

Set them from your own baseline rather than guessing:
- Ceilings at about five times a workflow's median run, with floors of 30 seconds, 10 node runs and 5,000 tokens.
- A failure-rate threshold at twice the rate you normally see, and at least 5%.

Each **Check** node has these settings at the top, with a per-workflow override.

## Tested

Each workflow was imported and run on n8n 2.32.3 in queue mode (main and worker, Postgres, Redis) on 2026-10-20, with a passing and a failing case for each check. A failing check was also delivered through an active error workflow. The files also import and run on n8n 1.123.85. The node versions used are the ones both n8n 1.x and 2.x load.

## What this proves

An agent can stop working and still look healthy. Each check here was run with a passing and a failing case, so you can see it catch the failure it was built for. Those are a dead credential, a rising failure rate, a runaway loop, and an answer that changed shape after a model update.

These are the checks I install when I repair a client's n8n agent. On a full agent-estate review, they are tuned to the client's own run history, and the client keeps them.

## Who built this

Jarrod Wright, The Certainty Engineer. I step in when a production n8n workflow or AI agent breaks. Every engagement starts with a written diagnosis, where each root cause comes with its evidence. No repair starts before that.

For several agents with weeks of failures, there is the agent-estate review. It is a fixed-price, read-only review of up to 30 days of run history, with these checks tuned to your thresholds. For how I build failure handling into n8n workflows, see [n8n-workflow-hardening](https://github.com/jarrod-wright/n8n-workflow-hardening).

Email jarr.wright@gmail.com with what your agents do and what is going wrong. I reply within 24 hours.

## Licence

MIT. See [LICENSE](LICENSE).
