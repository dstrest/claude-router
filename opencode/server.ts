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
    const rpc = await ctx.rpc.register(RouterRpc, {
      snapshot: ({ sessionID }) => controller.snapshot(sessionID),
      models: () => controller.models(),
      mode: ({ sessionID, mode }) => controller.setMode(sessionID, mode),
      pin: ({ sessionID, tier }, { error }) =>
        controller.setPin(sessionID, tier).catch((failure) => error('invalid_pin', failure.message, null)),
      route: ({ sessionID, tier, model }, { error }) =>
        controller.setRoute(sessionID, tier, model).catch((failure) => error('invalid_route', failure.message, null)),
      activity: ({ sessionID, mode }) => controller.setActivity(sessionID, mode),
      routingMode: ({ sessionID, mode }, { error }) =>
        controller.setRoutingMode(sessionID, mode).catch((failure) => error('invalid_setting', failure.message, null)),
      classifier: ({ sessionID, id }, { error }) =>
        controller.setClassifier(sessionID, id).catch((failure) => error('invalid_setting', failure.message, null)),
      timeout: ({ sessionID, timeoutMs }, { error }) =>
        controller.setTimeout(sessionID, timeoutMs).catch((failure) => error('invalid_setting', failure.message, null)),
      reset: ({ sessionID }) => controller.reset(sessionID),
      undo: ({ sessionID }, { error }) =>
        controller.undo(sessionID).catch((failure) => error('invalid_setting', failure.message, null)),
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
