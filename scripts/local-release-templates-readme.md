# memorax-code configuration templates

These templates match the defaults of the built release. Copy them into the
MemoraX Code home directory (`~/.memorax-code/` on macOS/Linux,
`C:\Users\<you>\.memorax-code\` on Windows) before first start, or let
`memorax-code setup` seed `config.toml` automatically.

## config.toml

Main configuration. The shipped default selects the fully offline local
memory provider (`[memory] provider = "local"`); no MemoraX account is
required. Memory scope falls back to the `local-user` identity when no
`user_id` is configured. Only set `[memory].provider = "memorax"` with
`[memorax]` credentials if you explicitly want the opt-in remote service.

## embedding.json

Optional vector-search configuration for the local provider. With the
defaults below, embeddings are computed by the Ark OpenAI-compatible
endpoint using the `ARKCODINGPLAN_API_KEY` environment variable; the
endpoint never stores memory content. Delete this file or set
`"enabled": false` to run fully offline with keyword search only.

## Verification

After installation:

```bash
memorax-code status
memorax-cli add --memory "Local mode works." --reason "smoke test"
memorax-cli search --query "local mode"
```
