// src/server.ts

import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import * as fs from 'node:fs';
import { Client as Notion } from '@notionhq/client';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { BlockObjectRequest, BlockObjectResponse, PartialBlockObjectResponse } from '@notionhq/client/build/src/api-endpoints';
import { z } from 'zod';

function absoluteEndpoint(req: Request, path: string) {
  const proto = (req.headers['x-forwarded-proto'] as string) || 'http';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || '';
  return `${proto}://${host}${path}`;
}

const notion = new Notion({ auth: process.env.NOTION_TOKEN! });
const HUB_PAGE = process.env.REAL_ESTATE_PAGE_ID!;
const DBS: Record<string, string> = JSON.parse(fs.readFileSync('dbs.json', 'utf8'));

function buildServer() {
  const server = new McpServer({ name: 'RealEstateOps', version: '1.0.0' });

  // Upsert genérico para cualquier DB configurada en dbs.json
  server.tool('notion.upsert', {
    db: z.string(),
    uniqueProp: z.string(),
    uniqueValue: z.any(),
    properties: z.record(z.any())
  }, async ({ db, uniqueProp, uniqueValue, properties }) => {
    const database_id = DBS[db];
    if (!database_id) throw new Error(`DB no configurada: ${db}`);

    let filter: any = { property: uniqueProp, rich_text: { equals: String(uniqueValue) } };
    if (typeof uniqueValue === 'number') filter = { property: uniqueProp, number: { equals: uniqueValue } };
    if (/\S+@\S+/.test(String(uniqueValue))) filter = { property: uniqueProp, email: { equals: String(uniqueValue) } };

    const q = await notion.databases.query({ database_id, filter });
    if (q.results[0]?.object === 'page') {
      const id = q.results[0].id;
      await notion.pages.update({ page_id: id, properties });
      return { content: [{ type: 'text', text: `updated:${id}` }] };
    }
    const created: any = await notion.pages.create({ parent: { database_id }, properties });
    return { content: [{ type: 'text', text: `created:${created.id}` }] };
  });

  // Inserta un resumen en la página madre "Real Estate"
  server.tool('notion.hub_summary_projects', {
    sinceDays: z.number().min(1).max(90).default(14),
    db: z.string().default('seguimientos')
  }, async ({ sinceDays, db }) => {
    const database_id = DBS[db];
    if (!database_id) throw new Error(`DB no configurada: ${db}`);

    const sinceISO = new Date(Date.now() - sinceDays * 864e5).toISOString();
    const q = await notion.databases.query({
      database_id,
      filter: { timestamp: 'last_edited_time', last_edited_time: { on_or_after: sinceISO } },
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }]
    });

    // Archivar callout AUTO previo
    const children = await notion.blocks.children.list({ block_id: HUB_PAGE, page_size: 100 });
    for (const b of children.results as Array<BlockObjectResponse | PartialBlockObjectResponse>) {
      if ('type' in b && b.type === 'callout') {
        const text = (b as any).callout?.rich_text?.[0]?.plain_text || '';
        if (text.includes('AUTO · Resumen')) {
          await notion.blocks.update({ block_id: b.id, archived: true });
        }
      }
    }

    // Nuevo callout + bullets
    const title = `AUTO · Resumen (últimos ${sinceDays} días)`;
    const callout: any = await notion.blocks.children.append({
      block_id: HUB_PAGE,
      children: [{
        object: 'block',
        type: 'callout',
        callout: { icon: { emoji: '🟩' }, rich_text: [{ type: 'text', text: { content: title } }] }
      }]
    });
    const calloutId = callout.results[0].id;

    const bullets: BlockObjectRequest[] = q.results.slice(0, 25).map(p => {
      const name =
        (p as any).properties?.Name?.title?.[0]?.plain_text ||
        (p as any).properties?.Título?.title?.[0]?.plain_text ||
        'Sin título';
      return {
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [{ type: 'text', text: { content: name } }]
        }
      };
    });
    if (bullets.length) {
      await notion.blocks.children.append({ block_id: calloutId, children: bullets });
    }
    return { content: [{ type: 'text', text: `hub-updated:${bullets.length}` }] };
  });

  return server;
}

const app = express();

app.use((_req: Request, res: Response, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  next();
});

app.get('/favicon.ico', (_req: Request, res: Response) => res.status(204).end());
app.head('/', (_req: Request, res: Response) => res.status(200).end());
app.options('/', (_req: Request, res: Response) => res.status(204).end());
app.get('/', (req: Request, res: Response) => {
  const base = absoluteEndpoint(req, '');
  res.json({
    name: 'MCP RealEstateOps',
    version: '1.0.0',
    sse: absoluteEndpoint(req, '/sse'),
    health: absoluteEndpoint(req, '/healthz'),
    docs: absoluteEndpoint(req, '/openapi.yaml')
  });
});

app.get('/healthz', (_req: Request, res: Response) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/.well-known/ai-plugin.json', (req: Request, res: Response) => {
  const apiUrl = absoluteEndpoint(req, '/openapi.yaml');
  res.json({
    schema_version: 'v1',
    name_for_human: 'MCP RealEstateOps',
    name_for_model: 'realestateops',
    description_for_human: 'Notion ops (upsert, summaries) for Real Estate via MCP.',
    description_for_model: 'Tools: notion.upsert, notion.hub_summary_projects over SSE.',
    auth: { type: 'none' },
    api: { type: 'openapi', url: apiUrl, is_user_authenticated: false },
    logo_url: absoluteEndpoint(req, '/logo.png'),
    contact_email: 'ops@example.com',
    legal_info_url: 'https://investopsmiami.com/legal'
  });
});

app.get('/openapi.yaml', (req: Request, res: Response) => {
  const base = absoluteEndpoint(req, '');
  const yaml = `openapi: 3.0.1
info:
  title: MCP RealEstateOps
  version: "1.0.0"
servers:
  - url: ${base}
paths:
  /:
    get:
      summary: Basic info
      responses:
        "200":
          description: OK
  /healthz:
    get:
      summary: Health check
      responses:
        "200":
          description: OK
  /sse:
    get:
      summary: MCP SSE endpoint (Server-Sent Events)
      responses:
        "200":
          description: SSE stream
  /search:
    get:
      summary: Search tool (required by MCP)
      parameters:
        - in: query
          name: q
          required: false
          schema:
            type: string
      responses:
        "200":
          description: OK
  /fetch:
    get:
      summary: Fetch tool (required by MCP)
      parameters:
        - in: query
          name: id
          required: false
          schema:
            type: string
      responses:
        "200":
          description: OK
`;
  res.type('text/yaml').send(yaml);
});

app.get('/logo.png', (_req: Request, res: Response) => {
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQImWNgYGD4DwAB3gF+5m3RvwAAAABJRU5ErkJggg==',
    'base64'
  );
  res.type('image/png').send(png1x1);
});

// Basic tools required by some MCP validators: /search and /fetch
app.head('/search', (_req: Request, res: Response) => res.status(200).end());
app.options('/search', (_req: Request, res: Response) => res.status(204).end());
app.get('/search', (req: Request, res: Response) => {
  const q = (req.query.q as string) || null;
  res.json({ ok: true, tool: 'search', q });
});

app.head('/fetch', (_req: Request, res: Response) => res.status(200).end());
app.options('/fetch', (_req: Request, res: Response) => res.status(204).end());
app.get('/fetch', (req: Request, res: Response) => {
  const id = (req.query.id as string) || null;
  res.json({ ok: true, tool: 'fetch', id });
});

// Preflight/HEAD for MCP endpoint
app.head('/mcp', (_req: Request, res: Response) => res.status(200).end());
app.options('/mcp', (_req: Request, res: Response) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS,POST',
    'Access-Control-Allow-Headers': 'Content-Type, Accept'
  }).status(204).end();
});

// SSE endpoint at /mcp
app.get('/mcp', (_req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const server = buildServer();
  const transport = new SSEServerTransport(absoluteEndpoint(_req, '/mcp'), res);
  server.connect(transport);
});

// HTTP POST endpoint for MCP messages (used by clients after session starts)
app.post('/mcp', express.json({ type: '*/*', limit: '10mb' }), (req: Request, res: Response) => {
  // Use SDK's handler (cast to any to avoid type issues across versions)
  (SSEServerTransport as any).handlePost?.(req, res);
});

// Alternate SSE endpoint at /sse (some clients expect this path)
app.head('/sse', (_req: Request, res: Response) => res.status(200).end());
app.options('/sse', (_req: Request, res: Response) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS,POST',
    'Access-Control-Allow-Headers': 'Content-Type, Accept'
  }).status(204).end();
});
app.get('/sse', (_req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const server = buildServer();
  const transport = new SSEServerTransport(absoluteEndpoint(_req, '/sse'), res);
  server.connect(transport);
});

// POST alias for /sse as well
app.post('/sse', express.json({ type: '*/*', limit: '10mb' }), (req: Request, res: Response) => {
  (SSEServerTransport as any).handlePost?.(req, res);
});
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, '0.0.0.0', () => console.log(`MCP on http://localhost:${PORT}/mcp`));