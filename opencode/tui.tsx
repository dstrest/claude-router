/** @jsxImportSource @opentui/solid */
import { Plugin } from '@opencode/plugin/tui';
import type { BoxRenderable } from '@opentui/core';
import { createEffect, createSignal, For, Show } from 'solid-js';
import { shortReason } from '../lib/display.mjs';
import { formatModelRef } from './config.mjs';
import { RouterRpc } from './rpc.ts';
import { fit, switchNotice } from './status.mjs';
import { usageLines } from './usage.mjs';

const tiers = ['micro', 'low', 'medium', 'high'];
const percent = (value: unknown) => (typeof value === 'number' ? `${Math.round(value * 100)}%` : '—');
// RPC failures reject with plain { type, message } objects, not Error instances.
const errorMessage = (error: unknown) => (error as { message?: string } | null)?.message ?? String(error);

type ModelRef = { providerID: string; id: string; variant?: string };
type Decision = { origin: string; tier: string | null; activity: string | null; model: string; reason: string };
type RouterState = {
  sessionID: string;
  sequence: number;
  switches: number;
  mode: string;
  phase: string;
  classifier: { id: string; label: string };
  classifiers: { id: string; label: string }[];
  routingMode: string;
  projectError: string | null;
  canUndo: boolean;
  activeModel: ModelRef | null;
  nextModel: ModelRef | null;
  tier: string | null;
  tierConfidence: number | null;
  tierProbability: number | null;
  activity: string | null;
  activityChoice: string | null;
  activityProbability: number | null;
  reason: string | null;
  error: string | null;
  pendingPin: string | null;
  activityRouting: string;
  routes: Record<string, string>;
  activityRoutes: Record<string, Record<string, string>>;
  decisions: Decision[];
};

export default Plugin.define({
  id: 'router.tui',
  setup(context) {
    const router = context.client.rpc(RouterRpc);
    const requestOptions = { location: context.location ?? context.data.location.default() };
    const [states, setStates] = createSignal<Record<string, RouterState>>({});
    const [loadErrors, setLoadErrors] = createSignal<Record<string, string | undefined>>({});
    const [decisionRows, setDecisionRows] = createSignal(8);
    const [usage, setUsage] = createSignal<Record<string, string[]>>({});
    const [period, setPeriod] = createSignal('session');
    const loadUsage = async (sessionID: string) => {
      const report = await router.usage({ sessionID, period: period() }, requestOptions);
      setUsage((current) => ({ ...current, [sessionID]: usageLines(report) }));
    };
    const update = (result: unknown) => {
      const state = result as RouterState;
      const notice = switchNotice(states()[state.sessionID], state);
      const route = context.ui.router.current();
      if (notice && route.type === 'session' && route.sessionID === state.sessionID)
        context.ui.toast.show({ title: 'Router', message: notice, variant: 'info' });
      setStates((current) => {
        if ((current[state.sessionID]?.sequence ?? -1) > state.sequence) return current;
        return { ...current, [state.sessionID]: state };
      });
    };
    const stop = router.events.on('changed', (event) => {
      if (event.location.directory === requestOptions.location.directory) update(event.data.state);
    });
    const load = async (sessionID: string) => {
      try {
        update(await router.snapshot({ sessionID }, requestOptions));
        setLoadErrors((current) => ({ ...current, [sessionID]: undefined }));
      } catch (error) {
        setLoadErrors((current) => ({ ...current, [sessionID]: errorMessage(error) }));
      }
    };

    function Status(props: { sessionID: string }) {
      createEffect(() => void load(props.sessionID));
      const [width, setWidth] = createSignal(0);
      const line = () => {
        const state = states()[props.sessionID];
        return state ? fit(state, width()) : '';
      };
      return (
        <Show when={line()}>
          <box
            flexShrink={0}
            minWidth={0}
            onSizeChange={function (this: BoxRenderable) {
              const measured = this.width;
              queueMicrotask(() => setWidth(measured));
            }}
          >
            <text fg={context.theme.text.muted} wrapMode="none" truncate>
              {line()}
            </text>
          </box>
        </Show>
      );
    }

    function Panel(props: { sessionID: string }) {
      createEffect(() => void load(props.sessionID));
      createEffect(() => void loadUsage(props.sessionID).catch(() => {}));
      const state = () => states()[props.sessionID];
      return (
        <Show when={state()} fallback={<text>{loadErrors()[props.sessionID] ?? 'Loading router…'}</text>}>
          {(value) => (
            <box flexDirection="column">
              <text>{`Classifier: ${value().classifier.label} · confidence ${percent(value().tierConfidence)}`}</text>
              <text>{`Tier: ${value().tier ?? '—'} (${percent(value().tierProbability)}) · activity: ${value().activityChoice ?? '—'} (${percent(value().activityProbability)}) · applied: ${value().activity ?? 'base route'}`}</text>
              <text>{`Active: ${formatModelRef(value().activeModel)}`}</text>
              <text>{`Next: ${formatModelRef(value().nextModel)}`}</text>
              <text>{`Why: ${shortReason(value().reason, value().activity) || '—'}${value().error ? ` · ${value().error}` : ''}`}</text>
              <text>{`Pin: ${value().pendingPin ?? 'none'} · activity routing: ${value().activityRouting}`}</text>
              <text>{`Mode: ${value().routingMode}${value().projectError ? ` · ${value().projectError}` : ''}`}</text>
              <text>Routes</text>
              <For each={tiers}>
                {(tier) => <text>{`  ${tier}: ${value().routes[tier] ?? 'active model (no override)'}`}</text>}
              </For>
              <Show when={Object.keys(value().activityRoutes).length}>
                <text>Activity overrides</text>
                <For each={Object.entries(value().activityRoutes)}>
                  {([activity, routes]) => (
                    <text>{`  ${activity}: ${Object.entries(routes)
                      .map(([tier, ref]) => `${tier}=${ref}`)
                      .join(' · ')}`}</text>
                  )}
                </For>
              </Show>
              <For each={usage()[props.sessionID] ?? []}>{(line) => <text>{line}</text>}</For>
              <text>Recent decisions</text>
              <Show when={value().decisions.length} fallback={<text> No decisions yet</text>}>
                <For each={value().decisions.slice(0, decisionRows())}>
                  {(decision) => (
                    <text>{`  ${decision.origin} · ${decision.tier ?? '—'} · ${decision.activity ?? 'base'} · ${decision.model} · ${shortReason(decision.reason, decision.activity)}`}</text>
                  )}
                </For>
              </Show>
              <text>
                Commands: /router auto|off · /router pin &lt;tier&gt; · /router unpin · /router model &lt;tier&gt; ·
                /router activity on|off · /router mode &lt;mode&gt; · /router classifier · /router timeout &lt;ms&gt; ·
                /router reset · /router undo · /router decisions [n] · /router usage [period] · /router history delete
              </text>
            </box>
          )}
        </Show>
      );
    }

    const status = context.ui.slot({
      append: 'session.composer.top',
      render: (input) => <Status sessionID={input.sessionID} />,
    });

    const panel = context.ui.slot({
      append: 'session.panel',
      render: (input) => (
        <Show when={input.name === 'router'}>
          <Panel sessionID={input.sessionID} />
        </Show>
      ),
    });

    const run = async (sessionID: string, input: string) => {
      const [command, ...args] = input.trim().split(/\s+/);
      if (!command) {
        await context.ui.panel.open('router');
        return;
      }
      if (command === 'auto' || command === 'off') {
        update(await router.mode({ sessionID, mode: command === 'auto' ? 'auto' : 'manual' }, requestOptions));
      } else if (command === 'pin') {
        update(await router.pin({ sessionID, tier: args[0] }, requestOptions));
      } else if (command === 'unpin') {
        update(await router.pin({ sessionID, tier: null }, requestOptions));
      } else if (command === 'activity') {
        update(await router.activity({ sessionID, mode: args[0] }, requestOptions));
      } else if (command === 'route') {
        update(await router.route({ sessionID, tier: args[0], model: args[1] }, requestOptions));
      } else if (command === 'model') {
        const tier = args[0] ?? 'medium';
        const available = (await router.models({}, requestOptions)) as { models: { ref: string; name: string }[] };
        const selected = await context.ui.dialog.select({
          title: `Select any model for ${tier}`,
          options: available.models.map((model) => ({ title: model.name, description: model.ref, value: model.ref })),
          current: states()[sessionID]?.routes[tier],
        });
        if (selected) update(await router.route({ sessionID, tier, model: selected }, requestOptions));
      } else if (command === 'mode') {
        update(await router.routingMode({ sessionID, mode: args[0] ?? 'default' }, requestOptions));
      } else if (command === 'classifier') {
        const options = states()[sessionID]?.classifiers ?? [];
        const id =
          args[0] ??
          (await context.ui.dialog.select({
            title: 'Select a classifier',
            options: options.map((entry) => ({ title: entry.label, description: entry.id, value: entry.id })),
            current: states()[sessionID]?.classifier.id,
          }));
        if (id) update(await router.classifier({ sessionID, id }, requestOptions));
      } else if (command === 'timeout') {
        update(await router.timeout({ sessionID, timeoutMs: Number(args[0]) }, requestOptions));
      } else if (command === 'usage') {
        setPeriod(args[0] ?? 'session');
        await loadUsage(sessionID);
        await context.ui.panel.open('router');
        return;
      } else if (command === 'history' && args[0] === 'delete') {
        await router.deleteHistory({ sessionID }, requestOptions);
        await loadUsage(sessionID);
      } else if (command === 'reset') {
        update(await router.reset({ sessionID }, requestOptions));
      } else if (command === 'undo') {
        update(await router.undo({ sessionID }, requestOptions));
      } else if (command === 'decisions') {
        if (args[0]) setDecisionRows(Math.max(1, Number.parseInt(args[0], 10) || 8));
        await context.ui.panel.open('router');
        return;
      } else {
        throw new Error(
          'usage: /router [auto|off|pin <tier>|unpin|model <tier>|route <tier> <model>|activity on|off|mode <mode>|classifier [id]|timeout <ms>|reset|undo|decisions [n]|usage [period]|history delete]',
        );
      }
      context.ui.toast.show({ title: 'Router', message: 'Router state updated', variant: 'success' });
    };

    context.keymap.layer(() => ({
      mode: 'global',
      priority: 10,
      commands: [
        {
          id: 'router.open',
          title: 'Model router',
          group: 'Router',
          palette: true,
          slash: { name: 'router', arguments: true },
          run: async (input) => {
            const route = context.ui.router.current();
            const sessionID = route.type === 'session' ? route.sessionID : undefined;
            if (!sessionID) {
              context.ui.toast.show({
                title: 'Router',
                message: 'Open a session before using /router',
                variant: 'error',
              });
              return;
            }
            try {
              await run(sessionID, input ?? '');
            } catch (error) {
              context.ui.toast.show({
                title: 'Router',
                message: errorMessage(error),
                variant: 'error',
              });
            }
          },
        },
      ],
      bindings: ['router.open'],
    }));

    // The open panel holds keyboard focus and the host binds no close key.
    context.keymap.layer(() => ({
      mode: 'global',
      priority: 20,
      enabled: () => context.ui.panel.current()?.name === 'router',
      commands: [{ title: 'Close router panel', bind: 'escape', run: () => context.ui.panel.close() }],
    }));

    return () => {
      stop();
      status();
      panel();
    };
  },
});
