// src/server.ts
import 'dotenv/config';
import express from 'express';
import * as fs from 'node:fs';
import { Client as Notion } from '@notionhq/client';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
const notion = new Notion({ auth: process.env.NOTION_TOKEN });
const HUB_PAGE = process.env.REAL_ESTATE_PAGE_ID;
const DBS = JSON.parse(fs.readFileSync('dbs.json', 'utf8'));
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
        if (!database_id)
            throw new Error(`DB no configurada: ${db}`);
        let filter = { property: uniqueProp, rich_text: { equals: String(uniqueValue) } };
        if (typeof uniqueValue === 'number')
            filter = { property: uniqueProp, number: { equals: uniqueValue } };
        if (/\S+@\S+/.test(String(uniqueValue)))
            filter = { property: uniqueProp, email: { equals: String(uniqueValue) } };
        const q = await notion.databases.query({ database_id, filter });
        if (q.results[0]?.object === 'page') {
            const id = q.results[0].id;
            await notion.pages.update({ page_id: id, properties });
            return { content: [{ type: 'text', text: `updated:${id}` }] };
        }
        const created = await notion.pages.create({ parent: { database_id }, properties });
        return { content: [{ type: 'text', text: `created:${created.id}` }] };
    });
    // Inserta un resumen en la página madre "Real Estate"
    server.tool('notion.hub_summary_projects', {
        sinceDays: z.number().min(1).max(90).default(14),
        db: z.string().default('seguimientos')
    }, async ({ sinceDays, db }) => {
        const database_id = DBS[db];
        if (!database_id)
            throw new Error(`DB no configurada: ${db}`);
        const sinceISO = new Date(Date.now() - sinceDays * 864e5).toISOString();
        const q = await notion.databases.query({
            database_id,
            filter: { timestamp: 'last_edited_time', last_edited_time: { on_or_after: sinceISO } },
            sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }]
        });
        // Archivar callout AUTO previo
        const children = await notion.blocks.children.list({ block_id: HUB_PAGE, page_size: 100 });
        for (const b of children.results) {
            if ('type' in b && b.type === 'callout') {
                const text = b.callout?.rich_text?.[0]?.plain_text || '';
                if (text.includes('AUTO · Resumen')) {
                    await notion.blocks.update({ block_id: b.id, archived: true });
                }
            }
        }
        // Nuevo callout + bullets
        const title = `AUTO · Resumen (últimos ${sinceDays} días)`;
        const callout = await notion.blocks.children.append({
            block_id: HUB_PAGE,
            children: [{
                    object: 'block',
                    type: 'callout',
                    callout: { icon: { emoji: '🟩' }, rich_text: [{ type: 'text', text: { content: title } }] }
                }]
        });
        const calloutId = callout.results[0].id;
        const bullets = q.results.slice(0, 25).map(p => {
            const name = p.properties?.Name?.title?.[0]?.plain_text ||
                p.properties?.Título?.title?.[0]?.plain_text ||
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
app.get('/', (_req, res) => res.send('OK'));
app.get('/mcp', (req, res) => {
    const server = buildServer();
    const transport = new SSEServerTransport({ request: req, response: res });
    server.connect(transport);
});
app.listen(3000, () => console.log('MCP on http://localhost:3000/mcp'));
