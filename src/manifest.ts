export const PLUGIN_VERSION = "0.1.0";

const manifest = {
  id: "paperclip.gitea",
  name: "Gitea",
  version: PLUGIN_VERSION,
  description:
    "Bridge Gitea to Paperclip: mirror issues, PRs, comments and push events into linked Paperclip issues, and expose per-agent Gitea tools.",
  author: { name: "namhtpyn" },
  homepage: "https://github.com/namhtpyn/paperclip-plugin-gitea",
  capabilities: [
    "http.outbound",
    "webhooks.receive",
    "events.subscribe",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
    "secrets.read-ref",
    "agent.tools.register",
    "issues.read",
    "issues.write",
    "agents.read",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  webhooks: [
    {
      endpointKey: "gitea",
      displayName: "Gitea webhook",
      description: "Receives Gitea webhook events (issues, issue_comment, pull_request, push) for linked repositories.",
    },
  ],
  tools: [
    {
      name: "gitea_api",
      displayName: "Gitea API",
      description:
        "Call the Gitea REST API as this agent's linked bot account (auth handled by the plugin). Pass method, path (e.g. /repos/{owner}/{repo}/issues), and optional JSON body.",
      parametersSchema: {
        type: "object",
        required: ["method", "path"],
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PATCH", "PUT", "DELETE"], title: "HTTP method" },
          path: { type: "string", title: "API path", description: "e.g. /repos/owner/repo/issues or /user" },
          body: { type: "object", title: "JSON body", description: "Optional JSON request body" },
        },
      },
    },
  ],
  instanceConfigSchema: {
    type: "object",
    required: ["giteaUrl", "webhookSecret"],
    properties: {
      giteaUrl: {
        type: "string",
        title: "Gitea URL",
        description: "Base URL of the Gitea instance, e.g. https://gitea.example.com",
      },
      webhookSecret: {
        type: ["string", "object"],
        format: "secret-ref",
        title: "Webhook secret",
        description: "Shared secret used to verify X-Gitea-Signature HMAC-SHA256 on incoming webhooks. Pick a stored secret (recommended) or a plain string.",
      },
      mirrorComments: {
        type: "boolean",
        title: "Mirror Gitea comments into linked issues",
        default: true,
      },
      endpoints: {
        type: "array",
        title: "Agent pairings",
        description: "One entry per Paperclip agent: its Gitea bot account + token. Used for the gitea_api tool and for writing comments back to Gitea.",
        items: {
          type: "object",
          required: ["agentId", "giteaUsername"],
          properties: {
            agentId: { type: "string", title: "Paperclip agent UUID" },
            giteaUsername: { type: "string", title: "Gitea bot username", description: "e.g. my-agent-bot" },
            token: {
              type: ["string", "object"],
              format: "secret-ref",
              title: "Gitea API token",
              description: "Access token for this bot account. Pick a stored secret (recommended) — the token never lands in plugin config.",
            },
          },
        },
      },
    },
  },
};

export default manifest;
