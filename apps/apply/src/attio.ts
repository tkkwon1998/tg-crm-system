/**
 * Minimal Attio REST client for the apply Worker.
 *
 * Only the two operations the apply flow needs (spec §5.4):
 *   - assertRecord  -> PUT /v2/objects/{object}/records?matching_attribute={slug}
 *                      (idempotent upsert deduped on a matching attribute)
 *   - createNote    -> POST /v2/notes
 *                      (provenance trail citing source chat_id:message_id list)
 *
 * Auth is a bearer token (the ATTIO_TOKEN secret). All calls throw AttioError
 * on a non-2xx response so the caller can persist the message via markStatus().
 */

import type { AttioObject } from '@crm/db';

export class AttioError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'AttioError';
    this.status = status;
    this.body = body;
  }
}

export interface AttioRecord {
  id: {
    workspace_id: string;
    object_id: string;
    record_id: string;
  };
  values: Record<string, unknown>;
}

export class AttioClient {
  private readonly token: string;
  private readonly base: string;

  constructor(token: string, base = 'https://api.attio.com') {
    if (!token) throw new Error('AttioClient: missing ATTIO_TOKEN');
    this.token = token;
    // strip any trailing slash so path concatenation is clean
    this.base = base.replace(/\/+$/, '');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new AttioError(
        `Attio ${method} ${path} -> ${res.status} ${res.statusText}`,
        res.status,
        text.slice(0, 2000)
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /**
   * Assert (upsert) a record on `object`, deduped on `matchingAttribute`.
   * Attio matches an existing record by the matching attribute's value inside
   * `values`; if found it is updated, otherwise a new record is created.
   *
   * `values` is the attribute_slug -> value map exactly as stored in a
   * proposal's proposed_changes. Attio accepts shorthand scalar values for
   * the standard attributes we allowlist (email, phone, title).
   */
  async assertRecord(
    object: AttioObject,
    matchingAttribute: string,
    values: Record<string, unknown>
  ): Promise<AttioRecord> {
    const q = encodeURIComponent(matchingAttribute);
    const out = await this.request<{ data: AttioRecord }>(
      'PUT',
      `/v2/objects/${encodeURIComponent(object)}/records?matching_attribute=${q}`,
      { data: { values } }
    );
    return out.data;
  }

  /** Fetch a single record by id (used to read-merge-write reference attributes). */
  async getRecord(object: AttioObject, recordId: string): Promise<AttioRecord> {
    const out = await this.request<{ data: AttioRecord }>(
      'GET',
      `/v2/objects/${encodeURIComponent(object)}/records/${encodeURIComponent(recordId)}`
    );
    return out.data;
  }

  /**
   * Update specific attributes on an existing record by id (PATCH replaces the
   * given attribute values; attributes not listed are untouched). Used for deal
   * field writes and for setting the associated-people reference attribute.
   */
  async patchRecord(
    object: AttioObject,
    recordId: string,
    values: Record<string, unknown>
  ): Promise<AttioRecord> {
    const out = await this.request<{ data: AttioRecord }>(
      'PATCH',
      `/v2/objects/${encodeURIComponent(object)}/records/${encodeURIComponent(recordId)}`,
      { data: { values } }
    );
    return out.data;
  }

  /** Create a markdown note attached to a record (provenance). */
  async createNote(args: {
    parentObject: AttioObject;
    parentRecordId: string;
    title: string;
    content: string;
  }): Promise<{ id: { note_id: string } }> {
    const out = await this.request<{ data: { id: { note_id: string } } }>(
      'POST',
      `/v2/notes`,
      {
        data: {
          parent_object: args.parentObject,
          parent_record_id: args.parentRecordId,
          title: args.title,
          format: 'markdown',
          content: args.content,
        },
      }
    );
    return out.data;
  }
}
