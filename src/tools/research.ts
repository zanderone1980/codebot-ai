/**
 * Deep Research Tool — Chains web search + web fetch + summarization.
 *
 * Performs multi-step research: search for sources, fetch top results,
 * extract key information, and compile a structured report.
 * Designed to be used by the agent as a single tool call for thorough research.
 */

import { Tool, CapabilityLabel } from '../types';

const TIMEOUT = 30_000;
const MAX_SOURCES = 8;
const MAX_CONTENT_PER_SOURCE = 4_000;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SourceContent {
  title: string;
  url: string;
  content: string;
  fetchedAt: string;
}

async function webSearch(query: string): Promise<SearchResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    // Use DuckDuckGo HTML search (no API key needed)
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'CodeBot-Research/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    const html = await res.text();

    // Parse results from HTML (simple regex-based extraction)
    const results: SearchResult[] = [];
    const resultPattern = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([^<]*(?:<[^>]+>[^<]*)*)<\/a>/g;
    const snippetPattern = /<a class="result__snippet"[^>]*>([^<]*(?:<[^>]+>[^<]*)*)<\/a>/g;

    const urls: string[] = [];
    const titles: string[] = [];
    let match;

    while ((match = resultPattern.exec(html)) !== null) {
      // DuckDuckGo wraps URLs in redirect — extract actual URL
      let url = match[1];
      const uddg = url.match(/uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);
      urls.push(url);
      titles.push(match[2].replace(/<[^>]+>/g, '').trim());
    }

    const snippets: string[] = [];
    while ((match = snippetPattern.exec(html)) !== null) {
      snippets.push(match[1].replace(/<[^>]+>/g, '').trim());
    }

    for (let i = 0; i < Math.min(urls.length, MAX_SOURCES); i++) {
      results.push({
        title: titles[i] || '',
        url: urls[i],
        snippet: snippets[i] || '',
      });
    }

    return results;
  } catch {
    return [];
  }
}

async function fetchPageContent(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'CodeBot-Research/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return '';

    const html = await res.text();

    // Simple HTML-to-text: strip tags, decode entities, clean whitespace
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    return text.substring(0, MAX_CONTENT_PER_SOURCE);
  } catch {
    return '';
  }
}

export class DeepResearchTool implements Tool {
  name = 'deep_research';
  description = 'Perform deep research on a topic. Searches the web, fetches multiple sources, and compiles a structured report with key findings and source URLs. Use this when you need thorough, multi-source research on any topic.';
  permission: Tool['permission'] = 'auto';
  capabilities: CapabilityLabel[] = ['read-only', 'net-fetch'];
  cacheable = true;

  parameters = {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'The topic to research',
      },
      depth: {
        type: 'string',
        description: 'Research depth: "quick" (2-3 sources), "standard" (4-5 sources), "deep" (6-8 sources). Default: standard',
      },
      focus: {
        type: 'string',
        description: 'Optional focus area to narrow the research (e.g., "recent developments", "technical details", "market analysis")',
      },
    },
    required: ['topic'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const topic = args.topic as string;
    if (!topic) return 'Error: topic is required';

    const depth = (args.depth as string) || 'standard';
    const focus = (args.focus as string) || '';

    const maxSources = depth === 'quick' ? 3 : depth === 'deep' ? 8 : 5;

    // Step 1: Generate search queries
    const queries = [topic];
    if (focus) {
      queries.push(`${topic} ${focus}`);
    }
    if (depth === 'deep') {
      queries.push(`${topic} latest news 2025 2026`);
      queries.push(`${topic} analysis expert opinion`);
    }

    // Step 2: Search
    const allResults: SearchResult[] = [];
    const seenUrls = new Set<string>();

    for (const query of queries) {
      const results = await webSearch(query);
      for (const r of results) {
        if (!seenUrls.has(r.url) && !r.url.includes('duckduckgo.com')) {
          seenUrls.add(r.url);
          allResults.push(r);
        }
      }
    }

    if (!allResults.length) {
      return `Could not find search results for "${topic}". The web search may be unavailable. Try using web_search and web_fetch tools directly.`;
    }

    // Step 3: Fetch top sources
    const sourcesToFetch = allResults.slice(0, maxSources);
    const sources: SourceContent[] = [];

    const fetchPromises = sourcesToFetch.map(async (result) => {
      const content = await fetchPageContent(result.url);
      if (content.length > 100) {
        sources.push({
          title: result.title,
          url: result.url,
          content,
          fetchedAt: new Date().toISOString(),
        });
      }
    });

    await Promise.all(fetchPromises);

    if (!sources.length) {
      // Fall back to snippets if fetching failed
      return [
        `## Research: ${topic}`,
        focus ? `Focus: ${focus}` : '',
        '',
        '### Search Results (could not fetch full content):',
        '',
        ...allResults.slice(0, maxSources).map((r, i) =>
          `${i + 1}. **${r.title}**\n   ${r.snippet}\n   Source: ${r.url}`
        ),
        '',
        `_${allResults.length} results found. Full content fetch failed — try web_fetch on individual URLs._`,
      ].filter(l => l !== undefined).join('\n');
    }

    // Step 4: Compile report
    const report: string[] = [
      `## Research Report: ${topic}`,
      focus ? `**Focus:** ${focus}` : '',
      `**Depth:** ${depth} | **Sources:** ${sources.length}`,
      `**Date:** ${new Date().toISOString().split('T')[0]}`,
      '',
      '---',
      '',
      '### Key Information',
      '',
    ];

    // Extract key content from each source
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      // Get first meaningful paragraph (skip very short fragments)
      const sentences = src.content.split(/\.\s+/).filter(s => s.length > 30);
      const excerpt = sentences.slice(0, 3).join('. ') + '.';

      report.push(`**Source ${i + 1}: ${src.title}**`);
      report.push(`${excerpt.substring(0, 500)}`);
      report.push(`_Source: ${src.url}_`);
      report.push('');
    }

    report.push('---');
    report.push('');
    report.push('### All Sources');
    report.push('');
    for (let i = 0; i < sources.length; i++) {
      report.push(`${i + 1}. [${sources[i].title}](${sources[i].url})`);
    }

    // Add unfetched results as additional references
    const unfetched = allResults.filter(r => !sources.find(s => s.url === r.url));
    if (unfetched.length > 0) {
      report.push('');
      report.push('### Additional References');
      for (const r of unfetched.slice(0, 5)) {
        report.push(`- [${r.title}](${r.url}) — ${r.snippet.substring(0, 80)}`);
      }
    }

    return report.join('\n');
  }
}
