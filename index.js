const CUSTOM_TYPE = "its-my-turn";

const PROTOCOL = `Its My Turn is enabled. Lead and worker share this session and its full transcript; no subagent or separate summary is involved.

LEAD is the decision layer. Survey the necessary context, resolve ambiguity, and own the execution contract: goal, scope and non-goals, relevant files and invariants, ordered steps, acceptance checks, and risks. Keep implementation and routine verification with the worker. When the plan or a requested decision is complete, call turn_execute exactly once. If user clarification is needed, ask the user instead.

WORKER is the execution layer. Follow the latest turn_execute contract without redesigning it. Implement and verify it, then report concrete evidence. When reality differs from the plan, a blocker appears, scope or invariants become ambiguous, or repeated attempts fail, stop and call turn_ask with a precise question and evidence instead of guessing.`;

const WORKER_WAKE = `<its-my-turn role="worker">The worker model is active. Execute the latest turn_execute contract in the shared transcript. Use turn_ask if a lead decision is needed.</its-my-turn>`;
const LEAD_WAKE = `<its-my-turn role="lead">The lead model is active. Resolve the latest turn_ask request in the shared transcript. Make the decision, revise the execution contract as needed, then call turn_execute.</its-my-turn>`;
const LEAD_REARM = `<its-my-turn role="lead">The worker's run has ended. The lead model is active for the next user task; no new model turn is requested now.</its-my-turn>`;
const DISABLED = `<its-my-turn state="off">Its My Turn is disabled. Continue as the normal single-model agent.</its-my-turn>`;

function modelKey(model) {
  return model ? `${model.provider}/${model.id}` : "unknown";
}

function toolResult(text, isError = false, details = {}) {
  return {
    content: [{ type: "text", text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

export default function itsMyTurn(pi) {
  const z = pi.zod;
  const state = {
    enabled: false,
    role: "lead",
    lead: null,
    worker: null,
    escalations: 0,
    handoffs: 0,
  };

  function reset() {
    state.enabled = false;
    state.role = "lead";
    state.lead = null;
    state.worker = null;
    state.escalations = 0;
    state.handoffs = 0;
  }

  function isMain(ctx) {
    return !ctx.agent || ctx.agent.kind === "main";
  }

  function currentModel(ctx) {
    return ctx.models.current() ?? ctx.model;
  }

  function statusText() {
    if (!state.enabled) return "Its My Turn is off.";
    return `Its My Turn: ${state.role}; lead=${modelKey(state.lead)}; worker=${modelKey(state.worker)}; handoffs=${state.handoffs}; escalations=${state.escalations}.`;
  }

  async function addContext(content, triggerTurn) {
    await pi.sendMessage(
      {
        customType: CUSTOM_TYPE,
        content,
        display: false,
        attribution: "agent",
      },
      { deliverAs: "nextTurn", triggerTurn },
    );
  }

  async function switchRole(ctx, nextRole) {
    const target = nextRole === "lead" ? state.lead : state.worker;
    const previousRole = state.role;
    try {
      await pi.setModel(target);
      const actual = currentModel(ctx);
      if (actual && modelKey(actual) !== modelKey(target)) {
        throw new Error(`requested ${modelKey(target)}, active model is ${modelKey(actual)}`);
      }
    } catch (error) {
      state.enabled = false;
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Its My Turn could not switch models: ${message}. Plugin disabled and the current run was stopped.`, "error");
      ctx.abort();
      return false;
    }

    state.role = nextRole;
    state.handoffs += 1;
    ctx.ui.notify(`Its My Turn: ${previousRole} → ${nextRole}`, "info");
    return true;
  }

  pi.setLabel("Its My Turn!");

  pi.on("session_start", () => {
    reset();
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!state.enabled || !isMain(ctx)) return;

    // A worker answer without an escalation ends the active assignment. Rearm the
    // lead for the next user task without paying for an extra model turn.
    if (state.role === "worker" && (await switchRole(ctx, "lead"))) {
      await addContext(LEAD_REARM, false);
    }
  });

  pi.registerTool({
    name: "turn_execute",
    label: "Its My Turn: execute",
    description: "LEAD ONLY. Hand a complete implementation plan or a decision on a worker question to the economic worker. The instructions must be self-contained and include the goal, constraints, ordered steps, and acceptance checks. Call this as the only tool in the assistant step; the next model request will come from the worker.",
    loadMode: "essential",
    approval: "read",
    parameters: z.object({
      instructions: z.string().describe("Complete execution contract or revised contract after a lead decision."),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!state.enabled || !isMain(ctx)) return toolResult("Its My Turn is off. Enable it with /turn on first.", true);
      if (state.role !== "lead") return toolResult("Only the lead can call turn_execute.", true);
      if (!params.instructions.trim()) return toolResult("instructions must not be empty.", true);
      if (!(await switchRole(ctx, "worker"))) return toolResult("Worker activation failed; the run was stopped.", true);

      return toolResult(WORKER_WAKE, false, { target: "worker" });
    },
  });

  pi.registerTool({
    name: "turn_ask",
    label: "Its My Turn: ask lead",
    description: "WORKER ONLY. Stop and ask the lead for a decision when observations contradict the plan, a blocker appears, scope or invariants are unclear, or repeated attempts fail. Provide the exact question, observed evidence, and attempts already made. Call this as the only tool in the assistant step; the next model request will come from the lead.",
    loadMode: "essential",
    approval: "read",
    parameters: z.object({
      question: z.string().describe("The single decision the lead must make."),
      observed: z.string().describe("Expected versus actual behavior, including relevant errors or evidence."),
      tried: z.string().describe("Attempts already made, or 'none'."),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!state.enabled || !isMain(ctx)) return toolResult("Its My Turn is off. Enable it with /turn on first.", true);
      if (state.role !== "worker") return toolResult("Only the worker can call turn_ask.", true);
      if (!params.question.trim() || !params.observed.trim() || !params.tried.trim()) {
        return toolResult("question, observed, and tried must not be empty.", true);
      }
      if (!(await switchRole(ctx, "lead"))) return toolResult("Lead activation failed; the run was stopped.", true);

      state.escalations += 1;
      return toolResult(LEAD_WAKE, false, { target: "lead" });
    },
  });

  pi.registerCommand("turn", {
    description: "Its My Turn: /turn on [worker-model], /turn off, /turn status",
    handler: async (args, ctx) => {
      if (!isMain(ctx)) {
        ctx.ui.notify("Its My Turn only controls the main session.", "warning");
        return;
      }

      const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);

      if (action === "status") {
        ctx.ui.notify(statusText(), "info");
        return;
      }

      if (action === "on") {
        await ctx.waitForIdle();
        if (state.enabled) {
          ctx.ui.notify(statusText(), "info");
          return;
        }

        const lead = currentModel(ctx);
        const workerSpec = rest.join(" ") || "@smol";
        const worker = ctx.models.resolve(workerSpec);
        if (!lead) {
          ctx.ui.notify("Its My Turn could not identify the current lead model.", "error");
          return;
        }
        if (!worker) {
          ctx.ui.notify(`Could not resolve worker model '${workerSpec}'. Configure @smol or use /turn on provider/model.`, "error");
          return;
        }
        if (modelKey(lead) === modelKey(worker)) {
          ctx.ui.notify("Lead and worker must be different models.", "error");
          return;
        }

        state.enabled = true;
        state.role = "lead";
        state.lead = lead;
        state.worker = worker;
        state.escalations = 0;
        state.handoffs = 0;
        await addContext(`${PROTOCOL}\n\nActive pair: lead=${modelKey(lead)}, worker=${modelKey(worker)}.`, false);
        ctx.ui.notify(`Its My Turn enabled: lead=${modelKey(lead)}, worker=${modelKey(worker)}. Give the lead a task.`, "info");
        return;
      }

      if (action === "off") {
        await ctx.waitForIdle();
        if (!state.enabled) {
          ctx.ui.notify("Its My Turn is already off.", "info");
          return;
        }

        try {
          await pi.setModel(state.lead);
          const actual = currentModel(ctx);
          if (actual && modelKey(actual) !== modelKey(state.lead)) {
            throw new Error(`active model is ${modelKey(actual)}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Could not restore the lead model: ${message}. Its My Turn remains on.`, "error");
          return;
        }

        reset();
        await addContext(DISABLED, false);
        ctx.ui.notify("Its My Turn disabled; lead model restored.", "info");
        return;
      }

      ctx.ui.notify("Usage: /turn on [worker-model], /turn off, /turn status", "warning");
    },
  });
}
