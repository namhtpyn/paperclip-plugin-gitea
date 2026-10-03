import { definePlugin, runWorker, type PluginContext, type PluginWebhookInput, type EnvSecretRefBinding } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import { GiteaClient } from "./gitea-client.js";

/**
 * paperclip-plugin-gitea
 *
 * Mirrors Gitea activity into Paperclip and exposes a per-agent Gitea API tool.
 *
 * Linking model: a Paperclip issue created from a Gitea issue/PR carries
 * originKind `plugin:paperclip.gitea` and originId `<owner>/<repo>#<number>`.
 * The same mapping is kept in plugin state keyed by originId, so both
 * directions resolve. Webhook events look up the linked Paperclip issue and
 * mirror comments/status changes; the gitea_api tool lets each paired agent
 * call Gitea as its own bot account.
 */

interface EndpointConfig {
  agentId: string;
  giteaUsername: string;
  token?: string | EnvSecretRefBinding;
}

interface BridgeConfig {
  companyId: string;
  giteaUrl: string;
  webhookSecret: string;
  mirrorComments: boolean;
  endpoints: EndpointConfig[];
}

const ORIGIN_KIND = "plugin:paperclip.gitea" as const;
const STATE_NAMESPACE = "gitea";
const STATE_KEY = "links";

let pluginCtx: PluginContext | null = null;
let activeConfig: BridgeConfig | null = null;

/** agentId -> resolved GiteaClient (token resolved at config apply) */
const clientsByAgent = new Map<string, { client: GiteaClient; username: string }>();

function parseConfig(raw: unknown, companyId: string): BridgeConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const cfg = raw as Record<string, unknown>;
  const giteaUrl = typeof cfg.giteaUrl === "string" ? cfg.giteaUrl.replace(/\/+$/, "") : "";
  if (!giteaUrl) return null;
  const webhookSecret = typeof cfg.webhookSecret === "string" ? cfg.webhookSecret : "";
  const eps: EndpointConfig[] = [];
  if (Array.isArray(cfg.endpoints)) {
    for (const e of cfg.endpoints) {
      if (!e || typeof e !== "object") continue;
      const o = e as Record<string, unknown>;
      const agentId = typeof o.agentId === "string" ? o.agentId : "";
      const giteaUsername = typeof o.giteaUsername === "string" ? o.giteaUsername : "";
      if (!agentId || !giteaUsername) continue;
      let token: EndpointConfig["token"];
      const t = o.token;
      if (typeof t === "string" && t) token = t;
      else if (t && typeof t === "object") {
        const a = t as Record<string, unknown>;
        if (a.type === "secret_ref" && typeof a.secretId === "string" && a.secretId) {
          const version = a.version;
          token = { type: "secret_ref", secretId: a.secretId, ...(version !== undefined ? { version: version as number | "latest" } : {}) };
        }
      }
      eps.push({ agentId, giteaUsername, ...(token ? { token } : {}) });
    }
  }
  return {
    companyId,
    giteaUrl,
    webhookSecret,
    mirrorComments: cfg.mirrorComments !== false,
    endpoints: eps,
  };
}

async function resolveToken(ctx: PluginContext, companyId: string, token: EndpointConfig["token"], configPath: string): Promise<string | null> {
  if (!token) return null;
  if (typeof token === "string") return token;
  return ctx.secrets.resolve(token, { companyId, configPath });
}

async function applyConfig(ctx: PluginContext, config: BridgeConfig): Promise<void> {
  activeConfig = config;
  clientsByAgent.clear();
  for (const [i, ep] of config.endpoints.entries()) {
    if (!ep.token) {
      ctx.logger.warn("endpoint has no token; gitea_api tool unavailable for this agent", { agentId: ep.agentId, username: ep.giteaUsername });
      continue;
    }
    try {
      const token = await resolveToken(ctx, config.companyId, ep.token, `endpoints.${i}.token`);
      if (!token) throw new Error("token resolved to empty");
      clientsByAgent.set(ep.agentId, { client: new GiteaClient(config.giteaUrl, token, (u, init) => ctx.http.fetch(u, init)), username: ep.giteaUsername });
    } catch (err) {
      ctx.logger.error("token resolve failed for endpoint", { agentId: ep.agentId, configPath: `endpoints.${i}.token`, error: String(err) });
    }
  }
  ctx.logger.info("Gitea bridge config applied", { companyId: config.companyId, endpoints: config.endpoints.length, agentsWithTokens: clientsByAgent.size });
}

// ---------------------------------------------------------------------------
// link store (plugin state, company scope)
// ---------------------------------------------------------------------------

type LinkMap = Record<string, { issueId: string; kind: "issue" | "pr"; title: string }>;

async function loadLinks(ctx: PluginContext, companyId: string): Promise<LinkMap> {
  const stored = await ctx.state.get({ scopeKind: "company", scopeId: companyId, namespace: STATE_NAMESPACE, stateKey: STATE_KEY }).catch(() => null);
  return stored && typeof stored === "object" ? (stored as LinkMap) : {};
}

async function saveLink(ctx: PluginContext, companyId: string, originId: string, link: LinkMap[string]): Promise<void> {
  const links = await loadLinks(ctx, companyId);
  links[originId] = link;
  await ctx.state.set({ scopeKind: "company", scopeId: companyId, namespace: STATE_NAMESPACE, stateKey: STATE_KEY }, links);
}

// ---------------------------------------------------------------------------
// webhook handling
// ---------------------------------------------------------------------------

interface GiteaWebhookBody {
  action?: string;
  issue?: { number: number; title: string; body?: string; state?: string; user?: { login?: string }; html_url?: string; pull_request?: unknown };
  pull_request?: { number: number; title: string; body?: string; state?: string; merged?: boolean; user?: { login?: string }; html_url?: string; merged_by?: { login?: string } };
  comment?: { body: string; user?: { login?: string }; html_url?: string };
  repository?: { full_name?: string; html_url?: string };
  sender?: { login?: string };
  commits?: { id: string; message: string; url: string }[];
  ref?: string;
  before?: string;
  after?: string;
  [k: string]: unknown;
}

function originIdFor(repo: string, kind: "issue" | "pr", number: number): string {
  return `${repo}#${number}`;
}

async function findLinkedIssue(ctx: PluginContext, companyId: string, originId: string): Promise<string | null> {
  const links = await loadLinks(ctx, companyId);
  if (links[originId]) return links[originId].issueId;
  // fall back to issue lookup by origin (covers state loss)
  const found = await ctx.issues.list({ companyId, originKind: ORIGIN_KIND, originId, limit: 1 }).catch(() => []);
  if (found.length) {
    await saveLink(ctx, companyId, originId, { issueId: found[0].id, kind: originId.includes("#") ? "issue" : "issue", title: found[0].title });
    return found[0].id;
  }
  return null;
}

async function handleGiteaEvent(ctx: PluginContext, companyId: string, event: string, body: GiteaWebhookBody): Promise<void> {
  const repo = body.repository?.full_name ?? "";
  if (!repo) return;

  if (event === "issues") {
    const num = body.issue?.number;
    if (!num) return;
    const isPr = body.issue?.pull_request !== undefined;
    const originId = originIdFor(repo, isPr ? "pr" : "issue", num);
    const existing = await findLinkedIssue(ctx, companyId, originId);
    if (existing) {
      if (body.action === "closed") {
        await ctx.issues.update(existing, { status: "done" }, companyId).catch((e) => ctx.logger.error("close mirror failed", { originId, error: String(e) }));
        await ctx.activity.log({ companyId, message: `Gitea ${isPr ? "PR" : "issue"} ${originId} closed`, entityType: "issue", entityId: existing });
      }
      return;
    }
    // create a linked issue for new gitea issues/PRs
    if (body.action === "opened") {
      const created = await ctx.issues.create({
        companyId,
        title: `[${repo}] ${body.issue?.title ?? originId}`,
        description: [
          body.issue?.body ? String(body.issue.body).slice(0, 4000) : "",
          "",
          `— [${isPr ? "PR" : "issue"} ${originId}](${body.issue?.html_url ?? `${body.repository?.html_url ?? ""}/${isPr ? "pulls" : "issues"}/${num}`}) by @${body.issue?.user?.login ?? "unknown"}`,
        ].join("\n"),
        originKind: ORIGIN_KIND,
        originId,
        surfaceVisibility: "default",
      });
      await saveLink(ctx, companyId, originId, { issueId: created.id, kind: isPr ? "pr" : "issue", title: created.title });
      await ctx.activity.log({ companyId, message: `Gitea ${isPr ? "PR" : "issue"} ${originId} opened → linked`, entityType: "issue", entityId: created.id });
      return;
    }
    return;
  }

  if (event === "issue_comment") {
    if (!body.comment || !body.issue) return;
    const num = body.issue.number;
    const isPr = body.issue.pull_request !== undefined;
    const originId = originIdFor(repo, isPr ? "pr" : "issue", num);
    const issueId = await findLinkedIssue(ctx, companyId, originId);
    if (!issueId) return;
    if (!activeConfig?.mirrorComments) return;
    // skip our own bots' comments (no echo loop)
    const author = body.comment.user?.login ?? "";
    if (activeConfig.endpoints.some((e) => e.giteaUsername === author)) return;
    await ctx.issues.createComment(issueId, `**@${author}** on Gitea:\n\n${String(body.comment.body).slice(0, 2000)}`, companyId).catch((e) => ctx.logger.error("comment mirror failed", { originId, error: String(e) }));
    return;
  }

  if (event === "pull_request") {
    const num = body.pull_request?.number;
    if (!num) return;
    const originId = originIdFor(repo, "pr", num);
    const issueId = await findLinkedIssue(ctx, companyId, originId);
    if (!issueId) return;
    if (body.action === "closed" && body.pull_request?.merged) {
      await ctx.issues.createComment(issueId, `✅ PR ${originId} merged by @${body.pull_request?.merged_by?.login ?? "unknown"}`, companyId).catch(() => undefined);
      await ctx.activity.log({ companyId, message: `Gitea PR ${originId} merged`, entityType: "issue", entityId: issueId });
    }
    return;
  }

  if (event === "push") {
    const n = Array.isArray(body.commits) ? body.commits.length : 0;
    if (n === 0) return;
    await ctx.activity.log({
      companyId,
      message: `Gitea push to ${repo}: ${n} commit(s) by @${body.sender?.login ?? "unknown"} (${String(body.ref ?? "").replace("refs/heads/", "")})`,
    });
    return;
  }
}

// ---------------------------------------------------------------------------
// plugin definition
// ---------------------------------------------------------------------------

export const giteaPlugin = definePlugin({
  async setup(ctx: PluginContext) {
    pluginCtx = ctx;

    // per-agent gitea_api tool: runs as the paired bot account
    ctx.tools.register("gitea_api", {
      displayName: "Gitea API",
      description: "Call the Gitea REST API as this agent's paired bot account. method + path (e.g. /repos/{owner}/{repo}/issues), optional body.",
      parametersSchema: {
        type: "object",
        required: ["method", "path"],
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
          path: { type: "string", description: "API path under /api/v1" },
          body: { type: "object" },
        },
      },
    }, async (params, runCtx) => {
      const cfg = activeConfig;
      if (!cfg) return { ok: false, error: "plugin not configured" };
      const entry = clientsByAgent.get(runCtx.agentId);
      if (!entry) return { ok: false, error: "no gitea pairing for this agent (check plugin config endpoints[])" };
      const p = params as { method: string; path: string; body?: unknown };
      try {
        const result = await entry.client.call(p.method, p.path, p.body);
        return { ok: true, as: entry.username, result };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });

    ctx.logger.info("Gitea plugin registered", { version: manifest.version, tools: ["gitea_api"] });
  },

  async onConfigChanged(newConfig: Record<string, unknown>, context?: { companyId?: string | null }) {
    const ctx = pluginCtx;
    if (!ctx) return;
    const companyId = context?.companyId ?? null;
    if (!companyId) {
      ctx.logger.info("config saved without company scope; ignoring");
      return;
    }
    const parsed = parseConfig(newConfig, companyId);
    if (!parsed) {
      ctx.logger.info("config incomplete; gitea bridge idle", { companyId });
      activeConfig = null;
      clientsByAgent.clear();
      return;
    }
    await applyConfig(ctx, parsed);
  },

  async onWebhook(input: PluginWebhookInput) {
    const ctx = pluginCtx;
    if (!ctx) throw new Error("worker not initialized");
    const cfg = activeConfig;
    if (!cfg) throw new Error("plugin not configured");

    // 1. verify HMAC-SHA256 signature
    const sigHeader = headerValue(input.headers, "x-gitea-signature");
    if (!cfg.webhookSecret) throw new Error("webhook secret not configured");
    if (!GiteaClient.verifySignature(input.rawBody, sigHeader, cfg.webhookSecret)) {
      throw new Error("invalid webhook signature");
    }

    // 2. dispatch by event type
    const event = headerValue(input.headers, "x-gitea-event");
    if (!event) return;
    const body = (input.parsedBody ?? {}) as GiteaWebhookBody;
    await handleGiteaEvent(ctx, cfg.companyId, event, body);
  },

  async onHealth() {
    const cfg = activeConfig;
    return {
      status: cfg ? "ok" : "degraded",
      message: cfg
        ? `Gitea bridge v${manifest.version}: ${cfg.endpoints.length} pairing(s), ${clientsByAgent.size} with tokens`
        : `Gitea bridge v${manifest.version} idle (no config)`,
    };
  },
});

function headerValue(headers: Record<string, string | string[]>, name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()] ?? Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
  return Array.isArray(v) ? v[0] : v;
}

export default giteaPlugin;
runWorker(giteaPlugin, import.meta.url);
