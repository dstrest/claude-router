import { Rpc } from '@opencode/plugin/rpc';

const session = { type: 'string' } as const;
const state = { type: 'object', additionalProperties: true } as const;
const tiers = ['micro', 'low', 'medium', 'high'] as const;
const errors = { rejected: { type: 'null' } } as const;
const sessionInput = (properties: Record<string, unknown>, required: string[] = []) =>
  ({
    type: 'object',
    properties: { sessionID: session, ...properties },
    required: ['sessionID', ...required],
    additionalProperties: false,
  }) as const;

export const RouterRpc = Rpc.define({
  id: 'router',
  methods: {
    snapshot: { input: sessionInput({}), output: state, errors },
    models: {
      input: { type: 'object', additionalProperties: false },
      output: {
        type: 'object',
        properties: {
          models: {
            type: 'array',
            items: {
              type: 'object',
              properties: { ref: { type: 'string' }, name: { type: 'string' } },
              required: ['ref', 'name'],
              additionalProperties: false,
            },
          },
        },
        required: ['models'],
        additionalProperties: false,
      },
      errors,
    },
    mode: {
      input: sessionInput({ mode: { type: 'string', enum: ['auto', 'manual'] } }, ['mode']),
      output: state,
      errors,
    },
    pin: {
      input: sessionInput({ tier: { anyOf: [{ type: 'string', enum: tiers }, { type: 'null' }] } }, ['tier']),
      output: state,
      errors,
    },
    routingMode: {
      input: sessionInput({ mode: { type: 'string' } }, ['mode']),
      output: state,
      errors,
    },
    classifier: {
      input: sessionInput({ id: { type: 'string' } }, ['id']),
      output: state,
      errors,
    },
    timeout: {
      input: sessionInput({ timeoutMs: { type: 'number' } }, ['timeoutMs']),
      output: state,
      errors,
    },
    reset: { input: sessionInput({}), output: state, errors },
    usage: {
      input: sessionInput({ period: { type: 'string' } }, ['period']),
      output: state,
      errors,
    },
    deleteHistory: { input: sessionInput({}), output: state, errors },
    undo: {
      input: sessionInput({}),
      output: state,
      errors,
    },
    route: {
      input: sessionInput({ tier: { type: 'string', enum: tiers }, model: { type: 'string' } }, ['tier', 'model']),
      output: state,
      errors,
    },
    activity: {
      input: sessionInput({ mode: { type: 'string', enum: ['on', 'off'] } }, ['mode']),
      output: state,
      errors,
    },
  },
  events: {
    changed: {
      schema: {
        type: 'object',
        properties: { sessionID: session, state },
        required: ['sessionID', 'state'],
        additionalProperties: false,
      },
    },
  },
});
