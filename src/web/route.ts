/** HTTP methods Contexture accepts for an explicitly declared REST surface. */
export type RestMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** An explicit public HTTP route, never an arbitrary-ref dispatcher. */
export interface RestRoute {
  readonly method: RestMethod;
  readonly path: string;
  /** The canonical Contexture Tool reference this route may invoke. */
  readonly ref: string;
  /** Successful response status; defaults to 200. */
  readonly status?: number;
}
