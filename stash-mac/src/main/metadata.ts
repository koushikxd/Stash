function decodeEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function attrValue(tag: string, attr: string): string | null {
  const re = new RegExp(`${attr}=["']([^"']+)["']`, 'i');
  return re.exec(tag)?.[1] ?? null;
}

function metaContent(html: string, keys: string[]): string | null {
  const metas = html.match(/<meta\s+[^>]*>/gi) ?? [];
  for (const tag of metas) {
    const property = attrValue(tag, 'property') ?? attrValue(tag, 'name');
    if (!property || !keys.includes(property.toLowerCase())) continue;
    const content = attrValue(tag, 'content');
    if (content) return decodeEntities(content);
  }
  return null;
}

function documentTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1] ? decodeEntities(match[1]) : null;
}

function trim(value: string | null, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function stripTags(input: string): string {
  return decodeEntities(input.replace(/<[^>]+>/g, ' '));
}

function absoluteUrl(value: string | null, base: string): string | null {
  if (!value) return null;
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

export interface PageMetadata {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

type PartialPageMetadata = Partial<PageMetadata>;

interface XEmbedResponse {
  author_name?: unknown;
  author_url?: unknown;
  title?: unknown;
  html?: unknown;
}

function xStatusUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'x.com' && host !== 'twitter.com') return null;
    if (!/^\/[^/]+\/status(?:es)?\/\d+/.test(parsed.pathname)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function handleFromXUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const handle = parsed.pathname.split('/').filter(Boolean)[0];
    return handle && handle.toLowerCase() !== 'i' ? handle : null;
  } catch {
    return null;
  }
}

function bodyFromXEmbed(embed: XEmbedResponse): string | null {
  const title = typeof embed.title === 'string' ? embed.title : '';
  const quoted = /:\s*"([\s\S]+)"\s*\/\s*X\s*$/i.exec(title)?.[1];
  if (quoted) return decodeEntities(quoted);

  const html = typeof embed.html === 'string' ? embed.html : '';
  if (!html) return null;
  const blockquote = /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/i.exec(html)?.[1] ?? html;
  return stripTags(blockquote.replace(/&mdash;[\s\S]*$/i, ''));
}

async function fetchXMetadata(url: string, timeoutMs: number): Promise<PartialPageMetadata | null> {
  const statusUrl = xStatusUrl(url);
  if (!statusUrl) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const endpoint = new URL('https://publish.twitter.com/oembed');
    endpoint.searchParams.set('url', statusUrl.toString());
    endpoint.searchParams.set('omit_script', '1');
    const res = await fetch(endpoint, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) stash/0.1' },
    });
    if (!res.ok) return null;
    const embed = (await res.json()) as XEmbedResponse;
    const author = typeof embed.author_name === 'string' ? embed.author_name.trim() : '';
    const authorUrl = typeof embed.author_url === 'string' ? embed.author_url : '';
    const handle = handleFromXUrl(authorUrl) ?? handleFromXUrl(url);
    const title = author ? `${author}${handle ? ` (@${handle})` : ''} on X` : null;
    return {
      title,
      description: trim(bodyFromXEmbed(embed), 500),
      siteName: 'x.com',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function isWeakXMetadata(url: string, metadata: PageMetadata): boolean {
  if (!xStatusUrl(url)) return false;
  const title = metadata.title?.toLowerCase() ?? '';
  return !metadata.title || !metadata.description || title === 'x.com' || title === 'x';
}

function fullMetadata(metadata: PartialPageMetadata | null): PageMetadata | null {
  if (!metadata) return null;
  return {
    title: metadata.title ?? null,
    description: metadata.description ?? null,
    image: metadata.image ?? null,
    siteName: metadata.siteName ?? null,
  };
}

export async function fetchMetadata(url: string, timeoutMs = 2000): Promise<PageMetadata | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'stash/0.1 title fetcher' },
    });
    if (!res.ok) return fullMetadata(await fetchXMetadata(url, timeoutMs));
    const type = res.headers.get('content-type') ?? '';
    if (type && !type.includes('text/html')) {
      return fullMetadata(await fetchXMetadata(url, timeoutMs));
    }
    const html = await res.text();
    const metadata = {
      title: trim(metaContent(html, ['og:title', 'twitter:title']) ?? documentTitle(html), 300),
      description: trim(metaContent(html, ['og:description', 'twitter:description', 'description']), 500),
      image: absoluteUrl(metaContent(html, ['og:image', 'twitter:image']), url),
      siteName: trim(metaContent(html, ['og:site_name']), 120),
    };
    if (!isWeakXMetadata(url, metadata)) return metadata;
    const xMetadata = await fetchXMetadata(url, timeoutMs);
    return { ...metadata, ...xMetadata };
  } catch {
    return fullMetadata(await fetchXMetadata(url, timeoutMs));
  } finally {
    clearTimeout(timeout);
  }
}
