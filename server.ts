import 'dotenv/config';
import express, { Request, Response } from 'express';
import fetch from 'node-fetch';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());

// --- auth middleware ---
app.use((req: Request, res: Response, next) => {
  if (req.path === '/healthz') return next();
  const expected = `Bearer ${process.env.MCP_SHARED_SECRET}`;
  if (!process.env.MCP_SHARED_SECRET) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }
  if (req.headers.authorization !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.get('/healthz', (_req: Request, res: Response) => res.send('ok'));

// Punchh env
const PUNCHH_BASE = process.env.PUNCHH_BASE_URL!;
const PUNCHH_TOKEN = process.env.PUNCHH_TOKEN!;

// MCP server
const mcp = new McpServer({ name: 'punchh-mcp', version: '1.0.0' });

// Tool: Get customer profile
mcp.registerTool(
  'punchh.getCustomer',
  {
    title: 'Get customer profile',
    description: 'Fetch a Punchh customer profile (sandbox).',
    inputSchema: { customer_id: z.string() }
  },
  async ({ customer_id }) => {
    const url = `${PUNCHH_BASE}/api/v2/customers/${encodeURIComponent(customer_id)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${PUNCHH_TOKEN}` } });
    if (!r.ok) throw new Error(`Punchh error ${r.status}`);
    const data: any = await r.json();

    if (data?.email) data.email = 'redacted@example.com';
    if (data?.phone) data.phone = '**********';

    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  }
);

// Tool: List transactions
mcp.registerTool(
  'punchh.listTransactions',
  {
    title: 'List transactions',
    description: 'List recent transactions for a Punchh customer (sandbox).',
    inputSchema: {
      customer_id: z.string(),
      limit: z.number().int().min(1).max(100).default(25)
    }
  },
  async ({ customer_id, limit }) => {
    const url = `${PUNCHH_BASE}/api/v2/customers/${encodeURIComponent(customer_id)}/transactions?limit=${limit}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${PUNCHH_TOKEN}` } });
    if (!r.ok) throw new Error(`Punchh error ${r.status}`);
    const data: any = await r.json();

    for (const t of data?.transactions ?? []) {
      if (t?.customer?.email) t.customer.email = 'redacted@example.com';
      if (t?.customer?.phone) t.customer.phone = '**********';
    }

    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  }
);

// HTTP transport
const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post('/mcp', async (req: Request, res: Response) => {
  const sid = req.headers['mcp-session-id'] as string | undefined;
  let transport: StreamableHTTPServerTransport | undefined;

  if (sid && transports[sid]) {
    transport = transports[sid];
  } else if (!sid && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSid) => { transports[newSid] = transport!; }
    });
    await mcp.connect(transport);
  } else {
    return res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: No valid session' },
      id: null
    });
  }

  await transport.handleRequest(req, res, req.body);
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`MCP server running on :${port}/mcp`));
