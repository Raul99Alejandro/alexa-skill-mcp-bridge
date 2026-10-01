import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  createLogger,
  hashId,
  parseConfig,
  type AgentInvocation,
  type TurnInput,
} from '@alexa-mcp-bridge/core';
import { BridgeSession } from './session.js';
import { noopMemory } from './memory/store.js';
import { runTurn } from './turn.js';
import { ScriptedModel } from './testing/scripted-model.js';

/**
 * A server whose tools change mid-conversation, for example an app that unlocks new tools once
 * the user finishes a setup step. AgentCore keeps one warm container per user across Alexa sessions, so the agent
 * has to pick up tools/list_changed itself and must not carry one session's history into the next.
 */
const logger = createLogger({ service: 'test' }, { write: () => undefined });
let http: Server;
let url: string;
let mcp: McpServer;
let methods: string[];
let transport: StreamableHTTPServerTransport;
/** Fail the next tools/list with a 502, like a server in the middle of a redeploy. */
let failNextList = false;

beforeEach(async () => {
  methods = [];
  failNextList = false;
  mcp = new McpServer({ name: 'changing', version: '1.0.0' });
  mcp.registerTool('set_up', { description: 'Set up the business.' }, async () => ({
    content: [{ type: 'text', text: 'Set up. Open me again.' }],
  }));
  transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await mcp.connect(transport);
  http = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      // As the MCP spec says: a session id this server doesn't know gets 404 (start a new session).
      const sid = req.headers['mcp-session-id'];
      if (sid && sid !== transport.sessionId) {
        res.writeHead(404).end();
        return;
      }
      const parsed = body ? JSON.parse(body) : undefined;
      if (parsed?.method) methods.push(parsed.method);
      if (parsed?.method === 'tools/list' && failNextList) {
        failNextList = false;
        res.writeHead(502).end();
        return;
      }
      void transport.handleRequest(req, res, parsed);
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
});

afterEach(async () => {
  await mcp.close();
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

function harness() {
  const model = new ScriptedModel([]);
  const session = new BridgeSession({
    config: parseConfig({ mcp: { url } }),
    model,
    memory: noopMemory,
    logger,
  });
  const send = (text: string, sessionId = 's1') =>
    runTurn(session, {
      turn: { type: 'turn', utterance: { text } } satisfies TurnInput,
      actorId: hashId('u'),
      sessionId: hashId(sessionId),
      locale: 'en-US',
      budgetMs: 6500,
      debug: false,
    } satisfies AgentInvocation);
  return { session, model, send };
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const userTexts = (messages: { role: string; content: unknown[] }[]): string[] =>
  messages
    .filter((m) => m.role === 'user')
    .flatMap((m) => m.content)
    .map((b) => (b as { text?: string }).text ?? '')
    .filter(Boolean);

describe('tools that change mid-conversation', () => {
  it('offers the new tools on the next turn after tools/list_changed, keeping the conversation', async () => {
    const { session, model, send } = harness();
    await send('set up my flower shop');
    expect(model.toolNames.at(-1)).toContain('set_up');
    expect(model.toolNames.at(-1)).not.toContain('take_order');

    mcp.registerTool('take_order', { description: 'Take an order.' }, async () => ({
      content: [{ type: 'text', text: 'Order taken.' }],
    }));
    await waitFor(() => session.toolsChanged);

    await send('take an order for Maria');
    expect(model.toolNames.at(-1)).toContain('take_order');
    expect(userTexts(model.calls.at(-1) as never)).toContain('set up my flower shop');
    await session.close();
  });

  it('starts a new Alexa session with a clean history in the same warm container', async () => {
    const { session, model, send } = harness();
    await send('set up my flower shop', 's1');
    await send('what orders are due today', 's2');
    expect(userTexts(model.calls.at(-1) as never)).not.toContain('set up my flower shop');
    await session.close();
  });
  it('lists the tools again when a new Alexa session starts, even if the notice was missed', async () => {
    const { session, send } = harness();
    await send('hello', 's1');
    const before = methods.filter((m) => m === 'tools/list').length;
    await send('hello again', 's2');
    expect(methods.filter((m) => m === 'tools/list').length).toBe(before + 1);
    await session.close();
  });
  it('reconnects when the server forgot the MCP session (redeploy) before listing tools for a new Alexa session', async () => {
    const { session, send } = harness();
    await send('hello', 's1');
    // A redeploy: the server comes back without the old session and answers 404 for its id.
    await mcp.close();
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    await mcp.connect(transport);
    const out = await send('hello again', 's2');
    expect(out.status).toBe('done');
    await session.close();
  });
  it('keeps the new session clean even if listing tools failed on its first turn', async () => {
    const { session, model, send } = harness();
    await send('set up my flower shop', 's1');
    failNextList = true;
    // runTurn throws here; server.ts turns it into the spoken error.
    await expect(send('hello', 's2')).rejects.toThrow();
    await send('what orders are due today', 's2');
    expect(userTexts(model.calls.at(-1) as never)).not.toContain('set up my flower shop');
    await session.close();
  });
});
