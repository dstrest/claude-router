import { hasImages } from '../lib/facts.mjs';
import { modelId } from './config.mjs';

const IMAGE_FILE = /^data:image\/|\.(?:png|jpe?g|gif|webp|bmp)(?:$|\?)/i;
const isImage = (file) =>
  String(file?.mime ?? '').startsWith('image/') || IMAGE_FILE.test(file?.uri ?? file?.name ?? '');
const imageBlocks = (files) => (files ?? []).filter(isImage).map(() => ({ type: 'image' }));

// shortcut: the host reports overflow as free text, so this matches known wording; extend it when a provider's differs.
const OVERFLOW = /context.{0,20}(?:length|window|limit)|too (?:long|large)|maximum.{0,20}(?:length|tokens)|overflow/i;

// The Claude tool names lib/facts.mjs reads. A tool not listed keeps its name, and counts as a read.
const TOOL_NAMES = { shell: 'Bash', edit: 'Edit', write: 'Write', patch: 'Edit', subagent: 'Agent' };
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

function toolUses(part) {
  const use = (input) => ({ type: 'tool_use', id: part.id, name: TOOL_NAMES[part.name] ?? part.name, input });
  // While a call streams, its input is still a partial string.
  const input = typeof part.state?.input === 'object' ? part.state.input : {};
  if (part.name === 'shell') return [use({ command: input.command, run_in_background: input.background === true })];
  if (part.name === 'edit' || part.name === 'write') return [use({ file_path: input.path })];
  // One patch can touch many files, and the docs-or-code rule reads every path.
  if (part.name === 'patch')
    return [...String(input.patchText ?? '').matchAll(PATCH_FILE)].map(([, path]) => use({ file_path: path }));
  return [use(input)];
}

function toolResult(part) {
  const { status, content = [], error, metadata = {} } = part.state ?? {};
  if (status !== 'completed' && status !== 'error') return null;
  // A failed command completes as a tool call and reports its exit in metadata, which `is_error` must carry.
  const failed =
    status === 'error' || (metadata.exit ?? 0) !== 0 || metadata.signal !== undefined || metadata.timeout === true;
  const blocks = content.flatMap((item) => {
    if (item.type === 'text') return [item];
    return item.type === 'file' && isImage(item) ? [{ type: 'image' }] : [];
  });
  if (error?.message) blocks.push({ type: 'text', text: error.message });
  return { type: 'tool_result', tool_use_id: part.id, is_error: failed, content: blocks };
}

function assistantMessages(message) {
  const parts = message.content ?? [];
  const tools = parts.filter((part) => part?.type === 'tool');
  const results = tools.map(toolResult).filter(Boolean);
  const content = parts.flatMap((part) => {
    if (part?.type === 'text') return [part];
    return part?.type === 'tool' ? toolUses(part) : [];
  });
  return [{ role: 'assistant', content }, ...(results.length ? [{ role: 'user', content: results }] : [])];
}

// Stored session messages as the Anthropic-shaped turns lib/facts.mjs reads.
export function routerMessages(messages) {
  return messages.flatMap((message) => {
    if (message?.type === 'user')
      return [
        {
          role: 'user',
          content: [{ type: 'text', text: message.text ?? '' }, ...imageBlocks(message.files)],
        },
      ];
    return message?.type === 'assistant' ? assistantMessages(message) : [];
  });
}

export const promptHasImages = (files) => hasImages([{ content: imageBlocks(files) }]);

// `tokens.input` excludes cached tokens: the host's own total adds the three.
export const usageOf = (message) => ({
  model: modelId(message.model),
  input_tokens: message.tokens.input,
  cache_read_input_tokens: message.tokens.cache.read,
  cache_creation_input_tokens: message.tokens.cache.write,
  output_tokens: message.tokens.output + (message.tokens.reasoning ?? 0),
});

export const stopReasonOf = (message) =>
  OVERFLOW.test(message.error?.message ?? '') ? 'model_context_window_exceeded' : (message.finish ?? null);
