import { describe, expect, it } from "bun:test";
import itsMyTurn from "../index.js";

function schema() {
  const value = {
    describe() {
      return value;
    },
  };
  return value;
}

function createHarness({ failNextSwitch = false } = {}) {
  const lead = { provider: "mock", id: "lead" };
  const worker = { provider: "mock", id: "worker" };
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const sent = [];
  const notifications = [];
  const switches = [];

  const ctx = {
    agent: { kind: "main" },
    model: lead,
    models: {
      current: () => ctx.model,
      resolve: (spec) => (spec === "@smol" || spec === "mock/worker" ? worker : spec === "mock/lead" ? lead : undefined),
    },
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
    },
    waitForIdle: async () => {},
    abort: () => {
      ctx.aborted = true;
    },
  };

  const pi = {
    zod: {
      object: () => schema(),
      string: () => schema(),
    },
    setLabel() {},
    on: (name, handler) => handlers.set(name, handler),
    registerTool: (definition) => tools.set(definition.name, definition),
    registerCommand: (name, definition) => commands.set(name, definition),
    sendMessage: async (message, options) => sent.push({ message, options }),
    setModel: async (model) => {
      if (failNextSwitch) {
        failNextSwitch = false;
        throw new Error("mock switch failure");
      }
      ctx.model = model;
      switches.push(`${model.provider}/${model.id}`);
    },
  };

  itsMyTurn(pi);

  return {
    ctx,
    handlers,
    tools,
    commands,
    sent,
    notifications,
    switches,
    enable: () => commands.get("turn").handler("on", ctx),
    endTurn: () => handlers.get("agent_end")({}, ctx),
    execute: (instructions = "Implement the plan and run the acceptance checks.") =>
      tools.get("turn_execute").execute("call", { instructions }, undefined, undefined, ctx),
    ask: () =>
      tools.get("turn_ask").execute(
        "call",
        { question: "Which behavior is correct?", observed: "The result contradicts the plan.", tried: "none" },
        undefined,
        undefined,
        ctx,
      ),
  };
}

describe("Its My Turn shared-context state machine", () => {
  it("runs plan → execute → ask → decide → execute → rearm without a subagent or extra wake turn", async () => {
    const h = createHarness();
    await h.enable();

    expect(h.ctx.model.id).toBe("lead");
    expect(h.switches).toEqual([]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].options.triggerTurn).toBe(false);

    const handoff = await h.execute();
    expect(handoff.isError).toBeUndefined();
    expect(handoff.content[0].text).toContain('role="worker"');
    expect(h.ctx.model.id).toBe("worker");

    const question = await h.ask();
    expect(question.isError).toBeUndefined();
    expect(question.content[0].text).toContain('role="lead"');
    expect(h.ctx.model.id).toBe("lead");

    await h.execute("Use the observed behavior and rerun the checks.");
    expect(h.ctx.model.id).toBe("worker");

    await h.endTurn();
    expect(h.ctx.model.id).toBe("lead");
    expect(h.switches).toEqual(["mock/worker", "mock/lead", "mock/worker", "mock/lead"]);
    expect(h.sent).toHaveLength(2);
    expect(h.sent.every((entry) => entry.options.triggerTurn === false)).toBe(true);

    await h.commands.get("turn").handler("status", h.ctx);
    expect(h.notifications.at(-1).message).toContain("handoffs=4");
    expect(h.notifications.at(-1).message).toContain("escalations=1");
  });

  it("rejects role violations without switching models", async () => {
    const h = createHarness();
    await h.enable();

    const result = await h.ask();
    expect(result.isError).toBe(true);
    await h.endTurn();
    expect(h.ctx.model.id).toBe("lead");
    expect(h.switches).toEqual([]);

    const empty = await h.execute("   ");
    expect(empty.isError).toBe(true);
    expect(h.switches).toEqual([]);
  });

  it("off restores the lead and disables further automatic transitions", async () => {
    const h = createHarness();
    await h.enable();
    await h.execute();
    expect(h.ctx.model.id).toBe("worker");

    await h.commands.get("turn").handler("off", h.ctx);
    expect(h.ctx.model.id).toBe("lead");
    await h.endTurn();
    expect(h.switches).toEqual(["mock/worker", "mock/lead"]);

    const result = await h.ask();
    expect(result.isError).toBe(true);
  });

  it("stops instead of letting the wrong role continue after a switch failure", async () => {
    const h = createHarness({ failNextSwitch: true });
    await h.enable();

    const result = await h.execute();
    expect(result.isError).toBe(true);
    expect(h.ctx.aborted).toBe(true);
    expect(h.ctx.model.id).toBe("lead");
    expect(h.switches).toEqual([]);

    await h.commands.get("turn").handler("status", h.ctx);
    expect(h.notifications.at(-1).message).toBe("Its My Turn is off.");
  });

  it("requires two distinct resolvable models", async () => {
    const h = createHarness();
    await h.commands.get("turn").handler("on mock/lead", h.ctx);
    expect(h.notifications.at(-1).message).toBe("Lead and worker must be different models.");
    expect(h.sent).toHaveLength(0);

    await h.commands.get("turn").handler("on missing/model", h.ctx);
    expect(h.notifications.at(-1).message).toContain("Could not resolve worker model");
    expect(h.sent).toHaveLength(0);
  });
});
