/** HTTP methods Contexture accepts for an explicitly declared REST surface. */
export type RestMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** An explicit public HTTP route, never an arbitrary-ref dispatcher. */
export interface RestRoute {
  readonly method: RestMethod;
  readonly path: string;
  /** The canonical Contexture Tool reference this route may invoke. */
  readonly ref: string;
  /**
   * Successful Fetch-safe response status; defaults to 200.
   *
   * RestSurface serializes a JSON body, so it rejects 1xx, 204, 205, and 304
   * at construction rather than deferring a Fetch Response failure to a live request.
   */
  readonly status?: number;
}
