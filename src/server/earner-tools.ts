import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { WebSource } from './parallel.js';

// Custom tools for the Earner Dot. They are enabled only for the Dot IDs in
// EARNER_DOT_IDS so the other Dots keep the stock OpenDots tool set.

export interface EarnerToolsEnv {
  dotIds: string[];
  salesCsvPath?: string;
}

export function earnerToolsEnv(env: NodeJS.ProcessEnv): EarnerToolsEnv {
  return {
    dotIds: (env.EARNER_DOT_IDS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    salesCsvPath: env.EARNER_SALES_CSV || undefined,
  };
}

export type Research = (
  objective: string,
  searchQueries: string[],
) => Promise<{ sources: WebSource[]; limitations: string[] }>;

const SALES_COLUMNS = [
  'date',
  'platform',
  'product',
  'units',
  'revenue_jpy',
  'fee_jpy',
  'note',
] as const;

export interface SaleRow {
  date: string;
  platform: string;
  product: string;
  units: number;
  revenue_jpy: number;
  fee_jpy: number;
  note: string;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

export function summarizeSales(text: string, since?: string, until?: string) {
  const [header, ...body] = parseCsv(text);
  const missing = SALES_COLUMNS.filter((column) => !header?.includes(column));
  if (!header || missing.length)
    throw new Error(`Sales CSV is missing columns: ${missing.join(', ')}.`);
  const index = (column: string) => header.indexOf(column);
  const number = (value: string | undefined) => {
    const parsed = Number((value ?? '').replace(/,/g, '').trim() || 0);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const rows: SaleRow[] = body
    .map((values) => ({
      date: values[index('date')]?.trim() ?? '',
      platform: values[index('platform')]?.trim() ?? '',
      product: values[index('product')]?.trim() ?? '',
      units: number(values[index('units')]),
      revenue_jpy: number(values[index('revenue_jpy')]),
      fee_jpy: number(values[index('fee_jpy')]),
      note: values[index('note')]?.trim() ?? '',
    }))
    .filter(
      (row) => (!since || row.date >= since) && (!until || row.date <= until),
    );
  const byProduct = new Map<
    string,
    { units: number; revenue_jpy: number; net_jpy: number }
  >();
  for (const row of rows) {
    const total = byProduct.get(row.product) ?? {
      units: 0,
      revenue_jpy: 0,
      net_jpy: 0,
    };
    total.units += row.units;
    total.revenue_jpy += row.revenue_jpy;
    total.net_jpy += row.revenue_jpy - row.fee_jpy;
    byProduct.set(row.product, total);
  }
  const revenue = rows.reduce((sum, row) => sum + row.revenue_jpy, 0);
  const fees = rows.reduce((sum, row) => sum + row.fee_jpy, 0);
  return {
    period: { since: since ?? null, until: until ?? null },
    rowCount: rows.length,
    totals: {
      units: rows.reduce((sum, row) => sum + row.units, 0),
      revenue_jpy: revenue,
      fee_jpy: fees,
      net_jpy: revenue - fees,
    },
    byProduct: Object.fromEntries(byProduct),
    rows: rows.slice(-50),
    note: rows.length
      ? 'Figures come from the owner-maintained sales CSV.'
      : 'No sales recorded for this period. Report 0 or "not shared"; do not estimate.',
  };
}

const QUERIES_PER_SEARCH = 3;
const SOURCE_TEXT_LIMIT = 1500;

export async function deepResearch(
  research: Research,
  objective: string,
  queries: string[],
) {
  const unique = [...new Set(queries.map((query) => query.trim()))].filter(
    Boolean,
  );
  const sources = new Map<string, WebSource>();
  const limitations: string[] = [];
  for (let i = 0; i < unique.length; i += QUERIES_PER_SEARCH) {
    const batch = unique.slice(i, i + QUERIES_PER_SEARCH);
    try {
      const result = await research(objective, batch);
      limitations.push(...result.limitations);
      for (const source of result.sources)
        if (!sources.has(source.url)) sources.set(source.url, source);
    } catch (error) {
      // Abort means the turn is over; other failures only lose this batch.
      if (error instanceof Error && error.name === 'AbortError') throw error;
      limitations.push(
        `Search for "${batch.join(' / ')}" failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    objective,
    searches: Math.ceil(unique.length / QUERIES_PER_SEARCH),
    sources: [...sources.values()].map((source) => ({
      title: source.title,
      url: source.url,
      text: source.text.slice(0, SOURCE_TEXT_LIMIT),
    })),
    limitations,
  };
}

export function earnerTools(
  dotId: string,
  env: EarnerToolsEnv,
  research?: Research,
): ToolDefinition[] {
  if (!env.dotIds.includes(dotId)) return [];
  const tools: ToolDefinition[] = [];
  if (env.salesCsvPath) {
    const path = env.salesCsvPath;
    tools.push(
      defineTool({
        name: 'read_sales_csv',
        description:
          'Read the owner-maintained sales record (CSV) and return totals per product. Use it for weekly reports instead of guessing numbers. Dates are YYYY-MM-DD.',
        parameters: z.object({
          since: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe('First date to include (YYYY-MM-DD).'),
          until: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe('Last date to include (YYYY-MM-DD).'),
        }),
        execute: async ({ since, until }) =>
          summarizeSales(await readFile(path, 'utf8'), since, until),
      }),
    );
  }
  if (research)
    tools.push(
      defineTool({
        name: 'deep_research',
        description:
          'Run several web searches in one call and return deduplicated sources. Prefer this over repeated search_web calls for market research. Cite the returned URLs. Sends the queries to Parallel.',
        parameters: z.object({
          objective: z.string().min(1).max(4000),
          queries: z
            .array(z.string().min(1).max(200))
            .min(1)
            .max(9)
            .describe(
              'Up to nine concise keyword queries covering different angles, 3–6 words each.',
            ),
        }),
        execute: ({ objective, queries }) =>
          deepResearch(research, objective, queries),
      }),
    );
  return tools;
}
