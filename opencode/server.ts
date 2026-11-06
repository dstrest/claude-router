import { Plugin } from '@opencode/plugin';
import { createController } from './controller.mjs';
import { RouterRpc } from './rpc.ts';

// The durable events that end a turn. `session.idle` is deprecated, and the host no longer publishes it.
const TURN_ENDED = [
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
] as const;
const HISTORY_REPLACED = ['session.compaction.ended', 'session.revert.committed'] as const;

export default Plugin.define({
  id: 'router',
  async setup(ctx) {
    const controller = await createController(ctx, ctx.options);
    // A method's failure reaches the user as its message; undeclared, it reads only `RPC call failed`.
    const guarded =
      <Input, Output, Failure>(method: (input: Input) => Promise<Output>) =>
      (input: Input, { error }: { error: (name: 'rejected', message: string, data: null) => Failure }) =>
        method(input).catch((failure) => error('rejected', failure.message, null));
    const rpc = await ctx.rpc.register(RouterRpc, {
      snapshot: guarded(({ sessionID }) => controller.snapshot(sessionID)),
      models: guarded(() => controller.models()),
      mode: guarded(({ sessionID, mode }) => controller.setMode(sessionID, mode)),
      pin: guarded(({ sessionID, tier }) => controller.setPin(sessionID, tier)),
      route: guarded(({ sessionID, tier, model }) => controller.setRoute(sessionID, tier, model)),
      activity: guarded(({ sessionID, mode }) => controller.setActivity(sessionID, mode)),
      routingMode: guarded(({ sessionID, mode }) => controller.setRoutingMode(sessionID, mode)),
      classifier: guarded(({ sessionID, id }) => controller.setClassifier(sessionID, id)),
      timeout: guarded(({ sessionID, timeoutMs }) => controller.setTimeout(sessionID, timeoutMs)),
      reset: guarded(({ sessionID }) => controller.reset(sessionID)),
      usage: guarded(({ sessionID, period }) => controller.usage(sessionID, period)),
      deleteHistory: guarded(({ sessionID }) => controller.deleteHistory(sessionID)),
      undo: guarded(({ sessionID }) => controller.undo(sessionID)),
    });
    controller.setPublisher(async (state) => {
      await rpc.events.emit('changed', { sessionID: state.sessionID, state });
    });

    await ctx.session.hook('prompt', (event) => controller.prompt(event));
    await ctx.session.hook('context', (event) => controller.context(event));
    await ctx.tool.hook('execute.before', (event) => controller.spawn(event));

    const events = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({
        types: [...TURN_ENDED, ...HISTORY_REPLACED, 'session.deleted'],
        signal: events.signal,
      })) {
        if (event.type === 'session.deleted') await controller.remove(event.data.sessionID);
        else if ((HISTORY_REPLACED as readonly string[]).includes(event.type))
          await controller.resetHistory(event.data.sessionID);
        else await controller.idle(event.data.sessionID);
      }
    })().catch((error) => {
      if (!events.signal.aborted) console.error('OpenCode router event stream failed', error);
    });

    return () => {
      events.abort();
      controller.close();
    };
  },
});
