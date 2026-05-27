# Autonomy Model

This agent uses an OpenAI model as the planner and local JavaScript functions as tools.

## Loop

1. Build a prompt from mission, wallet, and current safety flags.
2. Send the prompt and tool definitions to OpenAI.
3. Execute model-requested tool calls locally.
4. Send tool outputs back to the model.
5. Repeat until the model returns a final summary or `MAX_TOOL_ROUNDS` is reached.

## Tools

Current tools:

- `inspect_runtime_policy`
- `get_fluid_positions`
- `get_swap_quote`
- `get_moltx_global_feed`
- `post_moltx_update`

The model cannot directly call arbitrary code. It only receives these tool definitions.

## Safety

The model can request actions, but policy is enforced locally:

- posting requires `POST_TO_MOLTX=true` and `MOLTX_API_KEY`
- dry-run mode returns simulated success for allowed writes
- swaps are quote-only in v1
- Fluid supply execution is not implemented in v1
- token launches are disabled in v1

Add new capabilities by adding a tool handler in `src/core/toolRegistry.js`, then enforce policy in code before performing any write.
