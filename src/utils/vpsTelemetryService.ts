import { SystemResourcesResponse } from '../types';

/**
 * Fetch real-time VPS telemetry (CPU, RAM, Disk, Optimal Worker Recommendation)
 */
export async function fetchSystemResources(): Promise<SystemResourcesResponse> {
  const res = await fetch('/api/system-resources', {
    headers: {
      Accept: 'application/json',
    },
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch system telemetry: ${res.statusText}`);
  }

  return (await res.json()) as SystemResourcesResponse;
}
