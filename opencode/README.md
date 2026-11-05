# OpenCode router (local preview)

This is an additive OpenCode V2 adapter. The existing Claude Code plugin remains unchanged; OpenCode loads `server.ts`, `tui.tsx`, and `rpc.ts` from this directory while sharing the classifier implementations in `lib/`.

## Features in this preview

- Routes each admitted prompt through the selected classifier (Ollama, Jev, Clef, Clef Flash, Clef Omni, or OpenAI).
- Uses full OpenCode `provider/model#variant` references. Any enabled provider and model is selectable, including OpenRouter's `openrouter/moonshotai/kimi-k3.1-pro`.
- Provides a `/router` session panel with the classifier, confidence, tier and activity probabilities, active and next models, routing reason, configured routes, activity overrides, and recent decisions.
- Supports automatic/manual routing, one-prompt tier pins, activity routing on/off, and selection from every enabled model and variant.
- Moves between tiers with the shared policy in `lib/policy.mjs`: an upgrade or downgrade needs repeated votes and enough probability mass, a confident two-tier jump needs one vote, and a same-task downgrade also waits out the dwell.
- Re-reviews a running turn every four provider requests and applies a changed route to a subsequent provider turn.
- Fails open: classifier and model errors retain the active model and appear in the `/router` panel.

Failure escalation, context-fit checks, cost gates, checkpoint detection, usage accounting, and route-file editing from the Claude adapter are not yet ported. Switches are treated as free because OpenCode routes carry no prices yet. Route changes made through `/router route` or `/router model` are in-memory for this preview, not persisted to `router.json`.

## Install

OpenCode's `plugin add` accepts only npm and Git packages, and this adapter is not published. Install it from a local checkout instead, which makes it available in every project on this machine:

```sh
git clone https://github.com/alexei-led/claude-router
cd claude-router
npm run setup
npm ci --prefix opencode --ignore-scripts
```

Copy `opencode/opencode.example.jsonc` to `~/.config/opencode/opencode.jsonc`, set `package` to the absolute path of this `opencode/` directory, and run `opencode service restart`. If that file already exists, merge the `model`, `agents`, and `plugins` keys into it.

Open a session in any directory and run `/router` to confirm it loaded; `opencode plugin list` does not show this kind of install. The plugin runs from the checkout, so changes there apply after the next service restart. To uninstall, remove the plugin entry.

## Configure

`opencode/opencode.example.jsonc` is a working example, and every model in it comes from OpenRouter:

| Work | Model |
| --- | --- |
| Planning (`plan` agent, or the `plan` activity at any tier) | Claude Opus 5.5 `#high` |
| `micro` and `low` tiers | Claude Haiku 5.5 `#high` |
| `medium` tier, the `code` activity at `micro` and `low`, and new sessions | DeepSeek V4.1 Flash 1017 |
| `high` tier | Claude Opus 5.5 `#medium` |
| Web search (`web` subagent) | Kimi K3 |

Agents listed in `fixedAgents` keep their configured model: the router does not classify or switch them. Web search is denied on every other agent, so it has to go through `web`.

Use any model reference available in OpenCode. Omit `#variant` for the model default. A tier without a configured route keeps the active model. Activity overrides use the same `activities.<activity>.<tier>` structure as the example.

`classifier: "jev-openrouter"` runs Jev 1.14 through OpenRouter's System One endpoint, using OpenCode's stored OpenRouter connection, so it needs no key in config. Prompts and recent dialogue go to OpenRouter and TypeSafe.

The default Ollama timeout is 5 seconds. Increase `ollamaTimeoutMs` for a cold local model; the example allows 90 seconds.

Other classifiers use the existing shared adapters. Set `classifier` to `jev`, `clef`, `clef-flash`, `clef-omni`, or `openai`, and provide credentials through plugin options or the existing uppercase environment variables (`TYPESAFE_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, or `OPENAI_API_KEY`). Do not commit credentials.

## Controls

Commands:

- `/router` or `/router decisions`: open the details panel. Press Esc to close it and return to the composer.
- `/router auto` and `/router off`: enable or disable automatic routing.
- `/router pin <tier>` and `/router unpin`: pin one upcoming prompt to `micro`, `low`, `medium`, or `high`.
- `/router model <tier>`: select any enabled model and variant in a searchable dialog.
- `/router route <tier> <provider/model#variant>`: set a tier route directly.
- `/router activity on|off`: enable or disable activity overrides.

Subagents use the same controller when their initial prompt passes through OpenCode's prompt hook. Spawn-time routing parity with Claude Code has not been established yet.

## Verify

```sh
node --test test/opencode.test.mjs test/opencode-controller.test.mjs
npm run typecheck:opencode
npm run check
```

The local OpenCode 2.2.5 proof verified plugin activation, live RPC snapshots, 1,184 model/variant choices, and a real Ollama decision that switched OpenRouter Kimi from `#high` to `#low` for both provider turns.
