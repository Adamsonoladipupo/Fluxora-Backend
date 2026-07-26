/**
 * Cursor Pagination Helpers matching src/validation/paginationSchema.ts.
 */

import type { Stream, ListStreamsParams, StreamListResponse } from './types.js';

export class StreamPaginator {
  private fetchPage: (params: ListStreamsParams) => Promise<StreamListResponse>;
  private limit: number;
  private status?: string;
  private sender?: string;
  private recipient?: string;
  private includeTotal: boolean;
  private nextCursor: string | null = null;
  private hasMore = true;

  constructor(
    fetchPage: (params: ListStreamsParams) => Promise<StreamListResponse>,
    params: ListStreamsParams = {},
  ) {
    const limit = params.limit ?? 20;
    if (limit < 1 || limit > 100) {
      throw new Error('limit must be an integer between 1 and 100 per paginationSchema');
    }
    this.fetchPage = fetchPage;
    this.limit = limit;
    this.status = params.status;
    this.sender = params.sender;
    this.recipient = params.recipient;
    this.includeTotal = params.include_total ?? false;
  }

  /**
   * Fetch next page of results. Returns null when no more pages exist.
   */
  async nextPage(): Promise<Stream[] | null> {
    if (!this.hasMore) return null;

    const response = await this.fetchPage({
      limit: this.limit,
      cursor: this.nextCursor ?? undefined,
      status: this.status,
      sender: this.sender,
      recipient: this.recipient,
      include_total: this.includeTotal,
    });

    const items = response.data || [];
    const nextCursor = response.meta?.next_cursor;

    if (nextCursor) {
      this.nextCursor = nextCursor;
    } else {
      this.hasMore = false;
    }

    return items;
  }

  /**
   * Async generator yielding single items across all pages.
   */
  async *autoPaginate(): AsyncGenerator<Stream, void, unknown> {
    while (this.hasMore) {
      const page = await this.nextPage();
      if (!page) break;
      for (const item of page) {
        yield item;
      }
    }
  }
}
