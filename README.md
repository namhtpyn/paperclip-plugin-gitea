# paperclip-plugin-gitea

Gitea bridge for [Paperclip](https://paperclipai.com): mirrors Gitea activity into Paperclip issues and exposes a per-agent Gitea API tool.

## Features

- **Webhook ingestion** — declares a `gitea` webhook endpoint; the host exposes `POST /api/plugins/<pluginId>/webhooks/gitea`, records every delivery, and hands the worker the **raw body** for HMAC-SHA256 (`X-Gitea-Signature`) verification.
- **Issue/PR mirroring** — new Gitea issues and PRs become linked Paperclip issues (`originKind: plugin:paperclip.gitea`, `originId: owner/repo#N`); closes and merges mirror back as status changes and comments.
- **Comment mirroring** — Gitea comments on linked issues/PRs are mirrored into the Paperclip issue thread (bot-authored comments are skipped — no echo loops).
- **Push activity** — pushes land in the company activity log.
- **Per-agent `gitea_api` tool** — each paired agent calls the Gitea REST API as its own bot account; auth is handled by the plugin, tokens never reach the model.
- **Stored secrets** — webhook secret and per-agent tokens are `secret-ref` fields (Paperclip stored secrets); plaintext strings still work for local dev.

## Install

```bash
# in Paperclip: Plugins → Install from registry
packageName: paperclip-plugin-gitea
```

Requires a Paperclip host with plugin support (`2026.1001.0` or newer).

## Configuration

```jsonc
{
  "giteaUrl": "https://gitea.example.com",
  "webhookSecret": { "type": "secret_ref", "secretId": "<uuid>" }, // or plain string
  "mirrorComments": true,
  "endpoints": [
    {
      "agentId": "<paperclip agent uuid>",
      "giteaUsername": "my-agent-bot",
      "token": { "type": "secret_ref", "secretId": "<uuid>" } // or plain string
    }
  ]
}
```

Then register the webhook in Gitea (repo → Settings → Webhooks):

- **URL**: `https://<paperclip>/api/plugins/<pluginId>/webhooks/gitea`
- **Method**: POST, **Content type**: application/json
- **Secret**: the same value as `webhookSecret`
- **Events**: issues, issue comments, pull requests, pushes

Gitea bot accounts (user type `Bot`, Gitea 28+) are the intended pairing targets: token-only auth, no interactive login, no notifications.

## Gotchas

- The worker's `http.fetch` has a **30s ceiling** — long Gitea API calls (rare) will time out; retry rather than raise timeouts.
- Webhook signature verification uses the **raw body**; never re-serialize the parsed payload for verification.
- Issues created by the plugin are surfaced as normal issues with `originKind plugin:paperclip.gitea` — queryable via `ctx.issues.list({ originKind, originId })`.
- One Paperclip agent ↔ one Gitea bot account. The `gitea_api` tool resolves the calling agent's pairing at invocation time; unpaired agents get an explicit error, not a fallback.

## License

MIT
