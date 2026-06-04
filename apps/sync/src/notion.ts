/**
 * Minimal Notion API client for the sync Worker.
 *
 * Only the surface the projection needs: query a database (paged), create a
 * page, and update a page. Every request goes through a single rate-limited
 * gate (Notion's API allows ~3 req/s; we serialize and space requests out so a
 * cron run never trips a 429). No external SDK — plain fetch against the
 * documented REST endpoints.
 */

const NOTION_BASE = 'https://api.notion.com/v1';

// ---------------------------------------------------------------------------
// Notion property value shapes we use (subset of the full API).
// ---------------------------------------------------------------------------

export type NotionRichText = {
  type: 'text';
  text: { content: string; link?: { url: string } | null };
};

export type NotionProperty =
  | { title: Array<NotionRichText> }
  | { rich_text: Array<NotionRichText> }
  | { select: { name: string } | null }
  | { number: number | null }
  | { url: string | null }
  | { date: { start: string } | null }
  | { checkbox: boolean };

export type NotionProperties = Record<string, NotionProperty>;

export interface NotionPage {
  id: string;
  properties: Record<string, unknown>;
}

interface NotionQueryResponse {
  results: NotionPage[];
  next_cursor: string | null;
  has_more: boolean;
}

// ---------------------------------------------------------------------------
// property-value constructors
// ---------------------------------------------------------------------------

const MAX_TEXT = 2000; // Notion caps a single text content chunk at 2000 chars.

const truncate = (s: string): string => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);

export const title = (s: string): NotionProperty => ({
  title: s ? [{ type: 'text', text: { content: truncate(s) } }] : [],
});

export const richText = (s: string | null | undefined): NotionProperty => ({
  rich_text: s ? [{ type: 'text', text: { content: truncate(s) } }] : [],
});

export const select = (name: string | null | undefined): NotionProperty => ({
  select: name ? { name } : null,
});

export const numberProp = (n: number | null | undefined): NotionProperty => ({
  number: n == null ? null : n,
});

export const url = (u: string | null | undefined): NotionProperty => ({ url: u || null });

/** Build a Notion date property from unix epoch SECONDS (UTC). */
export const dateFromUnix = (sec: number | null | undefined): NotionProperty => ({
  date: sec == null ? null : { start: new Date(sec * 1000).toISOString() },
});

// ---------------------------------------------------------------------------
// readers for existing page property values (for diffing)
// ---------------------------------------------------------------------------

/** Extract a plain string from a title/rich_text property value, or '' . */
export function readText(prop: unknown): string {
  if (!prop || typeof prop !== 'object') return '';
  const p = prop as Record<string, unknown>;
  const arr = (p.title ?? p.rich_text) as Array<{ plain_text?: string }> | undefined;
  if (!Array.isArray(arr)) return '';
  return arr.map((r) => r.plain_text ?? '').join('');
}

export function readSelect(prop: unknown): string {
  if (!prop || typeof prop !== 'object') return '';
  const sel = (prop as { select?: { name?: string } | null }).select;
  return sel?.name ?? '';
}

export function readNumber(prop: unknown): number | null {
  if (!prop || typeof prop !== 'object') return null;
  const n = (prop as { number?: number | null }).number;
  return n == null ? null : n;
}

export function readUrl(prop: unknown): string {
  if (!prop || typeof prop !== 'object') return '';
  return (prop as { url?: string | null }).url ?? '';
}

/** Read a date property's `start` back as an ISO string ('' if unset). */
export function readDate(prop: unknown): string {
  if (!prop || typeof prop !== 'object') return '';
  const d = (prop as { date?: { start?: string } | null }).date;
  return d?.start ?? '';
}

// ---------------------------------------------------------------------------
// rate-limited client
// ---------------------------------------------------------------------------

export class NotionClient {
  private readonly token: string;
  private readonly version: string;
  private readonly minIntervalMs: number;
  /** Serializes all requests and spaces them by minIntervalMs (~3 req/s). */
  private gate: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(opts: { token: string; version: string; minIntervalMs: number }) {
    this.token = opts.token;
    this.version = opts.version;
    this.minIntervalMs = opts.minIntervalMs;
  }

  private async throttle(): Promise<void> {
    // Chain onto the gate so requests run strictly one-at-a-time, each spaced
    // at least minIntervalMs after the previous one started.
    const prev = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>((res) => (release = res));
    await prev;
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
    release();
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.throttle();
    // Up to 3 attempts honoring Retry-After on 429 / transient 5xx.
    let attempt = 0;
    for (;;) {
      const res = await fetch(`${NOTION_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Notion-Version': this.version,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) return (await res.json()) as T;

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < 2) {
        const retryAfter = Number(res.headers.get('Retry-After'));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : this.minIntervalMs * (attempt + 1);
        await new Promise((r) => setTimeout(r, backoff));
        attempt += 1;
        continue;
      }
      const text = await res.text().catch(() => '');
      throw new Error(`Notion ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    }
  }

  /** Page through every row of a database, optionally filtered. */
  async queryDatabaseAll(databaseId: string, filter?: unknown): Promise<NotionPage[]> {
    const out: NotionPage[] = [];
    let cursor: string | null = null;
    do {
      const body: Record<string, unknown> = { page_size: 100 };
      if (filter) body.filter = filter;
      if (cursor) body.start_cursor = cursor;
      const resp = await this.request<NotionQueryResponse>(
        'POST',
        `/databases/${databaseId}/query`,
        body
      );
      out.push(...resp.results);
      cursor = resp.has_more ? resp.next_cursor : null;
    } while (cursor);
    return out;
  }

  async createPage(databaseId: string, properties: NotionProperties): Promise<NotionPage> {
    return this.request<NotionPage>('POST', '/pages', {
      parent: { database_id: databaseId },
      properties,
    });
  }

  async updatePage(pageId: string, properties: NotionProperties): Promise<NotionPage> {
    return this.request<NotionPage>('PATCH', `/pages/${pageId}`, { properties });
  }
}
