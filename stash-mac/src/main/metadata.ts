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

export async function fetchMetadata(url: string, timeoutMs = 2000): Promise<PageMetadata | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'stash/0.1 title fetcher' },
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (type && !type.includes('text/html')) return null;
    const html = await res.text();
    return {
      title: trim(metaContent(html, ['og:title', 'twitter:title']) ?? documentTitle(html), 300),
      description: trim(metaContent(html, ['og:description', 'twitter:description', 'description']), 500),
      image: absoluteUrl(metaContent(html, ['og:image', 'twitter:image']), url),
      siteName: trim(metaContent(html, ['og:site_name']), 120),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
