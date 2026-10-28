/// <reference types="easy-jsx-html-engine/jsx-runtime" preserve="true" />

// Structural counterparts of engine 0.1.13's public types. Its declarations
// re-export extensionless relative specifiers, which NodeNext cannot resolve.
// Keeping the contracts here preserves contextual typing for package consumers.
export type Children = number | string | boolean | null | undefined | bigint | JSX.Element | PromiseLike<Children> | Children[];
export interface Component<P extends {} = Record<string, unknown>> {
  (props: P): Children;
}
export interface ErrorBoundaryProps {
  /** Include server stack traces in the default HTML catch. Defaults to false. */
  showStack?: boolean;
  children?: Children | [() => Children];
  catch?: ((error: any) => JSX.Element) | Children;
}
export interface SuspenseProps extends ErrorBoundaryProps {
  rid?: string | number;
  fallback?: Children;
  catch?: ((error: any) => JSX.Element) | JSX.Element;
}
export interface ResolvedTemplateProps {
  id: number;
  children?: Children;
}
