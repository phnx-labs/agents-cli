/** Isolated Cloudflare resources for the private Phoenix trace store. */
export interface TracesConfig {
  baseUrl: string;
  accountId: string;
  workerName: string;
  bucketName: string;
  domain?: string;
}

export const DEFAULT_WORKER_NAME = 'agents-traces';
export const DEFAULT_BUCKET_NAME = 'agents-traces';
