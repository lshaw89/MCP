// server.ts
import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';

const PUNCHH_BASE = process.env.PUNCHH_BASE_URL!;      // e.g. https://sandbox.punchh.com
const PUNCHH_TOKEN = process.env.PUNCHH_TOKEN!;        // sandbox bearer token

// 1) Create the MCP server and register tools
const mcp = new McpServer({ name: 'punchh-mcp', version: '1.0.0' });

// Tool: list a customer’s recent transactions (read-only)
mcp.registerTool(
  'punchh.listTransactions',
  {
    title: 'List recent transactions',
    description: 'List recent transactions for a Punchh customer (sandbox).',
    inputSchema: {
      customer_id: z.string().describe('Punchh customer ID'),
      limit: z.number().int().min(1).max(100).default(25)
    }
  },
  async ({ customer_id, limit }) => {
    const url = `${PUNCHH_BASE}/api/v2/customers/${customer_id}/transactions?limit=${limit}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${PUNCHH_TOKEN}` } });
    if (!r.ok) throw new Error(`Punchh error ${r.status}`);
    const data = await r.json();

    // redact a couple of common PII fields for demo safety
    for (const t of data?.transactions ?? []) {
      if (t.customer?.email) t.customer.email = 'redacted@example.com';
      if (t.customer?.phone) t.customer.phone = '**********';
    }

    return { content: [{ type: 'json', json: data }] };
  }
);

// Tool: fetch basic customer profile (read-only)
mcp.registerTool(
  'punchh.getCustomer',
  {
    title: 'Get customer profile',
    description: 'Fetch a Punchh customer profile (sandbox).',
    inputSchema: { customer_id: z.string().describe('Punchh customer ID') }
  },
  async ({ customer_id }) => {
    const url = `${PUNCHH_BASE}/api/v2/customers/${encodeURIComponent(customer_id)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${PUNCHH_TOKEN}` } });
    if (!r.ok) throw new Error(`Punchh error ${r.status}`);
    const data = await r.json();

    if (data?.email) data.email = 'redacted@example.com';
    if (data?.phone) data.phone = '**********';

    return { content: [{ type: 'json', json: data }] };
  }
);

// 2) Expose the MCP server over an HTTP route
const app = express();
app.use(express.json());

// keep simple per-session state (optional)
const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => { transports[sid] = transport; },
      // enableDnsRebindingProtection: true,
      // allowedHosts: ['127.0.0.1', 'your.domain.com'],
    });
    transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
    await mcp.connect(transport);
  } else {
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No valid session' }, id: null });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

app.listen(process.env.PORT ?? 3000, () => {
  console.log('MCP server listening on /mcp');
});
