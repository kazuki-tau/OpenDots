import { describe, expect, it, vi } from 'vitest';
import {
  deepResearch,
  earnerTools,
  earnerToolsEnv,
  parseCsv,
  summarizeSales,
} from '../src/server/earner-tools.js';

const csv = `date,platform,product,units,revenue_jpy,fee_jpy,note
2026-10-01,note,"Guide, vol.1",2,1960,280,
2026-10-08,BOOTH,Template,1,"1,500",84,"said ""thanks"""
2026-10-20,note,"Guide, vol.1",1,980,140,
`;

describe('earner tools', () => {
  it('parses quoted CSV fields', () => {
    expect(parseCsv('a,b\r\n"x,1","say ""hi"""\n')).toEqual([
      ['a', 'b'],
      ['x,1', 'say "hi"'],
    ]);
  });

  it('totals sales per product within a period', () => {
    const summary = summarizeSales(csv, '2026-10-01', '2026-10-14');
    expect(summary.rowCount).toBe(2);
    expect(summary.totals).toEqual({
      units: 3,
      revenue_jpy: 3460,
      fee_jpy: 364,
      net_jpy: 3096,
    });
    expect(summary.byProduct['Guide, vol.1']).toEqual({
      units: 2,
      revenue_jpy: 1960,
      net_jpy: 1680,
    });
    expect(summary.rows[1].note).toBe('said "thanks"');
  });

  it('says not to estimate when there are no sales', () => {
    const summary = summarizeSales(
      'date,platform,product,units,revenue_jpy,fee_jpy,note\n',
    );
    expect(summary.totals.revenue_jpy).toBe(0);
    expect(summary.note).toMatch(/do not estimate/);
  });

  it('rejects a CSV without the expected columns', () => {
    expect(() => summarizeSales('date,amount\n2026-10-01,100\n')).toThrow(
      /missing columns/,
    );
  });

  it('batches deep research queries and deduplicates sources', async () => {
    const research = vi
      .fn()
      .mockResolvedValueOnce({
        sources: [
          { title: 'A', url: 'https://a.example', text: 'x'.repeat(5000) },
        ],
        limitations: [],
      })
      .mockRejectedValueOnce(new Error('rate limited'));
    const result = await deepResearch(research, 'market', [
      'q1',
      'q2',
      'q3',
      'q4',
      'q1',
    ]);
    expect(research).toHaveBeenCalledTimes(2);
    expect(research.mock.calls[0][1]).toEqual(['q1', 'q2', 'q3']);
    expect(research.mock.calls[1][1]).toEqual(['q4']);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].text).toHaveLength(1500);
    expect(result.limitations[0]).toMatch(/q4.*rate limited/);
  });

  it('only gives the tools to configured Dots', () => {
    const env = earnerToolsEnv({
      EARNER_DOT_IDS: 'earner, other',
      EARNER_SALES_CSV: '/tmp/sales.csv',
    });
    const research = vi.fn();
    expect(earnerTools('dot', env, research)).toEqual([]);
    expect(earnerTools('earner', env, research).map((t) => t.name)).toEqual([
      'read_sales_csv',
      'deep_research',
    ]);
    expect(earnerTools('earner', env).map((t) => t.name)).toEqual([
      'read_sales_csv',
    ]);
  });
});
