/** HTTP methods Contexture accepts for an explicitly declared REST surface. */
export type RestMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** An explicit public HTTP route, never an arbitrary-ref dispatcher. */
export interface RestRoute {
  readonly method: RestMethod;
  readonly path: string;
  readonly ref: string;
}
