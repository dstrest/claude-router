import { Rpc } from '@opencode/plugin/rpc';

const session = { type: 'string' } as const;
const state = { type: 'object', additionalProperties: true } as const;
const tiers = ['micro', 'low', 'medium', 'high'] as const;
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
    snapshot: { input: sessionInput({}), output: state },
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
    },
    mode: {
      input: sessionInput({ mode: { type: 'string', enum: ['auto', 'manual'] } }, ['mode']),
      output: state,
    },
    pin: {
      input: sessionInput({ tier: { anyOf: [{ type: 'string', enum: tiers }, { type: 'null' }] } }, ['tier']),
      output: state,
    },
    route: {
      input: sessionInput({ tier: { type: 'string', enum: tiers }, model: { type: 'string' } }, ['tier', 'model']),
      output: state,
      errors: { invalid_route: { type: 'null' } },
    },
    activity: {
      input: sessionInput({ mode: { type: 'string', enum: ['on', 'off'] } }, ['mode']),
      output: state,
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
