export interface AuthenticatedImagePreview {
  objectUrl: string;
  warning: string | null;
  dispose(): void;
}

export interface AuthenticatedImagePreviewOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  urlImpl?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
}

export function createAuthenticatedImagePreview(
  src: string,
  options?: AuthenticatedImagePreviewOptions,
): Promise<AuthenticatedImagePreview>;
