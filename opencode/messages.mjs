import { hasImages } from '../lib/facts.mjs';
import { modelId } from './config.mjs';

const IMAGE_FILE = /^data:image\/|\.(?:png|jpe?g|gif|webp|bmp)(?:$|\?)/i;
const isImage = (file) =>
  String(file?.mime ?? '').startsWith('image/') || IMAGE_FILE.test(file?.uri ?? file?.name ?? '');
const imageBlocks = (files) => (files ?? []).filter(isImage).map(() => ({ type: 'image' }));

// shortcut: the host reports overflow as free text, so this matches known wording; extend it when a provider's differs.
const OVERFLOW = /context.{0,20}(?:length|window|limit)|too (?:long|large)|maximum.{0,20}(?:length|tokens)|overflow/i;

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
    if (message?.type === 'assistant')
      return [{ role: 'assistant', content: (message.content ?? []).filter((part) => part?.type === 'text') }];
    return [];
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
