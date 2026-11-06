import { Plugin } from '@opencode/plugin';
import { createController } from './controller.mjs';
import { RouterRpc } from './rpc.ts';

export default Plugin.define({
  id: 'router',
  async setup(ctx) {
    const controller = await createController(ctx, ctx.options);
    const rpc = await ctx.rpc.register(RouterRpc, {
      snapshot: ({ sessionID }) => controller.snapshot(sessionID),
      models: () => controller.models(),
      mode: ({ sessionID, mode }) => controller.setMode(sessionID, mode),
      pin: ({ sessionID, tier }) => controller.setPin(sessionID, tier),
      route: ({ sessionID, tier, model }, { error }) =>
        controller.setRoute(sessionID, tier, model).catch((failure) => error('invalid_route', failure.message, null)),
      activity: ({ sessionID, mode }) => controller.setActivity(sessionID, mode),
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
        types: ['session.idle', 'session.deleted'],
        signal: events.signal,
      })) {
        if (event.type === 'session.idle') await controller.idle(event.data.sessionID);
        else controller.remove(event.data.sessionID);
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
