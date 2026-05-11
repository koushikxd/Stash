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

function metaTitle(html: string): string | null {
  const metas = html.match(/<meta\s+[^>]*>/gi) ?? [];
  for (const tag of metas) {
    const property = attrValue(tag, 'property') ?? attrValue(tag, 'name');
    if (property !== 'og:title' && property !== 'twitter:title') continue;
    const content = attrValue(tag, 'content');
    if (content) return decodeEntities(content);
  }
  return null;
}

function documentTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1] ? decodeEntities(match[1]) : null;
}

export async function fetchTitle(url: string, timeoutMs = 2000): Promise<string | null> {
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
    const title = metaTitle(html) ?? documentTitle(html);
    if (!title || title.length > 300) return title?.slice(0, 300) ?? null;
    return title;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
