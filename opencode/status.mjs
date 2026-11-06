import { shortReason } from '../lib/display.mjs';
import { sameModel, variantOf } from './config.mjs';

// The /router panel has the full ref, so the line drops provider and vendor to leave room for the rest.
const shortName = (ref) => [ref.id.split('/').at(-1), variantOf(ref)].filter(Boolean).join('#');
const joined = (...parts) => parts.filter(Boolean).join(' · ');

export function fit(state, width) {
  const { activeModel: active, nextModel: next, tier, activity } = state;
  const target = next ?? active;
  if (!target) return '';
  const moves = active && !sameModel(active, target);
  const route = [tier, activity].filter(Boolean).join('/');
  const reason = state.phase === 'choosing' ? 'choosing…' : shortReason(state.reason, activity);
  const models = moves ? `${shortName(active)} → ${shortName(target)}` : shortName(target);
  const candidates = [
    joined(models, route, reason),
    joined(models, route),
    joined(`${moves ? '→ ' : ''}${shortName(target)}`, route),
  ];
  // shortcut: length assumes one column per character, true for model ids and this line's glyphs; truncate is the backstop.
  return candidates.find((candidate) => candidate.length <= width) ?? candidates.at(-1);
}

// Matches Claude's switch toast: a pin or a change of effort alone raises none.
export function switchNotice(previous, state) {
  if (!previous || state.switches <= previous.switches || state.reason === 'pinned') return null;
  const { activeModel: from, nextModel: to } = state;
  if (from?.providerID === to?.providerID && from?.id === to?.id) return null;
  return `Model changed: ${shortName(from)} → ${shortName(to)} · ${shortReason(state.reason, state.activity)}`;
}
