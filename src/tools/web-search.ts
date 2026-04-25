import { Tool, CapabilityLabel } from '../types';
import { cacheGet, cacheSet } from '../offline-cache';

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export class WebSearchTool implements Tool {
  name = 'web_search';
  description = 'Search the web using DuckDuckGo. Returns titles, URLs, and snippets. Use for research, fact-checking, finding documentation, or discovering information. If results are empty, try the browser tool to navigate to a search engine directly.';
  permission: Tool['permission'] = 'prompt';
  capabilities: CapabilityLabel[] = ['read-only', 'net-fetch'];
  parameters = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      num_results: { type: 'number', description: 'Number of results to return (default 5, max 10)' },
    },
    required: ['query'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string;
    if (!query) return 'Error: query is required';

    const numResults = Math.min(Math.max((args.num_results as number) || 5, 1), 10);

    const cacheKey = `web_search:${query}:${numResults}`;

    try {
      const results = await this.search(query, numResults);

      if (results.length === 0) {
        return `No results found for "${query}". Try a different query or use the browser tool to search directly.`;
      }

      let output = `Search results for "${query}":\n\n`;
      results.forEach((r, i) => {
        output += `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}\n\n`;
      });

      const result = output.trim();

      // Cache for offline fallback (2h TTL)
      cacheSet(cacheKey, result, 7_200_000);

      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);

      // Offline fallback
      const cached = cacheGet(cacheKey);
      if (cached) {
        return `[Offline — cached results]\n\n${cached}`;
      }

      return `Search error: ${msg}. Try using the browser tool to navigate to https://duckduckgo.com/?q=${encodeURIComponent(query)} instead.`;
    }
  }

  private async search(query: string, numResults: number): Promise<SearchResult[]> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CodeBot/1.0)',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`DuckDuckGo returned ${response.status}`);
    }

    const html = await response.text();
    return this.extractResults(html, numResults);
  }

  private extractResults(html: string, max: number): SearchResult[] {
    const results: SearchResult[] = [];

    // DuckDuckGo HTML results are in <div class="result ..."> blocks
    // Each has: <a class="result__a"> for title/link, <a class="result__snippet"> for snippet
    const blocks = html.split(/class="result\s/);

    for (let i = 1; i < blocks.length && results.length < max; i++) {
      const block = blocks[i];

      // Extract title from result__a
      const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
      const title = titleMatch ? this.stripTags(titleMatch[1]).trim() : '';

      // Extract URL — DDG wraps URLs in a redirect, the actual URL is in uddg= parameter
      const urlMatch = block.match(/uddg=([^"&]+)/);
      let url = urlMatch ? decodeURIComponent(urlMatch[1]) : '';

      // Fallback: try href directly
      if (!url) {
        const hrefMatch = block.match(/href="(https?:\/\/[^"]+)"/);
        url = hrefMatch ? hrefMatch[1] : '';
      }

      // Extract snippet from result__snippet
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      const snippet = snippetMatch ? this.stripTags(snippetMatch[1]).trim() : '';

      if (title && url && !url.includes('duckduckgo.com')) {
        results.push({ title, url, snippet });
      }
    }

    return results;
  }

  private stripTags(html: string): string {
    return html
      .replace(/<[^>]+>/g, '')           // Remove HTML tags
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')             // Collapse whitespace
      .trim();
  }
}
