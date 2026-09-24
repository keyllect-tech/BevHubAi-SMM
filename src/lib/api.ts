import type {
  BrandKit,
  GenerationJob,
  Project,
  Subscription,
  Usage,
  User,
  Video,
  VideoAsset,
  VideoScript,
  Workspace,
} from '@/types';

const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

/** Dispatched when an authenticated request gets 401 (expired session). */
export const UNAUTHORIZED_EVENT = 'bevhub:unauthorized';

const SERVER_DOWN = 'Сервер BevHubAI недоступен. Запустите backend: npm run start-server';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function apiUrl(path: string) {
  return path.startsWith('/') ? `${BASE}${path}` : path;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  form?: FormData;
  timeoutMs?: number;
}

async function request<T>(path: string, { method = 'GET', body, form, timeoutMs = 30000 }: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method,
      credentials: 'include',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new ApiError(0, 'Сервер не ответил вовремя. Попробуйте ещё раз.');
    }
    throw new ApiError(0, SERVER_DOWN);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // No JSON body means the request never reached our API (e.g. dev proxy with backend stopped).
    if (!data) throw new ApiError(res.status, res.status >= 500 ? SERVER_DOWN : `Ошибка запроса (HTTP ${res.status})`);
    if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(res.status, data.error || `Ошибка запроса (HTTP ${res.status})`);
  }
  return data as T;
}

type AuthResponse = { user: User; workspace: Workspace };
type UsageResponse = { subscription: Subscription | null; usage: Usage };

export const api = {
  health: () => request<{ ok: boolean; ttsMode: string; maleVoiceLanguages: string[] }>('/api/health', { timeoutMs: 10000 }),
  me: () => request<{ user: User | null; workspace: Workspace | null }>('/api/auth/me'),
  login: (email: string, password: string) => request<AuthResponse>('/api/auth/login', { method: 'POST', body: { email, password } }),
  register: (name: string, email: string, password: string) =>
    request<AuthResponse>('/api/auth/register', { method: 'POST', body: { name, email, password } }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST', body: {} }),

  updateWorkspace: (name: string) => request<{ workspace: Workspace }>('/api/workspace', { method: 'PATCH', body: { name } }),
  dashboard: () => request<UsageResponse & { videos: Video[]; totalVideos: number; projectsCount: number }>('/api/dashboard'),
  billing: () => request<UsageResponse>('/api/billing'),
  changePlan: (plan: string) => request<UsageResponse>('/api/billing/plan', { method: 'POST', body: { plan } }),

  listProjects: () => request<{ projects: Project[] }>('/api/projects'),
  createProject: (name: string, description: string) =>
    request<{ project: Project }>('/api/projects', { method: 'POST', body: { name, description } }),
  updateProject: (id: string, name: string, description: string) =>
    request<{ project: Project }>(`/api/projects/${id}`, { method: 'PATCH', body: { name, description } }),
  deleteProject: (id: string) => request<{ ok: true }>(`/api/projects/${id}`, { method: 'DELETE' }),
  getBrandKit: (projectId: string) => request<{ brandKit: BrandKit | null }>(`/api/projects/${projectId}/brand-kit`),
  saveBrandKit: (projectId: string, kit: Omit<BrandKit, 'id' | 'project_id' | 'created_at'>) =>
    request<{ brandKit: BrandKit }>(`/api/projects/${projectId}/brand-kit`, { method: 'PUT', body: kit }),

  uploadImage: (file: File) => {
    const form = new FormData();
    form.append('image', file, file.name);
    return request<{ file: { id: string; url: string; name: string; mime_type: string; size: number } }>('/api/files', {
      method: 'POST',
      form,
      timeoutMs: 60000,
    });
  },

  generateScript: (input: { productName: string; description: string; cta: string; language: string; style: string }) =>
    request<{ script: VideoScript; source: 'openai' | 'fallback' }>('/api/scripts', { method: 'POST', body: input }),

  listVideos: () => request<{ videos: Video[] }>('/api/videos'),
  createVideo: (input: {
    clientRequestId: string;
    projectId: string | null;
    productName: string;
    description: string;
    price: string;
    cta: string;
    websiteUrl: string;
    language: string;
    voiceType: string;
    style: string;
    fileIds: string[];
    script: VideoScript | null;
    scriptSource: string | null;
  }) => request<{ video: Video; deduplicated?: boolean }>('/api/videos', { method: 'POST', body: input }),
  getVideo: (id: string) => request<{ video: Video; assets: VideoAsset[]; job: GenerationJob | null }>(`/api/videos/${encodeURIComponent(id)}`, { timeoutMs: 15000 }),
  retryVideo: (id: string) => request<{ video: Video }>(`/api/videos/${encodeURIComponent(id)}/retry`, { method: 'POST', body: {} }),
  videoDownloadUrl: (id: string) => apiUrl(`/api/videos/${encodeURIComponent(id)}/file?download=1`),
};
